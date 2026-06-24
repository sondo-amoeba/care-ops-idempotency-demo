import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Response } from "express";
import { Repository } from "typeorm";
import {
  CoordinatorProposal,
  CoordinatorRun,
  CoordinatorSignalType,
  CoordinatorTraceEvent,
} from "../entities";
import { CoordinatorRunExecutor } from "./coordinator-run.executor";
import { OutboundCoordinatorGraphRunner } from "./outbound-coordinator-graph.runner";
import { StartCoordinatorRunInput } from "./coordinator.types";
import {
  formatSseTracePayload,
  mapTraceToSseEventType,
  writeSseEvent,
} from "./coordinator-trace.stream";

export type { StartCoordinatorRunInput };

@Injectable()
export class CoordinatorService {
  constructor(
    @InjectRepository(CoordinatorRun)
    private readonly runRepo: Repository<CoordinatorRun>,
    @InjectRepository(CoordinatorProposal)
    private readonly proposalRepo: Repository<CoordinatorProposal>,
    @InjectRepository(CoordinatorTraceEvent)
    private readonly traceRepo: Repository<CoordinatorTraceEvent>,
    @Inject(CoordinatorRunExecutor) private readonly executor: CoordinatorRunExecutor,
    @Inject(OutboundCoordinatorGraphRunner)
    private readonly graphRunner: OutboundCoordinatorGraphRunner,
  ) {}

  async startRun(input: StartCoordinatorRunInput) {
    const pending = await this.executor.findPendingRun(input.interactionId);
    if (pending) {
      return {
        ...pending.run,
        proposal: pending.proposal,
        resumed: true,
        graphEngine: "langgraph",
      };
    }

    const result = await this.graphRunner.runUntilInterrupt(
      input,
      input.interactionId,
    );
    return this.toRunResponse(result);
  }

  async getRun(runId: string) {
    const run = await this.runRepo.findOne({ where: { id: runId } });
    if (!run) {
      throw new NotFoundException("coordinator_run_not_found");
    }
    const proposal = await this.proposalRepo.findOne({
      where: { runId, status: "pending" },
    });
    const checkpointReady =
      run.status === "awaiting_approval" &&
      (await this.graphRunner.hasCheckpoint(runId));
    return {
      ...run,
      proposal: proposal ?? null,
      graphEngine: "langgraph",
      checkpointReady,
    };
  }

  async getTrace(runId: string) {
    const run = await this.runRepo.findOne({ where: { id: runId } });
    if (!run) {
      throw new NotFoundException("coordinator_run_not_found");
    }
    const events = await this.traceRepo.find({
      where: { runId },
      order: { createdAt: "ASC" },
    });
    return { runId, events };
  }

  async streamTrace(runId: string, res: Response) {
    const run = await this.runRepo.findOne({ where: { id: runId } });
    if (!run) {
      throw new NotFoundException("coordinator_run_not_found");
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const write = (chunk: string) => {
      res.write(chunk);
    };

    const events = await this.traceRepo.find({
      where: { runId },
      order: { createdAt: "ASC" },
    });

    for (const event of events) {
      writeSseEvent(
        write,
        mapTraceToSseEventType(event),
        formatSseTracePayload(event),
      );
    }

    res.end();
  }

  async approveRun(runId: string, options: { windowStart?: string } = {}) {
    const run = await this.runRepo.findOne({ where: { id: runId } });
    if (!run) {
      throw new NotFoundException("coordinator_run_not_found");
    }
    if (run.status !== "awaiting_approval") {
      throw new BadRequestException("coordinator_run_not_awaiting_approval");
    }

    const result = await this.graphRunner.resumeApprove(runId, options.windowStart);
    return {
      ...this.toRunResponse(result),
      sendResult: result.sendResult,
    };
  }

  async rejectRun(runId: string) {
    const run = await this.runRepo.findOne({ where: { id: runId } });
    if (!run) {
      throw new NotFoundException("coordinator_run_not_found");
    }
    if (run.status !== "awaiting_approval") {
      throw new BadRequestException("coordinator_run_not_awaiting_approval");
    }

    const result = await this.graphRunner.resumeReject(runId);
    return this.toRunResponse(result);
  }

  private toRunResponse(state: {
    runId: string;
    interactionId: string;
    status: CoordinatorRun["status"];
    modelMode: CoordinatorRun["modelMode"];
    proposal: CoordinatorProposal | null;
    ineligibleReason: string | null;
    input: StartCoordinatorRunInput;
  }) {
    return {
      id: state.runId,
      interactionId: state.interactionId,
      status: state.status,
      modelMode: state.modelMode,
      signalType: state.input.signal,
      proposal: state.proposal,
      ineligibleReason: state.ineligibleReason,
      graphEngine: "langgraph" as const,
    };
  }
}
