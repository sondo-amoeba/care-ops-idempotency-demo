import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import {
  buildIdempotencyKey,
  fakeTwilioSid,
  hourWindowStart,
} from "../common/idempotency.util";
import { EligibilityService } from "../eligibility/eligibility.service";
import { SmsMessage, SmsOutbox } from "../entities";
import { RedisService } from "../redis/redis.service";

export interface SendSmsInput {
  interactionId: string;
  patientId: string;
  programId: string;
  templateId: string;
  body: string;
  source: "care_agent" | "agent_workflow";
  windowStart?: string;
}

@Injectable()
export class SmsService {
  constructor(
    @InjectRepository(SmsMessage)
    private readonly messageRepo: Repository<SmsMessage>,
    @InjectRepository(SmsOutbox)
    private readonly outboxRepo: Repository<SmsOutbox>,
    @Inject(EligibilityService) private readonly eligibility: EligibilityService,
    @Inject(RedisService) private readonly redis: RedisService,
  ) {}

  async handleInbound(payload: {
    MessageSid: string;
    Body: string;
    interactionId: string;
  }) {
    const existing = await this.messageRepo.findOne({
      where: { twilioMessageSid: payload.MessageSid },
    });
    if (existing) {
      existing.body = payload.Body;
      existing.status = "received";
      await this.messageRepo.save(existing);
      return { message: existing, duplicate: true };
    }
    const message = await this.messageRepo.save(
      this.messageRepo.create({
        interactionId: payload.interactionId,
        twilioMessageSid: payload.MessageSid,
        direction: "inbound",
        body: payload.Body,
        status: "received",
        source: "patient",
      }),
    );
    return { message, duplicate: false };
  }

  async handleStatusCallback(payload: {
    MessageSid: string;
    MessageStatus: "queued" | "sent" | "delivered" | "failed";
  }) {
    const message = await this.messageRepo.findOne({
      where: { twilioMessageSid: payload.MessageSid },
    });
    if (!message) {
      return { updated: false, reason: "message_not_found" };
    }
    message.status = payload.MessageStatus;
    await this.messageRepo.save(message);
    return { updated: true, message };
  }

  async sendOutbound(input: SendSmsInput) {
    const eligibility = await this.eligibility.canContact(
      input.patientId,
      input.programId,
      "sms",
      "outbound",
    );
    if (!eligibility.allowed) {
      throw new ForbiddenException(eligibility.reason ?? "not_eligible");
    }

    const windowStart = hourWindowStart(input.windowStart);
    const idempotencyKey = buildIdempotencyKey(
      input.interactionId,
      input.templateId,
      windowStart,
    );

    const existingOutbox = await this.outboxRepo.findOne({
      where: { idempotencyKey },
    });
    if (existingOutbox) {
      const existingMessage = existingOutbox.twilioMessageSid
        ? await this.messageRepo.findOne({
            where: { twilioMessageSid: existingOutbox.twilioMessageSid },
          })
        : null;
      return {
        duplicate: true,
        outbox: existingOutbox,
        message: existingMessage,
        idempotencyKey,
      };
    }

    const allowed = await this.redis.checkRateLimit(
      `send:${input.interactionId}`,
      20,
      60,
    );
    if (!allowed) {
      throw new ConflictException("rate_limit_exceeded");
    }

    const twilioMessageSid = fakeTwilioSid("out", idempotencyKey);
    const outbox = await this.outboxRepo.save(
      this.outboxRepo.create({
        idempotencyKey,
        interactionId: input.interactionId,
        templateId: input.templateId,
        body: input.body,
        status: "sent",
        twilioMessageSid,
        source: input.source,
      }),
    );

    const message = await this.messageRepo.save(
      this.messageRepo.create({
        interactionId: input.interactionId,
        twilioMessageSid,
        direction: "outbound",
        body: input.body,
        status: "queued",
        source: input.source,
        idempotencyKey,
      }),
    );

    return { duplicate: false, outbox, message, idempotencyKey };
  }

  async getDuplicateStats() {
    const totalOutbound = await this.messageRepo.count({
      where: { direction: "outbound" },
    });
    const distinctKeys = await this.outboxRepo.count();
    const duplicateAttempts = Math.max(0, totalOutbound - distinctKeys);
    const duplicateRate =
      totalOutbound === 0 ? 0 : duplicateAttempts / totalOutbound;
    return { totalOutbound, distinctKeys, duplicateRate };
  }
}
