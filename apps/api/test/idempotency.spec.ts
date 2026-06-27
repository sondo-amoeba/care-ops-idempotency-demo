import "reflect-metadata";
import { randomUUID } from "crypto";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { AppModule } from "../src/app.module";

describe("Care-ops idempotency (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("upserts inbound webhooks on MessageSid replay", async () => {
    const created = await request(app.getHttpServer())
      .post("/care-ops/interactions")
      .send({ patientId: "p1", programId: "behavioral-health-outreach" })
      .expect(201);

    const interactionId = created.body.id as string;
    const messageSid = `SM_INBOUND_${randomUUID()}`;
    const payload = {
      MessageSid: messageSid,
      Body: "YES",
      interactionId,
    };

    await request(app.getHttpServer())
      .post("/webhooks/twilio/inbound")
      .send(payload)
      .expect(201);

    const replay = await request(app.getHttpServer())
      .post("/webhooks/twilio/inbound")
      .send(payload)
      .expect(201);

    expect(replay.body.duplicate).toBe(true);

    const detail = await request(app.getHttpServer())
      .get(`/care-ops/interactions/${interactionId}`)
      .expect(200);

    expect(detail.body.messages).toHaveLength(1);
  });

  it("confirms booking on first inbound YES when scheduling is enabled", async () => {
    const created = await request(app.getHttpServer())
      .post("/care-ops/interactions")
      .send({ patientId: "p1b", programId: "behavioral-health-outreach" })
      .expect(201);

    const interactionId = created.body.id as string;
    const messageSid = `SM_INBOUND_${randomUUID()}`;

    const inbound = await request(app.getHttpServer())
      .post("/webhooks/twilio/inbound")
      .send({
        MessageSid: messageSid,
        Body: "YES — confirm appointment",
        interactionId,
      })
      .expect(201);

    expect(inbound.body.duplicate).toBe(false);
    expect(inbound.body.confirmed).toBe(true);

    const detail = await request(app.getHttpServer())
      .get(`/care-ops/interactions/${interactionId}`)
      .expect(200);

    expect(detail.body.booking.status).toBe("confirmed");
    expect(detail.body.voiceSession.status).toBe("completed");
    expect(detail.body.careThread.status).toBe("resolved");
  });

  it("dedupes outbound sends via idempotency_key", async () => {
    const created = await request(app.getHttpServer())
      .post("/care-ops/interactions")
      .send({ patientId: "p2", programId: "behavioral-health-outreach" })
      .expect(201);

    const interactionId = created.body.id as string;
    const sendBody = {
      interactionId,
      patientId: "p2",
      programId: "behavioral-health-outreach",
      templateId: "appointment-reminder",
      body: "Your appointment is tomorrow at 10am.",
      windowStart: "2026-06-23T15:00:00.000Z",
    };

    const first = await request(app.getHttpServer())
      .post("/care-ops/sms/send")
      .send(sendBody)
      .expect(201);

    const second = await request(app.getHttpServer())
      .post("/care-ops/sms/send")
      .send(sendBody)
      .expect(201);

    expect(first.body.duplicate).toBe(false);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.message.id).toBe(first.body.message.id);
  });

  it("dedupes concurrent outbound sends to a single row", async () => {
    const created = await request(app.getHttpServer())
      .post("/care-ops/interactions")
      .send({ patientId: "p2b", programId: "behavioral-health-outreach" })
      .expect(201);

    const interactionId = created.body.id as string;
    const sendBody = {
      interactionId,
      patientId: "p2b",
      programId: "behavioral-health-outreach",
      templateId: "concurrent-demo",
      body: "Concurrent replay test.",
      windowStart: "2026-06-23T15:30:00.000Z",
    };

    const responses = await Promise.all(
      Array.from({ length: 10 }, () =>
        request(app.getHttpServer()).post("/care-ops/sms/send").send(sendBody),
      ),
    );

    for (const res of responses) {
      expect(res.status).toBe(201);
    }

    const winners = responses.filter((res) => res.body.duplicate === false);
    const blocked = responses.filter((res) => res.body.duplicate === true);
    expect(winners).toHaveLength(1);
    expect(blocked).toHaveLength(9);

    const detail = await request(app.getHttpServer())
      .get(`/care-ops/interactions/${interactionId}`)
      .expect(200);

    const outbound = detail.body.messages.filter(
      (m: { direction: string }) => m.direction === "outbound",
    );
    expect(outbound).toHaveLength(1);
  });

  it("returns the same submission_failed row on idempotency replay", async () => {
    const previous = process.env.SMS_SIMULATE_SUBMISSION_FAILURE;
    process.env.SMS_SIMULATE_SUBMISSION_FAILURE = "true";

    try {
      const created = await request(app.getHttpServer())
        .post("/care-ops/interactions")
        .send({ patientId: "p-fail", programId: "behavioral-health-outreach" })
        .expect(201);

      const interactionId = created.body.id as string;
      const sendBody = {
        interactionId,
        patientId: "p-fail",
        programId: "behavioral-health-outreach",
        templateId: "fail-template",
        body: "Carrier will fail.",
        windowStart: "2026-06-27T10:00:00.000Z",
      };

      const first = await request(app.getHttpServer())
        .post("/care-ops/sms/send")
        .send(sendBody)
        .expect(201);

      expect(first.body.duplicate).toBe(false);
      expect(first.body.carrierSubmitted).toBe(false);
      expect(first.body.message.status).toBe("submission_failed");
      expect(first.body.outbox.status).toBe("submission_failed");

      const replay = await request(app.getHttpServer())
        .post("/care-ops/sms/send")
        .send(sendBody)
        .expect(201);

      expect(replay.body.duplicate).toBe(true);
      expect(replay.body.message.id).toBe(first.body.message.id);
      expect(replay.body.message.status).toBe("submission_failed");
    } finally {
      if (previous === undefined) {
        delete process.env.SMS_SIMULATE_SUBMISSION_FAILURE;
      } else {
        process.env.SMS_SIMULATE_SUBMISSION_FAILURE = previous;
      }
    }
  });

  it("allows explicit resend after submission_failed with a new resendKey", async () => {
    const previous = process.env.SMS_SIMULATE_SUBMISSION_FAILURE;
    process.env.SMS_SIMULATE_SUBMISSION_FAILURE = "true";

    try {
      const created = await request(app.getHttpServer())
        .post("/care-ops/interactions")
        .send({ patientId: "p-resend", programId: "behavioral-health-outreach" })
        .expect(201);

      const interactionId = created.body.id as string;
      const base = {
        interactionId,
        patientId: "p-resend",
        programId: "behavioral-health-outreach",
        templateId: "resend-template",
        body: "Try again.",
        windowStart: "2026-06-27T11:00:00.000Z",
      };

      await request(app.getHttpServer())
        .post("/care-ops/sms/send")
        .send(base)
        .expect(201);

      delete process.env.SMS_SIMULATE_SUBMISSION_FAILURE;

      const resend = await request(app.getHttpServer())
        .post("/care-ops/sms/send")
        .send({ ...base, resendKey: "operator-1" })
        .expect(201);

      expect(resend.body.duplicate).toBe(false);
      expect(resend.body.carrierSubmitted).toBe(true);
      expect(resend.body.message.status).toBe("queued");

      const detail = await request(app.getHttpServer())
        .get(`/care-ops/interactions/${interactionId}`)
        .expect(200);

      const outbound = detail.body.messages.filter(
        (m: { direction: string }) => m.direction === "outbound",
      );
      expect(outbound).toHaveLength(2);
    } finally {
      if (previous === undefined) {
        delete process.env.SMS_SIMULATE_SUBMISSION_FAILURE;
      } else {
        process.env.SMS_SIMULATE_SUBMISSION_FAILURE = previous;
      }
    }
  });

  it("holds duplicate rate under 0.1% in replay storm", async () => {
    const created = await request(app.getHttpServer())
      .post("/care-ops/interactions")
      .send({ patientId: "p3", programId: "behavioral-health-outreach" })
      .expect(201);

    const interactionId = created.body.id as string;
    const sendBody = {
      interactionId,
      patientId: "p3",
      programId: "behavioral-health-outreach",
      templateId: "storm-template",
      body: "Storm test message",
      windowStart: "2026-06-23T16:00:00.000Z",
    };

    let duplicates = 0;
    for (let i = 0; i < 100; i++) {
      const res = await request(app.getHttpServer())
        .post("/care-ops/agent-workflow/trigger-sms")
        .send(sendBody);
      if (res.body.duplicate) duplicates += 1;
    }

    expect(duplicates).toBe(99);

    const detail = await request(app.getHttpServer())
      .get(`/care-ops/interactions/${interactionId}`)
      .expect(200);

    const outbound = detail.body.messages.filter(
      (m: { direction: string }) => m.direction === "outbound",
    );
    expect(outbound).toHaveLength(1);
  });
});
