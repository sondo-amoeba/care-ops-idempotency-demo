import { afterEach, describe, expect, it, vi } from "vitest";
import { GeminiCoordinatorPlanner } from "../src/coordinator/gemini-coordinator.planner";
import { CoordinatorPlanContext } from "../src/coordinator/coordinator-proposal.types";

const mockGenerateContent = vi.fn();

vi.mock("@google/generative-ai", () => ({
  GoogleGenerativeAI: vi.fn().mockImplementation(() => ({
    getGenerativeModel: vi.fn().mockReturnValue({
      generateContent: mockGenerateContent,
    }),
  })),
  SchemaType: {
    OBJECT: "OBJECT",
    STRING: "STRING",
  },
}));

const baseContext: CoordinatorPlanContext = {
  input: { interactionId: "i1", signal: "manual" },
  detail: {
    interaction: {
      id: "i1",
      patientId: "p1",
      programId: "behavioral-health-outreach",
    },
    careThread: { status: "open" },
    voiceSession: { status: "completed" },
    booking: { status: "pending" },
    messages: [],
  },
  contextChunks: [
    {
      id: "c1",
      policyKey: "confirm-window",
      chunkText: "Send confirmation within 24h of voice visit.",
      score: 0.9,
    },
  ],
};

describe("GeminiCoordinatorPlanner", () => {
  const planner = new GeminiCoordinatorPlanner();

  afterEach(() => {
    vi.unstubAllEnvs();
    mockGenerateContent.mockReset();
  });

  it("isConfigured when GEMINI_API_KEY is set and mode is not mock", () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    vi.stubEnv("COORDINATOR_MODEL_MODE", "");
    expect(planner.isConfigured()).toBe(true);
  });

  it("is not configured when COORDINATOR_MODEL_MODE is mock", () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    vi.stubEnv("COORDINATOR_MODEL_MODE", "mock");
    expect(planner.isConfigured()).toBe(false);
  });

  it("parses structured JSON from Gemini", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    mockGenerateContent.mockResolvedValue({
      response: {
        text: () =>
          JSON.stringify({
            templateId: "appointment-confirmation",
            body: "Reply YES to confirm.",
            rationale: "Pending booking after voice visit.",
          }),
      },
    });

    const draft = await planner.plan(baseContext);
    expect(draft).toEqual({
      templateId: "appointment-confirmation",
      body: "Reply YES to confirm.",
      rationale: "Pending booking after voice visit.",
    });
  });

  it("throws when Gemini returns incomplete JSON", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    mockGenerateContent.mockResolvedValue({
      response: {
        text: () => JSON.stringify({ templateId: "follow-up" }),
      },
    });

    await expect(planner.plan(baseContext)).rejects.toThrow(/incomplete proposal JSON/);
  });

  it("buildPrompt includes interaction statuses and policy chunks", () => {
    const prompt = planner.buildPrompt(baseContext);
    expect(prompt).toContain("Voice session status: completed");
    expect(prompt).toContain("confirm-window");
    expect(prompt).toContain("Signal: manual");
  });
});
