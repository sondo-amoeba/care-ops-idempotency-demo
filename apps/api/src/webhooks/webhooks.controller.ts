import { Body, Controller, Inject, Post } from "@nestjs/common";
import { IsIn, IsString, IsUUID } from "class-validator";
import { SmsService } from "../sms/sms.service";

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
  constructor(@Inject(SmsService) private readonly sms: SmsService) {}

  @Post("inbound")
  inbound(@Body() dto: InboundWebhookDto) {
    return this.sms.handleInbound(dto);
  }

  @Post("status")
  status(@Body() dto: StatusCallbackDto) {
    return this.sms.handleStatusCallback(dto);
  }
}
