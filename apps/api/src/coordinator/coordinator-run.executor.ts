import { Inject, Injectable } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import {
  CoordinatorProposal,
  CoordinatorRun,
  CoordinatorTraceEvent,
  CoordinatorTraceEventType,
} from "../entities";
import { EligibilityService } from "../eligibility/eligibility.service";
import { InteractionService } from "../interactions/interaction.service";
import { CareContextService } from "../rag/care-context.service";
import { SmsService } from "../sms/sms.service";
import { PatientIntent } from "./patient-intent";
import { StartCoordinatorRunInput } from "./coordinator.types";

export interface CoordinatorGraphState {
  runId: string;
  interactionId: string;
  input: StartCoordinatorRunInput;
  status: CoordinatorRun["status"];
  modelMode: CoordinatorRun["modelMode"];
  proposal: CoordinatorProposal | null;
  ineligibleReason: string | null;
  windowStart?: string;
  sendResult?: Awaited<ReturnType<SmsService["sendOutbound"]>>;
}

@Injectable()
export class CoordinatorRunExecutor {
  constructor(
    @InjectRepository(CoordinatorRun)
    private readonly runRepo: Repository<CoordinatorRun>,
    @InjectRepository(CoordinatorProposal)
    private readonly proposalRepo: Repository<CoordinatorProposal>,
    @InjectRepository(CoordinatorTraceEvent)
    private readonly traceRepo: Repository<CoordinatorTraceEvent>,
    @Inject(InteractionService) private readonly interactions: InteractionService,
    @Inject(EligibilityService) private readonly eligibility: EligibilityService,
    @Inject(CareContextService) private readonly careContext: CareContextService,
    @Inject(SmsService) private readonly sms: SmsService,
  ) {}

  resolveModelMode(): CoordinatorRun["modelMode"] {
    if (process.env.COORDINATOR_MODEL_MODE === "mock") return "mock";
    if (process.env.OPENAI_API_KEY) return "live";
    return "mock";
  }

  async createRun(state: CoordinatorGraphState): Promise<CoordinatorGraphState> {
    const run = await this.runRepo.save(
      this.runRepo.create({
        id: state.runId,
        interactionId: state.interactionId,
        status: "running",
        modelMode: state.modelMode,
        signalType: state.input.signal,
      }),
    );
    return { ...state, runId: run.id, status: run.status };
  }

  async observe(state: CoordinatorGraphState): Promise<CoordinatorGraphState> {
    await this.appendTrace(state.runId, "phase", "observe");
    const detail = await this.interactions.getThreadDetail(state.interactionId);
    const retrievalQuery = this.buildRetrievalQuery(detail, state.input);
    const contextChunks = await this.careContext.retrieveCareContext(
      retrievalQuery,
      detail.interaction.programId,
    );
    await this.appendTrace(state.runId, "tool", "retrieve_care_context", {
      policyKeys: contextChunks.map((chunk) => chunk.policyKey),
      chunkIds: contextChunks.map((chunk) => chunk.id),
    });
    return state;
  }

  async checkEligibility(state: CoordinatorGraphState): Promise<CoordinatorGraphState> {
    const detail = await this.interactions.getThreadDetail(state.interactionId);
    const outboundEligibility = await this.eligibility.canContact(
      detail.interaction.patientId,
      detail.interaction.programId,
      "sms",
      "outbound",
    );
    await this.appendTrace(state.runId, "tool", "check_eligibility", {
      allowed: outboundEligibility.allowed,
      reason: outboundEligibility.reason,
    });
    if (!outboundEligibility.allowed) {
      await this.runRepo.update(state.runId, { status: "ineligible" });
      await this.appendTrace(state.runId, "phase", "ineligible");
      return {
        ...state,
        status: "ineligible",
        ineligibleReason: outboundEligibility.reason ?? "not_eligible",
        proposal: null,
      };
    }
    return state;
  }

  async plan(state: CoordinatorGraphState): Promise<CoordinatorGraphState> {
    await this.appendTrace(state.runId, "phase", "plan");
    return state;
  }

  async propose(state: CoordinatorGraphState): Promise<CoordinatorGraphState> {
    const detail = await this.interactions.getThreadDetail(state.interactionId);
    const proposalDraft = this.planProposal(detail, state.input);
    await this.appendTrace(state.runId, "phase", "propose");
    const proposal = await this.proposalRepo.save(
      this.proposalRepo.create({
        runId: state.runId,
        interactionId: state.interactionId,
        templateId: proposalDraft.templateId,
        body: proposalDraft.body,
        rationale: proposalDraft.rationale,
        status: "pending",
      }),
    );
    await this.runRepo.update(state.runId, { status: "awaiting_approval" });
    await this.appendTrace(state.runId, "interrupt", "await_approval");
    return {
      ...state,
      status: "awaiting_approval",
      proposal,
    };
  }

  async execute(state: CoordinatorGraphState): Promise<CoordinatorGraphState> {
    const proposal = await this.proposalRepo.findOne({
      where: { runId: state.runId, status: "pending" },
    });
    if (!proposal) {
      return state;
    }
    const detail = await this.interactions.getThreadDetail(state.interactionId);
    await this.appendTrace(state.runId, "phase", "execute");
    const sendResult = await this.sms.sendOutbound({
      interactionId: state.interactionId,
      patientId: detail.interaction.patientId,
      programId: detail.interaction.programId,
      templateId: proposal.templateId,
      body: proposal.body,
      source: "ai_coordinator",
      windowStart: state.windowStart,
    });
    await this.appendTrace(state.runId, "tool", "send_outbound_sms", {
      duplicate: sendResult.duplicate,
      idempotencyKey: sendResult.idempotencyKey,
    });
    proposal.status = "approved";
    await this.proposalRepo.save(proposal);
    return { ...state, proposal, sendResult };
  }

  async audit(state: CoordinatorGraphState): Promise<CoordinatorGraphState> {
    await this.runRepo.update(state.runId, { status: "completed" });
    await this.appendTrace(state.runId, "phase", "audit", {
      duplicate: state.sendResult?.duplicate ?? false,
    });
    await this.appendTrace(state.runId, "complete", "complete");
    return { ...state, status: "completed" };
  }

  async reject(state: CoordinatorGraphState): Promise<CoordinatorGraphState> {
    const proposal = await this.proposalRepo.findOne({
      where: { runId: state.runId, status: "pending" },
    });
    if (!proposal) {
      return state;
    }
    proposal.status = "rejected";
    await this.proposalRepo.save(proposal);
    await this.runRepo.update(state.runId, { status: "rejected" });
    await this.appendTrace(state.runId, "phase", "reject");
    await this.appendTrace(state.runId, "complete", "complete");
    return { ...state, status: "rejected", proposal };
  }

  async findPendingRun(interactionId: string) {
    const proposal = await this.proposalRepo.findOne({
      where: { interactionId, status: "pending" },
      order: { createdAt: "DESC" },
    });
    if (!proposal) return null;
    const run = await this.runRepo.findOne({ where: { id: proposal.runId } });
    if (!run || run.status !== "awaiting_approval") return null;
    return { run, proposal };
  }

  private async appendTrace(
    runId: string,
    eventType: CoordinatorTraceEventType,
    name: string,
    detail?: Record<string, unknown>,
  ) {
    await this.traceRepo.save(
      this.traceRepo.create({ runId, eventType, name, detail }),
    );
  }

  private buildRetrievalQuery(
    detail: Awaited<ReturnType<InteractionService["getThreadDetail"]>>,
    input: StartCoordinatorRunInput,
  ) {
    void detail;
    if (input.signal === "inbound" && input.patientIntent === "RESCHEDULE") {
      return "patient reschedule request HITL policy";
    }
    if (input.signal === "inbound" && input.patientIntent === "UNKNOWN") {
      return "unclear inbound patient message human review";
    }
    return "post-visit appointment confirmation outbound SMS policy";
  }

  private planProposal(
    detail: Awaited<ReturnType<InteractionService["getThreadDetail"]>>,
    input: StartCoordinatorRunInput,
  ) {
    if (input.signal === "inbound" && input.patientIntent === "RESCHEDULE") {
      return {
        templateId: "reschedule-offer",
        body: "A care coordinator will follow up with new appointment times.",
        rationale:
          "Patient requested reschedule; mock router requires HITL before outbound send.",
      };
    }
    if (input.signal === "inbound" && input.patientIntent === "UNKNOWN") {
      return {
        templateId: "needs-review",
        body: "Your care team will review your message and respond shortly.",
        rationale: "Inbound intent unclear; mock router escalates to human review.",
      };
    }
    return this.planWithMockModel(detail);
  }

  private planWithMockModel(detail: Awaited<ReturnType<InteractionService["getThreadDetail"]>>) {
    const voiceCompleted = detail.voiceSession?.status === "completed";
    const bookingPending = detail.booking?.status === "pending";
    if (voiceCompleted && bookingPending) {
      return {
        templateId: "appointment-confirmation",
        body: "Please reply YES to confirm your upcoming visit.",
        rationale:
          "Voice visit completed with pending booking; mock model proposes confirmation SMS.",
      };
    }
    if (bookingPending) {
      return {
        templateId: "appointment-confirmation",
        body: "Please reply YES to confirm your upcoming visit.",
        rationale:
          "Booking is pending after care episode; mock model proposes confirmation SMS.",
      };
    }
    return {
      templateId: "follow-up",
      body: "Your care team will follow up with next steps.",
      rationale: "No pending booking action; mock model proposes generic follow-up.",
    };
  }
}
