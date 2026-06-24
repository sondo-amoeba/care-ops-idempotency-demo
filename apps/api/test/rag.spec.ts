import "reflect-metadata";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { AppModule } from "../src/app.module";

describe("Care context retrieval (e2e)", () => {
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

  it("logs retrieved care context chunks in coordinator trace", async () => {
    const created = await request(app.getHttpServer())
      .post("/care-ops/interactions")
      .send({ patientId: "rag-1", programId: "behavioral-health-outreach" })
      .expect(201);

    const interactionId = created.body.id as string;

    const run = await request(app.getHttpServer())
      .post("/care-ops/coordinator/runs")
      .send({ interactionId, signal: "manual" })
      .expect(201);

    const trace = await request(app.getHttpServer())
      .get(`/care-ops/coordinator/runs/${run.body.id}/trace`)
      .expect(200);

    const names = trace.body.events.map((e: { name: string }) => e.name);
    expect(names.indexOf("observe")).toBeLessThan(names.indexOf("retrieve_care_context"));
    expect(names.indexOf("retrieve_care_context")).toBeLessThan(
      names.indexOf("check_eligibility"),
    );

    const retrieve = trace.body.events.find(
      (e: { name: string }) => e.name === "retrieve_care_context",
    );
    expect(retrieve.detail.policyKeys).toEqual(
      expect.arrayContaining(["confirm-window", "reschedule-hitl"]),
    );
  });
});
