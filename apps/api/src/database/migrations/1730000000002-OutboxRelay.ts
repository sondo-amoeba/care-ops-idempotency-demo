import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * ADR-0006: async outbox relay. Adds the retry/dead-letter bookkeeping the
 * relay needs to drain `sms_outbox` out-of-band:
 *   - attempts       carrier-submit attempts so far
 *   - nextAttemptAt  earliest time the relay may (re)claim the row (backoff)
 *   - lastError      last carrier failure reason (observability + dead_letter triage)
 *   - claimedAt      when the relay flipped the row to `submitting` (reaper input)
 * Plus a partial-ready claim index for the SKIP LOCKED drain query.
 */
export class OutboxRelay1730000000002 implements MigrationInterface {
  name = "OutboxRelay1730000000002";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "sms_outbox" ADD COLUMN IF NOT EXISTS "attempts" integer NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "sms_outbox" ADD COLUMN IF NOT EXISTS "nextAttemptAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now()`,
    );
    await queryRunner.query(
      `ALTER TABLE "sms_outbox" ADD COLUMN IF NOT EXISTS "lastError" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "sms_outbox" ADD COLUMN IF NOT EXISTS "claimedAt" TIMESTAMP WITH TIME ZONE`,
    );
    // Drain query: WHERE status = 'pending' AND nextAttemptAt <= now() ORDER BY createdAt
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_sms_outbox_claim" ON "sms_outbox" ("status", "nextAttemptAt")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_sms_outbox_claim"`);
    await queryRunner.query(`ALTER TABLE "sms_outbox" DROP COLUMN IF EXISTS "claimedAt"`);
    await queryRunner.query(`ALTER TABLE "sms_outbox" DROP COLUMN IF EXISTS "lastError"`);
    await queryRunner.query(`ALTER TABLE "sms_outbox" DROP COLUMN IF EXISTS "nextAttemptAt"`);
    await queryRunner.query(`ALTER TABLE "sms_outbox" DROP COLUMN IF EXISTS "attempts"`);
  }
}
