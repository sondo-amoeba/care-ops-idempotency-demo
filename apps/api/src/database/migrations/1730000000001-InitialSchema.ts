import { MigrationInterface, QueryRunner } from "typeorm";

export class InitialSchema1730000000001 implements MigrationInterface {
  name = "InitialSchema1730000000001";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DO $$
      BEGIN
        CREATE EXTENSION IF NOT EXISTS vector;
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END $$;
    `);

    await queryRunner.query(`
      CREATE TABLE "interactions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "patientId" character varying(64) NOT NULL,
        "programId" character varying(64) NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_interactions" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "care_threads" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "interactionId" uuid NOT NULL,
        "status" character varying(32) NOT NULL DEFAULT 'open',
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_care_threads_interactionId" UNIQUE ("interactionId"),
        CONSTRAINT "PK_care_threads" PRIMARY KEY ("id"),
        CONSTRAINT "FK_care_threads_interaction" FOREIGN KEY ("interactionId")
          REFERENCES "interactions"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "voice_sessions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "interactionId" uuid NOT NULL,
        "externalCallId" character varying(64),
        "status" character varying(32) NOT NULL DEFAULT 'scheduled',
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_voice_sessions_interactionId" UNIQUE ("interactionId"),
        CONSTRAINT "PK_voice_sessions" PRIMARY KEY ("id"),
        CONSTRAINT "FK_voice_sessions_interaction" FOREIGN KEY ("interactionId")
          REFERENCES "interactions"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "bookings" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "interactionId" uuid NOT NULL,
        "scheduledAt" TIMESTAMP WITH TIME ZONE,
        "status" character varying(32) NOT NULL DEFAULT 'pending',
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_bookings_interactionId" UNIQUE ("interactionId"),
        CONSTRAINT "PK_bookings" PRIMARY KEY ("id"),
        CONSTRAINT "FK_bookings_interaction" FOREIGN KEY ("interactionId")
          REFERENCES "interactions"("id") ON DELETE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "sms_outbox" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "idempotencyKey" character varying(128) NOT NULL,
        "interactionId" uuid NOT NULL,
        "templateId" character varying(64) NOT NULL,
        "body" text NOT NULL,
        "status" character varying(32) NOT NULL DEFAULT 'pending',
        "twilioMessageSid" character varying(64),
        "source" character varying(32),
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_sms_outbox_idempotencyKey" UNIQUE ("idempotencyKey"),
        CONSTRAINT "PK_sms_outbox" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_sms_outbox_interactionId" ON "sms_outbox" ("interactionId")`,
    );

    await queryRunner.query(`
      CREATE TABLE "sms_messages" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "interactionId" uuid NOT NULL,
        "twilioMessageSid" character varying(64) NOT NULL,
        "direction" character varying(16) NOT NULL,
        "body" text NOT NULL,
        "status" character varying(32) NOT NULL,
        "source" character varying(32),
        "idempotencyKey" character varying(128),
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_sms_messages_twilioMessageSid" UNIQUE ("twilioMessageSid"),
        CONSTRAINT "PK_sms_messages" PRIMARY KEY ("id"),
        CONSTRAINT "FK_sms_messages_interaction" FOREIGN KEY ("interactionId")
          REFERENCES "interactions"("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_sms_messages_interactionId" ON "sms_messages" ("interactionId")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_sms_messages_idempotencyKey" ON "sms_messages" ("idempotencyKey")`,
    );

    await queryRunner.query(`
      CREATE TABLE "eligibility_rules" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "programId" character varying(64) NOT NULL,
        "channel" character varying(32) NOT NULL,
        "action" character varying(32) NOT NULL,
        "enabled" boolean NOT NULL DEFAULT true,
        CONSTRAINT "UQ_eligibility_rules_program_channel_action"
          UNIQUE ("programId", "channel", "action"),
        CONSTRAINT "PK_eligibility_rules" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "coordinator_runs" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "interactionId" uuid NOT NULL,
        "status" character varying(32) NOT NULL,
        "modelMode" character varying(16) NOT NULL,
        "signalType" character varying(16) NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_coordinator_runs" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "coordinator_proposals" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "runId" uuid NOT NULL,
        "interactionId" uuid NOT NULL,
        "templateId" character varying(64) NOT NULL,
        "body" text NOT NULL,
        "rationale" text NOT NULL,
        "status" character varying(16) NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_coordinator_proposals" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "coordinator_trace_events" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "runId" uuid NOT NULL,
        "eventType" character varying(16) NOT NULL,
        "name" character varying(64) NOT NULL,
        "detail" jsonb,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "PK_coordinator_trace_events" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "care_context_chunks" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "programId" character varying(64) NOT NULL,
        "policyKey" character varying(64) NOT NULL,
        "chunkText" text NOT NULL,
        "embedding" vector(1536),
        CONSTRAINT "PK_care_context_chunks" PRIMARY KEY ("id")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "care_context_chunks"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "coordinator_trace_events"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "coordinator_proposals"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "coordinator_runs"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "eligibility_rules"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "sms_messages"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "sms_outbox"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "bookings"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "voice_sessions"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "care_threads"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "interactions"`);
  }
}
