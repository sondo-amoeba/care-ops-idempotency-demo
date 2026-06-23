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
