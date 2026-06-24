import { StartCoordinatorRunInput } from "./coordinator.types";
import { RetrievedCareContextChunk } from "../rag/care-context.service";
import { InteractionService } from "../interactions/interaction.service";

export interface CoordinatorProposalDraft {
  templateId: string;
  body: string;
  rationale: string;
}

export type CoordinatorPlanContext = {
  detail: Awaited<ReturnType<InteractionService["getThreadDetail"]>>;
  contextChunks: RetrievedCareContextChunk[];
  input: StartCoordinatorRunInput;
};
