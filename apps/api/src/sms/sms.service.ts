import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import {
  buildIdempotencyKey,
  hourWindowStart,
  localPendingSid,
} from "../common/idempotency.util";
import { EligibilityService } from "../eligibility/eligibility.service";
import { Interaction, SmsMessage, SmsOutbox } from "../entities";
import { RedisService } from "../redis/redis.service";

export interface SendSmsInput {
  interactionId: string;
  patientId: string;
  programId: string;
  templateId: string;
  body: string;
  source: "care_agent" | "agent_workflow" | "ai_coordinator";
  windowStart?: string;
  resendKey?: string;
}

export interface SendSmsResult {
  duplicate: boolean;
  outbox: SmsOutbox;
  message: SmsMessage | null;
  idempotencyKey: string;
  carrierSubmitted: boolean;
}

@Injectable()
export class SmsService {
  constructor(
    @InjectRepository(SmsMessage)
    private readonly messageRepo: Repository<SmsMessage>,
    @InjectRepository(SmsOutbox)
    private readonly outboxRepo: Repository<SmsOutbox>,
    @InjectRepository(Interaction)
    private readonly interactionRepo: Repository<Interaction>,
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
      return { message: existing, duplicate: true, confirmed: false };
    }

    const interaction = await this.interactionRepo.findOne({
      where: { id: payload.interactionId },
    });
    if (!interaction) {
      throw new NotFoundException("interaction_not_found");
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

  async sendOutbound(input: SendSmsInput): Promise<SendSmsResult> {
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
      input.resendKey,
    );

    const existingOutbox = await this.outboxRepo.findOne({
      where: { idempotencyKey },
    });
    if (existingOutbox) {
      return this.buildDuplicateSendResult(idempotencyKey, existingOutbox);
    }

    const allowed = await this.redis.checkRateLimit(
      `send:${input.interactionId}`,
      20,
      60,
    );
    if (!allowed) {
      throw new ConflictException("rate_limit_exceeded");
    }

    const claimed = await this.claimOutboundLedger({
      idempotencyKey,
      interactionId: input.interactionId,
      templateId: input.templateId,
      body: input.body,
      source: input.source,
    });

    if (!claimed) {
      const racedOutbox = await this.outboxRepo.findOne({
        where: { idempotencyKey },
      });
      if (!racedOutbox) {
        throw new ConflictException("outbox_race_retry");
      }
      return this.buildDuplicateSendResult(idempotencyKey, racedOutbox);
    }

    // ADR-0006: the request path is write-only. The ledger row is durable and
    // `pending`; the OutboxRelay is the sole caller of the carrier and drains
    // it out-of-band. We do NOT submit inline here.
    const outbox = await this.outboxRepo.findOneOrFail({
      where: { idempotencyKey },
    });
    const message = await this.messageRepo.findOneOrFail({
      where: { idempotencyKey },
    });

    return {
      duplicate: false,
      outbox,
      message,
      idempotencyKey,
      carrierSubmitted: false,
    };
  }

  /**
   * Ledger-first: outbox + message rows in one transaction before any carrier call.
   */
  private async claimOutboundLedger(values: {
    idempotencyKey: string;
    interactionId: string;
    templateId: string;
    body: string;
    source: string;
  }): Promise<boolean> {
    const pendingSid = localPendingSid(values.idempotencyKey);

    return this.outboxRepo.manager.transaction(async (tx) => {
      const outboxRows: Array<{ id: string }> = await tx.query(
        `
          INSERT INTO sms_outbox
            ("idempotencyKey", "interactionId", "templateId", body, status, source)
          VALUES ($1, $2, $3, $4, 'pending', $5)
          ON CONFLICT ("idempotencyKey") DO NOTHING
          RETURNING id
        `,
        [
          values.idempotencyKey,
          values.interactionId,
          values.templateId,
          values.body,
          values.source,
        ],
      );

      if (outboxRows.length === 0) {
        return false;
      }

      await tx.query(
        `
          INSERT INTO sms_messages
            ("interactionId", "twilioMessageSid", direction, body, status, source, "idempotencyKey")
          VALUES ($1, $2, 'outbound', $3, 'pending', $4, $5)
        `,
        [
          values.interactionId,
          pendingSid,
          values.body,
          values.source,
          values.idempotencyKey,
        ],
      );

      return true;
    });
  }

  private async buildDuplicateSendResult(
    idempotencyKey: string,
    existingOutbox: SmsOutbox,
  ): Promise<SendSmsResult> {
    const existingMessage = await this.messageRepo.findOne({
      where: { idempotencyKey },
    });
    return {
      duplicate: true,
      outbox: existingOutbox,
      message: existingMessage,
      idempotencyKey,
      carrierSubmitted: existingOutbox.status === "submitted",
    };
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
