import "reflect-metadata";
import { randomUUID } from "crypto";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { AppModule } from "../src/app.module";

/**
 * ADR-0006 outbox relay (e2e). Autodrain is off under VITEST, so each test
 * drives a single drain/reap tick deterministically via the relay endpoints.
 * All drains/stats are scoped by interactionId so tests don't contend over the
 * shared dev database. Each test sets a unique CARRIER_MPS_BUCKET_KEY so the
 * token bucket starts full and isolated.
 */
describe("Outbox relay (e2e)", () => {
  let app: INestApplication;
  const ENV_KEYS = [
    "SMS_SIMULATE_SUBMISSION_FAILURE",
    "SMS_SIMULATE_FAILURE_MODE",
    "SMS_SIMULATE_CRASH_DURING_SUBMIT",
    "CARRIER_MPS",
    "CARRIER_MPS_BUCKET_KEY",
    "RELAY_MAX_ATTEMPTS",
    "RELAY_BACKOFF_BASE_MS",
  ];
  const snapshot: Record<string, string | undefined> = {};

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (snapshot[k] === undefined) delete process.env[k];
      else process.env[k] = snapshot[k];
      delete snapshot[k];
    }
  });

  function setEnv(vars: Record<string, string>) {
    for (const [k, v] of Object.entries(vars)) {
      snapshot[k] = process.env[k];
      process.env[k] = v;
    }
  }

  async function newInteraction(patientId: string): Promise<string> {
    const res = await request(app.getHttpServer())
      .post("/care-ops/interactions")
      .send({ patientId, programId: "behavioral-health-outreach" })
      .expect(201);
    return res.body.id as string;
  }

  async function send(interactionId: string, patientId: string, templateId: string) {
    return request(app.getHttpServer())
      .post("/care-ops/sms/send")
      .send({
        interactionId,
        patientId,
        programId: "behavioral-health-outreach",
        templateId,
        body: "relay test body",
      })
      .expect(201);
  }

  function drain(interactionIds: string[], batchSize = 50) {
    return request(app.getHttpServer())
      .post("/care-ops/relay/drain")
      .send({ interactionIds, batchSize })
      .expect(201);
  }

  function stats(interactionId: string) {
    return request(app.getHttpServer())
      .get(`/care-ops/relay/stats?interactionId=${interactionId}`)
      .expect(200);
  }

  function outboundMessages(interactionId: string) {
    return request(app.getHttpServer())
      .get(`/care-ops/interactions/${interactionId}`)
      .expect(200)
      .then((r) =>
        r.body.messages.filter((m: { direction: string }) => m.direction === "outbound"),
      );
  }

  it("drains a pending row to the carrier (happy path)", async () => {
    setEnv({ CARRIER_MPS: "1000", CARRIER_MPS_BUCKET_KEY: randomUUID() });
    const id = await newInteraction("relay-happy");
    await send(id, "relay-happy", "happy");

    const res = await drain([id]);
    expect(res.body.submitted).toBe(1);
    expect(res.body.claimed).toBe(1);

    const outbound = await outboundMessages(id);
    expect(outbound).toHaveLength(1);
    expect(outbound[0].status).toBe("queued");
    expect(outbound[0].twilioMessageSid).toMatch(/^SM/);

    const s = await stats(id);
    expect(s.body.submitted).toBe(1);
  });

  it("two concurrent relay workers drain a backlog with no double-submit (SKIP LOCKED)", async () => {
    setEnv({ CARRIER_MPS: "1000", CARRIER_MPS_BUCKET_KEY: randomUUID() });
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) {
      const id = await newInteraction(`relay-skiplock-${i}`);
      await send(id, `relay-skiplock-${i}`, "skiplock");
      ids.push(id);
    }

    // Two workers race over the same backlog.
    const [a, b] = await Promise.all([drain(ids, 8), drain(ids, 8)]);
    const submitted = a.body.submitted + b.body.submitted;
    expect(submitted).toBe(8);

    // Every interaction has exactly one submitted outbound row.
    for (const id of ids) {
      const outbound = await outboundMessages(id);
      expect(outbound).toHaveLength(1);
      expect(outbound[0].status).toBe("queued");
      const s = await stats(id);
      expect(s.body.submitted).toBe(1);
      expect(s.body.submitting ?? 0).toBe(0);
      expect(s.body.pending ?? 0).toBe(0);
    }
  });

  it("retries a transient carrier failure under the same key, then succeeds", async () => {
    setEnv({
      SMS_SIMULATE_SUBMISSION_FAILURE: "true",
      SMS_SIMULATE_FAILURE_MODE: "retryable",
      RELAY_BACKOFF_BASE_MS: "0",
      RELAY_MAX_ATTEMPTS: "5",
      CARRIER_MPS: "1000",
      CARRIER_MPS_BUCKET_KEY: randomUUID(),
    });
    const id = await newInteraction("relay-retry");
    await send(id, "relay-retry", "retry");

    const first = await drain([id]);
    expect(first.body.retried).toBe(1);
    expect(first.body.submitted).toBe(0);
    let s = await stats(id);
    expect(s.body.pending).toBe(1); // back to pending for retry

    // Carrier recovers.
    delete process.env.SMS_SIMULATE_SUBMISSION_FAILURE;
    const second = await drain([id]);
    expect(second.body.submitted).toBe(1);

    const outbound = await outboundMessages(id);
    expect(outbound[0].status).toBe("queued");
    s = await stats(id);
    expect(s.body.submitted).toBe(1);
  });

  it("dead-letters a terminal carrier failure without retrying", async () => {
    setEnv({
      SMS_SIMULATE_SUBMISSION_FAILURE: "true",
      SMS_SIMULATE_FAILURE_MODE: "terminal",
      CARRIER_MPS: "1000",
      CARRIER_MPS_BUCKET_KEY: randomUUID(),
    });
    const id = await newInteraction("relay-terminal");
    await send(id, "relay-terminal", "terminal");

    const res = await drain([id]);
    expect(res.body.deadLettered).toBe(1);
    expect(res.body.retried).toBe(0);

    const s = await stats(id);
    expect(s.body.dead_letter).toBe(1);
    const outbound = await outboundMessages(id);
    expect(outbound[0].status).toBe("submission_failed");
  });

  it("dead-letters after exhausting max retry attempts", async () => {
    setEnv({
      SMS_SIMULATE_SUBMISSION_FAILURE: "true",
      SMS_SIMULATE_FAILURE_MODE: "retryable",
      RELAY_BACKOFF_BASE_MS: "0",
      RELAY_MAX_ATTEMPTS: "2",
      CARRIER_MPS: "1000",
      CARRIER_MPS_BUCKET_KEY: randomUUID(),
    });
    const id = await newInteraction("relay-maxattempts");
    await send(id, "relay-maxattempts", "maxattempts");

    const first = await drain([id]);
    expect(first.body.retried).toBe(1); // attempts=1 < 2

    const second = await drain([id]);
    expect(second.body.deadLettered).toBe(1); // attempts=2 >= 2

    const s = await stats(id);
    expect(s.body.dead_letter).toBe(1);
  });

  it("reaper re-queues a row stranded mid-submit, which then succeeds (at-least-once boundary)", async () => {
    setEnv({
      SMS_SIMULATE_CRASH_DURING_SUBMIT: "true",
      CARRIER_MPS: "1000",
      CARRIER_MPS_BUCKET_KEY: randomUUID(),
    });
    const id = await newInteraction("relay-reap");
    await send(id, "relay-reap", "reap");

    // Crash mid-submit strands the row in `submitting`.
    const crashed = await drain([id]);
    expect(crashed.body.stranded).toBe(1);
    expect(crashed.body.submitted).toBe(0);
    let s = await stats(id);
    expect(s.body.submitting).toBe(1);

    // Reaper recovers it.
    delete process.env.SMS_SIMULATE_CRASH_DURING_SUBMIT;
    const reap = await request(app.getHttpServer())
      .post("/care-ops/relay/reap")
      .send({ olderThanMs: 0, interactionIds: [id] })
      .expect(201);
    expect(reap.body.reaped).toBe(1);
    s = await stats(id);
    expect(s.body.pending).toBe(1);

    // Next drain submits it.
    const ok = await drain([id]);
    expect(ok.body.submitted).toBe(1);
    const outbound = await outboundMessages(id);
    expect(outbound[0].status).toBe("queued");
  });

  it("throttles drains when the carrier MPS bucket is empty", async () => {
    // Capacity 1: bucket starts with a single token.
    setEnv({ CARRIER_MPS: "1", CARRIER_MPS_BUCKET_KEY: randomUUID() });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = await newInteraction(`relay-mps-${i}`);
      await send(id, `relay-mps-${i}`, "mps");
      ids.push(id);
    }

    const res = await drain(ids, 10);
    expect(res.body.claimed).toBe(3);
    expect(res.body.submitted).toBe(1); // only one token available
    expect(res.body.throttled).toBe(2); // released back to pending

    // Throttled rows are still pending (durable, safe to defer).
    let pending = 0;
    for (const id of ids) {
      const s = await stats(id);
      pending += s.body.pending ?? 0;
    }
    expect(pending).toBe(2);
  });
});
