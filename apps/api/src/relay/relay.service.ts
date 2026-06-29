import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { SmsMessage, SmsOutbox } from "../entities";
import { RedisService } from "../redis/redis.service";
import { CarrierClient } from "../carrier/carrier.client";

export interface DrainSummary {
  claimed: number;
  submitted: number;
  retried: number;
  deadLettered: number;
  throttled: number;
  stranded: number;
}

export interface DrainOptions {
  batchSize?: number;
  interactionIds?: string[];
}

interface ClaimedRow {
  id: string;
  idempotencyKey: string;
  body: string;
  attempts: number;
}

/**
 * ADR-0006: the async outbox relay. The SOLE caller of the carrier. Drains
 * `sms_outbox` out-of-band with `FOR UPDATE SKIP LOCKED` (safe N-worker
 * concurrency), enforces the carrier MPS budget, retries transient failures
 * under the same idempotency key, dead-letters terminal ones, and relies on a
 * reaper to recover rows stranded mid-submit (the at-least-once boundary).
 */
@Injectable()
export class RelayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RelayService.name);
  private drainTimer?: NodeJS.Timeout;
  private reapTimer?: NodeJS.Timeout;
  private draining = false;

  constructor(
    @InjectRepository(SmsOutbox)
    private readonly outboxRepo: Repository<SmsOutbox>,
    @InjectRepository(SmsMessage)
    private readonly messageRepo: Repository<SmsMessage>,
    @Inject(RedisService) private readonly redis: RedisService,
    @Inject(CarrierClient) private readonly carrier: CarrierClient,
  ) {}

  onModuleInit() {
    if (!this.autodrainEnabled()) return;
    const pollMs = Number(process.env.RELAY_POLL_MS ?? 500);
    const reapPollMs = Number(process.env.RELAY_REAP_POLL_MS ?? 5000);
    this.drainTimer = setInterval(() => {
      void this.drainSafely();
    }, pollMs);
    this.reapTimer = setInterval(() => {
      void this.reapStuck().catch((err) => this.logger.error(err));
    }, reapPollMs);
    this.logger.log(`Outbox relay autodrain on (poll ${pollMs}ms, reap ${reapPollMs}ms)`);
  }

  onModuleDestroy() {
    if (this.drainTimer) clearInterval(this.drainTimer);
    if (this.reapTimer) clearInterval(this.reapTimer);
  }

  /**
   * Opt-in (default OFF). In the lab the relay is driven explicitly — the
   * "Drain outbox relay" step is part of the walkthrough, so a reviewer can
   * watch a row go pending → submitting → queued. Set OUTBOX_RELAY_AUTODRAIN=true
   * for a hands-off background relay in a real deployment. Always off under tests.
   */
  private autodrainEnabled(): boolean {
    if (process.env.VITEST || process.env.NODE_ENV === "test") return false;
    return process.env.OUTBOX_RELAY_AUTODRAIN === "true";
  }

  /** Reentrancy guard for the background loop — never overlap drains. */
  private async drainSafely() {
    if (this.draining) return;
    this.draining = true;
    try {
      await this.drainOnce();
    } catch (err) {
      this.logger.error(err);
    } finally {
      this.draining = false;
    }
  }

  async drainOnce(opts: DrainOptions = {}): Promise<DrainSummary> {
    const batchSize = opts.batchSize ?? Number(process.env.RELAY_BATCH_SIZE ?? 20);
    const summary: DrainSummary = {
      claimed: 0,
      submitted: 0,
      retried: 0,
      deadLettered: 0,
      throttled: 0,
      stranded: 0,
    };

    const claimed = await this.claimBatch(batchSize, opts.interactionIds);
    summary.claimed = claimed.length;
    if (claimed.length === 0) return summary;

    const mps = Number(process.env.CARRIER_MPS ?? 10);
    const bucketKey = process.env.CARRIER_MPS_BUCKET_KEY ?? "carrier";

    for (const row of claimed) {
      // Carrier MPS gate. Empty bucket -> release back to pending; the row is
      // durable, so deferring it costs nothing.
      const hasToken = await this.redis.consumeToken(bucketKey, mps, mps, Date.now());
      if (!hasToken) {
        await this.release(row.id);
        summary.throttled += 1;
        continue;
      }

      let result;
      try {
        result = await this.carrier.submit({
          idempotencyKey: row.idempotencyKey,
          body: row.body,
        });
      } catch (err) {
        // Crash mid-submit: the row stays `submitting` (stranded) on purpose.
        // The reaper recovers it — this is the at-least-once carrier boundary.
        summary.stranded += 1;
        this.logger.warn(
          `relay stranded ${row.idempotencyKey}: ${(err as Error).message}`,
        );
        continue;
      }

      if (result.ok) {
        await this.markSubmitted(row.idempotencyKey, result.messageSid);
        summary.submitted += 1;
        continue;
      }

      const attempts = row.attempts + 1;
      const maxAttempts = Number(process.env.RELAY_MAX_ATTEMPTS ?? 5);
      if (!result.retryable || attempts >= maxAttempts) {
        await this.markDeadLetter(row.idempotencyKey, attempts, result.reason);
        summary.deadLettered += 1;
      } else {
        await this.markRetry(row.idempotencyKey, attempts, result.reason);
        summary.retried += 1;
      }
    }

    return summary;
  }

  /** Re-queue rows stranded in `submitting` longer than the timeout (ADR-0006). */
  async reapStuck(
    opts: { olderThanMs?: number; interactionIds?: string[] } = {},
  ): Promise<{ reaped: number }> {
    const olderThanMs = opts.olderThanMs ?? Number(process.env.RELAY_REAP_AFTER_MS ?? 30000);
    const params: unknown[] = [olderThanMs / 1000];
    let scope = "";
    if (opts.interactionIds?.length) {
      params.push(opts.interactionIds);
      scope = `AND "interactionId" = ANY($${params.length})`;
    }
    // TypeORM's raw `query()` returns `[returnedRows, affectedCount]` for
    // UPDATE ... RETURNING (unlike SELECT / INSERT ... RETURNING, which return a
    // plain rows array). Read the affected count rather than the tuple length.
    const result = await this.outboxRepo.query(
      `
        UPDATE sms_outbox
        SET status = 'pending', "claimedAt" = NULL
        WHERE status = 'submitting'
          AND "claimedAt" <= now() - make_interval(secs => $1::double precision)
          ${scope}
        RETURNING id
      `,
      params,
    );
    const reaped = typeof result?.[1] === "number" ? result[1] : (result?.length ?? 0);
    return { reaped };
  }

  async stats(interactionIds?: string[]): Promise<Record<string, number>> {
    const params: unknown[] = [];
    let scope = "";
    if (interactionIds?.length) {
      params.push(interactionIds);
      scope = `WHERE "interactionId" = ANY($1)`;
    }
    const rows: Array<{ status: string; count: number }> = await this.outboxRepo.query(
      `SELECT status, COUNT(*)::int AS count FROM sms_outbox ${scope} GROUP BY status`,
      params,
    );
    const byStatus: Record<string, number> = {};
    for (const r of rows) byStatus[r.status] = r.count;
    return byStatus;
  }

  private async claimBatch(
    batchSize: number,
    interactionIds?: string[],
  ): Promise<ClaimedRow[]> {
    return this.outboxRepo.manager.transaction(async (tx) => {
      const params: unknown[] = [];
      let scope = "";
      if (interactionIds?.length) {
        params.push(interactionIds);
        scope = `AND "interactionId" = ANY($${params.length})`;
      }
      params.push(batchSize);
      const rows: ClaimedRow[] = await tx.query(
        `
          SELECT id, "idempotencyKey", body, attempts
          FROM sms_outbox
          WHERE status = 'pending' AND "nextAttemptAt" <= now()
          ${scope}
          ORDER BY "createdAt"
          FOR UPDATE SKIP LOCKED
          LIMIT $${params.length}
        `,
        params,
      );
      if (rows.length === 0) return [];
      const ids = rows.map((r) => r.id);
      await tx.query(
        `UPDATE sms_outbox SET status = 'submitting', "claimedAt" = now() WHERE id = ANY($1)`,
        [ids],
      );
      return rows;
    });
  }

  private async release(outboxId: string) {
    await this.outboxRepo.update(
      { id: outboxId },
      { status: "pending", claimedAt: null },
    );
  }

  private async markSubmitted(idempotencyKey: string, twilioMessageSid: string) {
    await this.outboxRepo.update(
      { idempotencyKey },
      { status: "submitted", twilioMessageSid, claimedAt: null, lastError: null },
    );
    await this.messageRepo.update(
      { idempotencyKey },
      { status: "queued", twilioMessageSid },
    );
  }

  private async markRetry(idempotencyKey: string, attempts: number, reason: string) {
    const backoffMs = this.backoffMs(attempts);
    await this.outboxRepo.query(
      `
        UPDATE sms_outbox
        SET status = 'pending', attempts = $2, "lastError" = $3,
            "claimedAt" = NULL,
            "nextAttemptAt" = now() + make_interval(secs => $4::double precision)
        WHERE "idempotencyKey" = $1
      `,
      [idempotencyKey, attempts, reason, backoffMs / 1000],
    );
  }

  private async markDeadLetter(idempotencyKey: string, attempts: number, reason: string) {
    await this.outboxRepo.update(
      { idempotencyKey },
      { status: "dead_letter", attempts, lastError: reason, claimedAt: null },
    );
    await this.messageRepo.update(
      { idempotencyKey },
      { status: "submission_failed" },
    );
  }

  /** Exponential backoff with jitter; base 0 (tests) -> retry immediately. */
  private backoffMs(attempts: number): number {
    const base = Number(process.env.RELAY_BACKOFF_BASE_MS ?? 1000);
    const max = Number(process.env.RELAY_BACKOFF_MAX_MS ?? 60000);
    if (base <= 0) return 0;
    const exp = Math.min(base * 2 ** (attempts - 1), max);
    return exp + Math.random() * base * 0.1;
  }
}
