import { Inject, Injectable } from "@nestjs/common";
import {
  CoordinatorService,
  StartCoordinatorRunInput,
} from "../coordinator/coordinator.service";
import { InboundRouterService } from "./inbound-router.service";

@Injectable()
export class SupervisorService {
  constructor(
    @Inject(InboundRouterService) private readonly inboundRouter: InboundRouterService,
    @Inject(CoordinatorService) private readonly coordinator: CoordinatorService,
  ) {}

  startOutboundCoordinator(input: StartCoordinatorRunInput) {
    return this.coordinator.startRun(input);
  }

  handleInbound(interactionId: string, body: string) {
    return this.inboundRouter.route(interactionId, body);
  }
}
