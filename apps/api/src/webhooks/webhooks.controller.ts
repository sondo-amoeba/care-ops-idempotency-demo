import { Body, Controller, Inject, Post } from "@nestjs/common";
import { IsIn, IsString, IsUUID } from "class-validator";
import { SmsService } from "../sms/sms.service";
import { SupervisorService } from "../supervisor/supervisor.service";

class InboundWebhookDto {
  @IsString()
  MessageSid!: string;

  @IsString()
  Body!: string;

  @IsUUID()
  interactionId!: string;
}

class StatusCallbackDto {
  @IsString()
  MessageSid!: string;

  @IsIn(["queued", "sent", "delivered", "failed"])
  MessageStatus!: "queued" | "sent" | "delivered" | "failed";
}

@Controller("webhooks/twilio")
export class WebhooksController {
  constructor(
    @Inject(SmsService) private readonly sms: SmsService,
    @Inject(SupervisorService) private readonly supervisor: SupervisorService,
  ) {}

  @Post("inbound")
  async inbound(@Body() dto: InboundWebhookDto) {
    const persisted = await this.sms.handleInbound(dto);
    if (persisted.duplicate) {
      return persisted;
    }
    const routing = await this.supervisor.handleInbound(
      dto.interactionId,
      dto.Body,
    );
    return { ...persisted, ...routing };
  }

  @Post("status")
  status(@Body() dto: StatusCallbackDto) {
    return this.sms.handleStatusCallback(dto);
  }
}
