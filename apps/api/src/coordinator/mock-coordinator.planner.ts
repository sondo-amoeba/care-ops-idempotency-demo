import { InteractionService } from "../interactions/interaction.service";
import { CoordinatorPlanContext, CoordinatorProposalDraft } from "./coordinator-proposal.types";
import { StartCoordinatorRunInput } from "./coordinator.types";

export function buildDeterministicInboundProposal(
  input: StartCoordinatorRunInput,
): CoordinatorProposalDraft {
  if (input.patientIntent === "RESCHEDULE") {
    return {
      templateId: "reschedule-offer",
      body: "A care coordinator will follow up with new appointment times.",
      rationale:
        "Patient requested reschedule; inbound router requires HITL before outbound send.",
    };
  }
  return {
    templateId: "needs-review",
    body: "Your care team will review your message and respond shortly.",
    rationale: "Inbound intent unclear; inbound router escalates to human review.",
  };
}

export function buildMockProposal(
  detail: Awaited<ReturnType<InteractionService["getThreadDetail"]>>,
): CoordinatorProposalDraft {
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

export function buildMockPlan(context: CoordinatorPlanContext): CoordinatorProposalDraft {
  if (context.input.signal === "inbound") {
    return buildDeterministicInboundProposal(context.input);
  }
  return buildMockProposal(context.detail);
}
