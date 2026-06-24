import { Inject, Injectable, OnModuleInit } from "@nestjs/common";
import { Annotation, Command, END, START, StateGraph } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { randomUUID } from "crypto";
import {
  CoordinatorGraphState,
  CoordinatorRunExecutor,
} from "./coordinator-run.executor";
import { buildPostgresConnectionString } from "./postgres-connection";
import { StartCoordinatorRunInput } from "./coordinator.types";

const GraphState = Annotation.Root({
  runId: Annotation<string>,
  interactionId: Annotation<string>,
  input: Annotation<StartCoordinatorRunInput>,
  status: Annotation<CoordinatorGraphState["status"]>,
  modelMode: Annotation<CoordinatorGraphState["modelMode"]>,
  proposal: Annotation<CoordinatorGraphState["proposal"]>,
  ineligibleReason: Annotation<CoordinatorGraphState["ineligibleReason"]>,
  windowStart: Annotation<string | undefined>,
  sendResult: Annotation<CoordinatorGraphState["sendResult"]>,
});

@Injectable()
export class OutboundCoordinatorGraphRunner implements OnModuleInit {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private graph!: any;
  private checkpointer!: PostgresSaver;

  constructor(
    @Inject(CoordinatorRunExecutor)
    private readonly executor: CoordinatorRunExecutor,
  ) {}

  async onModuleInit() {
    this.checkpointer = PostgresSaver.fromConnString(buildPostgresConnectionString());
    await this.checkpointer.setup();
    this.graph = this.buildGraph();
  }

  async runUntilInterrupt(input: StartCoordinatorRunInput, interactionId: string) {
    const runId = randomUUID();
    const initialState: CoordinatorGraphState = {
      runId,
      interactionId,
      input,
      status: "running",
      modelMode: this.executor.resolveModelMode(),
      proposal: null,
      ineligibleReason: null,
    };

    const created = await this.executor.createRun(initialState);
    const result = await this.graph.invoke(created, {
      configurable: { thread_id: runId },
    });
    return result as CoordinatorGraphState;
  }

  async resumeApprove(runId: string, windowStart?: string) {
    const current = await this.graph.getState({
      configurable: { thread_id: runId },
    });
    const merged = {
      ...(current.values as CoordinatorGraphState),
      windowStart,
    };
    const result = await this.graph.invoke(new Command({ resume: merged }), {
      configurable: { thread_id: runId },
    });
    return result as CoordinatorGraphState;
  }

  async resumeReject(runId: string) {
    const current = await this.graph.getState({
      configurable: { thread_id: runId },
    });
    const state = current.values as CoordinatorGraphState;
    return this.executor.reject(state);
  }

  async hasCheckpoint(threadId: string): Promise<boolean> {
    const checkpoint = await this.checkpointer.get({
      configurable: { thread_id: threadId },
    });
    return checkpoint != null;
  }

  private buildGraph() {
    const executor = this.executor;

    const graph = new StateGraph(GraphState)
      .addNode("observe", async (state) => executor.observe(state))
      .addNode("check_eligibility", async (state) => executor.checkEligibility(state))
      .addNode("plan", async (state) => executor.plan(state))
      .addNode("propose", async (state) => executor.propose(state))
      .addNode("await_approval", async (state) => state)
      .addNode("execute", async (state) => executor.execute(state))
      .addNode("audit", async (state) => executor.audit(state))
      .addNode("ineligible", async (state) => state)
      .addNode("reject", async (state) => executor.reject(state))
      .addEdge(START, "observe")
      .addEdge("observe", "check_eligibility")
      .addConditionalEdges("check_eligibility", (state) =>
        state.status === "ineligible" ? "ineligible" : "plan",
      )
      .addEdge("plan", "propose")
      .addEdge("propose", "await_approval")
      .addEdge("await_approval", "execute")
      .addEdge("execute", "audit")
      .addEdge("audit", END)
      .addEdge("ineligible", END)
      .addEdge("reject", END);

    return graph.compile({
      checkpointer: this.checkpointer,
      interruptBefore: ["execute"],
    });
  }
}
