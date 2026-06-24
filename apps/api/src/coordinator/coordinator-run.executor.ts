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
import { CoordinatorProposalDraft } from "./coordinator-proposal.types";
import { GeminiCoordinatorPlanner } from "./gemini-coordinator.planner";
import { buildMockPlan } from "./mock-coordinator.planner";
import { StartCoordinatorRunInput } from "./coordinator.types";

export interface CoordinatorGraphState {
  runId: string;
  interactionId: string;
  input: StartCoordinatorRunInput;
  status: CoordinatorRun["status"];
  modelMode: CoordinatorRun["modelMode"];
  proposal: CoordinatorProposal | null;
  proposalDraft: CoordinatorProposalDraft | null;
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
    @Inject(GeminiCoordinatorPlanner)
    private readonly geminiPlanner: GeminiCoordinatorPlanner,
  ) {}

  resolveModelMode(): CoordinatorRun["modelMode"] {
    if (process.env.COORDINATOR_MODEL_MODE === "mock") return "mock";
    if (process.env.GEMINI_API_KEY?.trim()) return "live";
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
    return {
      ...state,
      runId: run.id,
      status: run.status,
      proposalDraft: null,
    };
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
        proposalDraft: null,
      };
    }
    return state;
  }

  async plan(state: CoordinatorGraphState): Promise<CoordinatorGraphState> {
    await this.appendTrace(state.runId, "phase", "plan");

    const detail = await this.interactions.getThreadDetail(state.interactionId);
    const retrievalQuery = this.buildRetrievalQuery(detail, state.input);
    const contextChunks = await this.careContext.retrieveCareContext(
      retrievalQuery,
      detail.interaction.programId,
    );
    const planContext = { detail, contextChunks, input: state.input };

    if (this.usesGeminiPlanning(state) && this.geminiPlanner.isConfigured()) {
      try {
        const { draft, model } = await this.geminiPlanner.plan(planContext);
        await this.appendTrace(state.runId, "tool", "gemini_plan", {
          templateId: draft.templateId,
          provider: "gemini",
          model,
        });
        return { ...state, proposalDraft: draft, modelMode: "live" };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.appendTrace(state.runId, "tool", "gemini_plan", {
          liveAttempted: true,
          error: message.length > 500 ? `${message.slice(0, 500)}…` : message,
          fallback: "mock",
        });
        await this.runRepo.update(state.runId, { modelMode: "mock" });
        return {
          ...state,
          proposalDraft: buildMockPlan(planContext),
          modelMode: "mock",
        };
      }
    }

    const draft = buildMockPlan(planContext);
    return { ...state, proposalDraft: draft };
  }

  async propose(state: CoordinatorGraphState): Promise<CoordinatorGraphState> {
    if (!state.proposalDraft) {
      throw new Error("Coordinator plan phase did not produce a proposal draft");
    }

    await this.appendTrace(state.runId, "phase", "propose");
    const proposal = await this.proposalRepo.save(
      this.proposalRepo.create({
        runId: state.runId,
        interactionId: state.interactionId,
        templateId: state.proposalDraft.templateId,
        body: state.proposalDraft.body,
        rationale: state.proposalDraft.rationale,
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

  private usesGeminiPlanning(state: CoordinatorGraphState): boolean {
    return state.input.signal !== "inbound";
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
}
