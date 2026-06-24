import "reflect-metadata";
import { randomUUID } from "crypto";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { AppModule } from "../src/app.module";

describe("Inbound router (e2e)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.COORDINATOR_MODEL_MODE = "mock";

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

  it("routes inbound reschedule messages to a coordinator proposal", async () => {
    const created = await request(app.getHttpServer())
      .post("/care-ops/interactions")
      .send({ patientId: "inbound-1", programId: "behavioral-health-outreach" })
      .expect(201);

    const interactionId = created.body.id as string;
    const messageSid = `SM_INBOUND_${randomUUID()}`;

    const inbound = await request(app.getHttpServer())
      .post("/webhooks/twilio/inbound")
      .send({
        MessageSid: messageSid,
        Body: "can we move to Thursday?",
        interactionId,
      })
      .expect(201);

    expect(inbound.body.duplicate).toBe(false);
    expect(inbound.body.confirmed).toBe(false);
    expect(inbound.body.intent).toBe("RESCHEDULE");
    expect(inbound.body.coordinatorRun).toMatchObject({
      status: "awaiting_approval",
      signalType: "inbound",
      proposal: {
        status: "pending",
        templateId: "reschedule-offer",
      },
    });
  });

  it("skips inbound router on MessageSid replay", async () => {
    const created = await request(app.getHttpServer())
      .post("/care-ops/interactions")
      .send({ patientId: "inbound-2", programId: "behavioral-health-outreach" })
      .expect(201);

    const interactionId = created.body.id as string;
    const messageSid = `SM_INBOUND_${randomUUID()}`;
    const payload = {
      MessageSid: messageSid,
      Body: "can we move to Thursday?",
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
    expect(replay.body.intent).toBeUndefined();
    expect(replay.body.coordinatorRun).toBeUndefined();
  });
});
