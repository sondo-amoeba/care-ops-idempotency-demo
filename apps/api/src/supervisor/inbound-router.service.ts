import { Inject, Injectable } from "@nestjs/common";
import { EligibilityService } from "../eligibility/eligibility.service";
import { InteractionService } from "../interactions/interaction.service";
import { CoordinatorService } from "../coordinator/coordinator.service";
import { PatientIntent } from "../coordinator/patient-intent";

@Injectable()
export class InboundRouterService {
  constructor(
    @Inject(InteractionService) private readonly interactions: InteractionService,
    @Inject(EligibilityService) private readonly eligibility: EligibilityService,
    @Inject(CoordinatorService) private readonly coordinator: CoordinatorService,
  ) {}

  async route(interactionId: string, body: string) {
    const intent = this.classifyMock(body);

    switch (intent) {
      case "CONFIRM": {
        const detail = await this.interactions.getThreadDetail(interactionId);
        let confirmed = false;
        const scheduling = await this.eligibility.canContact(
          detail.interaction.patientId,
          detail.interaction.programId,
          "sms",
          "scheduling",
        );
        if (scheduling.allowed) {
          await this.interactions.confirmFromInbound(interactionId);
          confirmed = true;
        }
        return { intent, confirmed };
      }
      case "OPT_OUT":
        return { intent, confirmed: false, terminal: true };
      case "RESCHEDULE":
      case "UNKNOWN": {
        const coordinatorRun = await this.coordinator.startRun({
          interactionId,
          signal: "inbound",
          patientIntent: intent,
        });
        return { intent, confirmed: false, coordinatorRun };
      }
    }
  }

  classifyMock(body: string): PatientIntent {
    const normalized = body.trim().toLowerCase();
    if (/^yes\b/.test(normalized) || normalized === "confirm") {
      return "CONFIRM";
    }
    if (/reschedule|thursday|move/.test(normalized)) {
      return "RESCHEDULE";
    }
    if (/^(stop|unsubscribe)\b/.test(normalized)) {
      return "OPT_OUT";
    }
    return "UNKNOWN";
  }
}
