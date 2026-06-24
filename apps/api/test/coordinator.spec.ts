import "reflect-metadata";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { AppModule } from "../src/app.module";

describe("Outbound coordinator (e2e)", () => {
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

  it("starts a manual coordinator run and pauses at approval with a proposal", async () => {
    const created = await request(app.getHttpServer())
      .post("/care-ops/interactions")
      .send({ patientId: "coord-1", programId: "behavioral-health-outreach" })
      .expect(201);

    const interactionId = created.body.id as string;

    const run = await request(app.getHttpServer())
      .post("/care-ops/coordinator/runs")
      .send({ interactionId, signal: "manual" })
      .expect(201);

    expect(run.body.status).toBe("awaiting_approval");
    expect(run.body.modelMode).toBe("mock");
    expect(run.body.proposal).toMatchObject({
      status: "pending",
      templateId: "appointment-confirmation",
      body: expect.stringContaining("confirm"),
      rationale: expect.any(String),
    });
  });

  it("approves a coordinator proposal and sends one outbound SMS", async () => {
    const created = await request(app.getHttpServer())
      .post("/care-ops/interactions")
      .send({ patientId: "coord-2", programId: "behavioral-health-outreach" })
      .expect(201);

    const interactionId = created.body.id as string;

    const run = await request(app.getHttpServer())
      .post("/care-ops/coordinator/runs")
      .send({ interactionId, signal: "manual" })
      .expect(201);

    const approved = await request(app.getHttpServer())
      .post(`/care-ops/coordinator/runs/${run.body.id}/approve`)
      .expect(201);

    expect(approved.body.status).toBe("completed");
    expect(approved.body.sendResult.duplicate).toBe(false);

    const detail = await request(app.getHttpServer())
      .get(`/care-ops/interactions/${interactionId}`)
      .expect(200);

    const outbound = detail.body.messages.filter(
      (m: { direction: string }) => m.direction === "outbound",
    );
    expect(outbound).toHaveLength(1);
    expect(outbound[0].body).toContain("confirm");
  });

  it("dedupes coordinator approve replays to a single outbound row", async () => {
    const created = await request(app.getHttpServer())
      .post("/care-ops/interactions")
      .send({ patientId: "coord-3", programId: "behavioral-health-outreach" })
      .expect(201);

    const interactionId = created.body.id as string;
    const windowStart = "2026-06-24T12:00:00.000Z";

    const run1 = await request(app.getHttpServer())
      .post("/care-ops/coordinator/runs")
      .send({ interactionId, signal: "manual" })
      .expect(201);

    const first = await request(app.getHttpServer())
      .post(`/care-ops/coordinator/runs/${run1.body.id}/approve`)
      .send({ windowStart })
      .expect(201);

    expect(first.body.sendResult.duplicate).toBe(false);

    const run2 = await request(app.getHttpServer())
      .post("/care-ops/coordinator/runs")
      .send({ interactionId, signal: "manual" })
      .expect(201);

    const second = await request(app.getHttpServer())
      .post(`/care-ops/coordinator/runs/${run2.body.id}/approve`)
      .send({ windowStart })
      .expect(201);

    expect(second.body.sendResult.duplicate).toBe(true);

    const detail = await request(app.getHttpServer())
      .get(`/care-ops/interactions/${interactionId}`)
      .expect(200);

    const outbound = detail.body.messages.filter(
      (m: { direction: string }) => m.direction === "outbound",
    );
    expect(outbound).toHaveLength(1);
  });

  it("auto-starts a coordinator run when voice visit lifecycle completes", async () => {
    const created = await request(app.getHttpServer())
      .post("/care-ops/interactions")
      .send({ patientId: "coord-4", programId: "behavioral-health-outreach" })
      .expect(201);

    const interactionId = created.body.id as string;

    const lifecycle = await request(app.getHttpServer())
      .post(`/care-ops/interactions/${interactionId}/lifecycle/voice-completed`)
      .expect(201);

    expect(lifecycle.body.voiceSession.status).toBe("completed");
    expect(lifecycle.body.coordinatorRun).toMatchObject({
      status: "awaiting_approval",
      signalType: "lifecycle",
      modelMode: "mock",
      proposal: {
        status: "pending",
        templateId: "appointment-confirmation",
      },
    });
  });

  it("terminates coordinator run as ineligible when outbound eligibility is blocked", async () => {
    const created = await request(app.getHttpServer())
      .post("/care-ops/interactions")
      .send({ patientId: "coord-5", programId: "no-outbound-program" })
      .expect(201);

    const interactionId = created.body.id as string;

    const run = await request(app.getHttpServer())
      .post("/care-ops/coordinator/runs")
      .send({ interactionId, signal: "manual" })
      .expect(201);

    expect(run.body.status).toBe("ineligible");
    expect(run.body.proposal).toBeNull();
    expect(run.body.ineligibleReason).toBe("eligibility_rule_disabled");
  });

  it("resumes pending coordinator proposal instead of replanning", async () => {
    const created = await request(app.getHttpServer())
      .post("/care-ops/interactions")
      .send({ patientId: "coord-resume", programId: "behavioral-health-outreach" })
      .expect(201);

    const interactionId = created.body.id as string;

    const first = await request(app.getHttpServer())
      .post("/care-ops/coordinator/runs")
      .send({ interactionId, signal: "manual" })
      .expect(201);

    const second = await request(app.getHttpServer())
      .post("/care-ops/coordinator/runs")
      .send({ interactionId, signal: "manual" })
      .expect(201);

    expect(second.body.resumed).toBe(true);
    expect(second.body.id).toBe(first.body.id);
    expect(second.body.proposal.id).toBe(first.body.proposal.id);

    const trace = await request(app.getHttpServer())
      .get(`/care-ops/coordinator/runs/${first.body.id}/trace`)
      .expect(200);

    const phaseEvents = trace.body.events.filter(
      (e: { eventType: string }) => e.eventType === "phase",
    );
    expect(phaseEvents.filter((e: { name: string }) => e.name === "plan")).toHaveLength(1);
  });

  it("exposes LangGraph checkpoint readiness while awaiting approval", async () => {
    const created = await request(app.getHttpServer())
      .post("/care-ops/interactions")
      .send({ patientId: "coord-graph", programId: "behavioral-health-outreach" })
      .expect(201);

    const run = await request(app.getHttpServer())
      .post("/care-ops/coordinator/runs")
      .send({ interactionId: created.body.id, signal: "manual" })
      .expect(201);

    const detail = await request(app.getHttpServer())
      .get(`/care-ops/coordinator/runs/${run.body.id}`)
      .expect(200);

    expect(detail.body.graphEngine).toBe("langgraph");
    expect(detail.body.checkpointReady).toBe(true);
  });

  it("rejects a coordinator proposal without sending outbound SMS", async () => {
    const created = await request(app.getHttpServer())
      .post("/care-ops/interactions")
      .send({ patientId: "coord-6", programId: "behavioral-health-outreach" })
      .expect(201);

    const interactionId = created.body.id as string;

    const run = await request(app.getHttpServer())
      .post("/care-ops/coordinator/runs")
      .send({ interactionId, signal: "manual" })
      .expect(201);

    const rejected = await request(app.getHttpServer())
      .post(`/care-ops/coordinator/runs/${run.body.id}/reject`)
      .expect(201);

    expect(rejected.body.status).toBe("rejected");
    expect(rejected.body.proposal.status).toBe("rejected");

    const detail = await request(app.getHttpServer())
      .get(`/care-ops/interactions/${interactionId}`)
      .expect(200);

    const outbound = detail.body.messages.filter(
      (m: { direction: string }) => m.direction === "outbound",
    );
    expect(outbound).toHaveLength(0);
  });

  it("returns coordinator trace events for a run through approval", async () => {
    const created = await request(app.getHttpServer())
      .post("/care-ops/interactions")
      .send({ patientId: "coord-7", programId: "behavioral-health-outreach" })
      .expect(201);

    const interactionId = created.body.id as string;

    const run = await request(app.getHttpServer())
      .post("/care-ops/coordinator/runs")
      .send({ interactionId, signal: "manual" })
      .expect(201);

    const traceBeforeApprove = await request(app.getHttpServer())
      .get(`/care-ops/coordinator/runs/${run.body.id}/trace`)
      .expect(200);

    expect(traceBeforeApprove.body.events.map((e: { name: string }) => e.name)).toEqual([
      "observe",
      "retrieve_care_context",
      "check_eligibility",
      "plan",
      "propose",
      "await_approval",
    ]);

    await request(app.getHttpServer())
      .post(`/care-ops/coordinator/runs/${run.body.id}/approve`)
      .expect(201);

    const traceAfterApprove = await request(app.getHttpServer())
      .get(`/care-ops/coordinator/runs/${run.body.id}/trace`)
      .expect(200);

    expect(traceAfterApprove.body.events.map((e: { name: string }) => e.name)).toEqual([
      "observe",
      "retrieve_care_context",
      "check_eligibility",
      "plan",
      "propose",
      "await_approval",
      "execute",
      "send_outbound_sms",
      "audit",
      "complete",
    ]);
  });

  it("streams coordinator trace events over SSE", async () => {
    const created = await request(app.getHttpServer())
      .post("/care-ops/interactions")
      .send({ patientId: "coord-sse", programId: "behavioral-health-outreach" })
      .expect(201);

    const run = await request(app.getHttpServer())
      .post("/care-ops/coordinator/runs")
      .send({ interactionId: created.body.id, signal: "manual" })
      .expect(201);

    const stream = await request(app.getHttpServer())
      .get(`/care-ops/coordinator/runs/${run.body.id}/stream`)
      .expect(200)
      .expect("Content-Type", /text\/event-stream/);

    expect(stream.text).toContain("event: phase");
    expect(stream.text).toContain("event: tool");
    expect(stream.text).toContain("event: interrupt");
    expect(stream.text).toContain('"name":"observe"');
    expect(stream.text).toContain('"name":"await_approval"');
  });
});
