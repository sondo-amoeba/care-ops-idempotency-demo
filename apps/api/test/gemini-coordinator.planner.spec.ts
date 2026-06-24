import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GeminiCoordinatorPlanner,
  isRetryableGeminiModelError,
  resolveGeminiModelChain,
} from "../src/coordinator/gemini-coordinator.planner";
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

const validProposal = {
  templateId: "appointment-confirmation",
  body: "Reply YES to confirm.",
  rationale: "Pending booking after voice visit.",
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

  it("defaults model chain to 2.5 flash family", () => {
    vi.unstubAllEnvs();
    expect(resolveGeminiModelChain()).toEqual([
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
      "gemini-1.5-flash",
    ]);
  });

  it("parses structured JSON from Gemini", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    mockGenerateContent.mockResolvedValue({
      response: {
        text: () => JSON.stringify(validProposal),
      },
    });

    const result = await planner.plan(baseContext);
    expect(result.draft).toEqual(validProposal);
    expect(result.model).toBe("gemini-2.5-flash");
  });

  it("falls back when the first model hits limit 0", async () => {
    vi.stubEnv("GEMINI_API_KEY", "test-key");
    mockGenerateContent
      .mockRejectedValueOnce(new Error("429 limit: 0, model: gemini-2.5-flash"))
      .mockResolvedValueOnce({
        response: { text: () => JSON.stringify(validProposal) },
      });

    const result = await planner.plan(baseContext);
    expect(result.model).toBe("gemini-2.5-flash-lite");
    expect(mockGenerateContent).toHaveBeenCalledTimes(2);
  });

  it("treats limit 0 errors as retryable", () => {
    expect(isRetryableGeminiModelError(new Error("429 limit: 0"))).toBe(true);
    expect(isRetryableGeminiModelError(new Error("invalid API key"))).toBe(false);
  });

  it("buildPrompt includes interaction statuses and policy chunks", () => {
    const prompt = planner.buildPrompt(baseContext);
    expect(prompt).toContain("Voice session status: completed");
    expect(prompt).toContain("confirm-window");
    expect(prompt).toContain("Signal: manual");
  });
});
