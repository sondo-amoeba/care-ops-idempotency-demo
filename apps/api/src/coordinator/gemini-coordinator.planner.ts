import { Injectable } from "@nestjs/common";
import { GoogleGenerativeAI, ObjectSchema, SchemaType } from "@google/generative-ai";
import { CoordinatorPlanContext, CoordinatorProposalDraft } from "./coordinator-proposal.types";

const DEFAULT_MODEL = "gemini-2.0-flash";

const PROPOSAL_SCHEMA: ObjectSchema = {
  type: SchemaType.OBJECT,
  properties: {
    templateId: {
      type: SchemaType.STRING,
      description: "Template key, e.g. appointment-confirmation, follow-up",
    },
    body: {
      type: SchemaType.STRING,
      description: "Draft SMS body, concise and patient-friendly",
    },
    rationale: {
      type: SchemaType.STRING,
      description: "Why this action is appropriate given program policy",
    },
  },
  required: ["templateId", "body", "rationale"],
};

@Injectable()
export class GeminiCoordinatorPlanner {
  isConfigured(): boolean {
    return (
      process.env.COORDINATOR_MODEL_MODE !== "mock" && !!process.env.GEMINI_API_KEY?.trim()
    );
  }

  async plan(context: CoordinatorPlanContext): Promise<CoordinatorProposalDraft> {
    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) {
      throw new Error("GEMINI_API_KEY not configured");
    }

    const modelName = process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL;
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: modelName,
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: PROPOSAL_SCHEMA,
      },
    });

    const result = await model.generateContent(this.buildPrompt(context));
    const text = result.response.text();
    const parsed = JSON.parse(text) as CoordinatorProposalDraft;

    if (!parsed.templateId || !parsed.body || !parsed.rationale) {
      throw new Error("Gemini returned incomplete proposal JSON");
    }

    return parsed;
  }

  buildPrompt(context: CoordinatorPlanContext): string {
    const { detail, contextChunks, input } = context;
    const policyLines = contextChunks
      .map((chunk) => `- ${chunk.policyKey}: ${chunk.chunkText}`)
      .join("\n");

    return [
      "You are an AI care coordinator for a behavioral health outreach program.",
      "Propose ONE outbound SMS action. Never send directly — a human approves first.",
      "Respond with JSON only: templateId, body, rationale.",
      "",
      `Signal: ${input.signal}`,
      `Care thread status: ${detail.careThread?.status ?? "unknown"}`,
      `Voice session status: ${detail.voiceSession?.status ?? "unknown"}`,
      `Booking status: ${detail.booking?.status ?? "unknown"}`,
      "",
      "Program policy snippets:",
      policyLines || "(none retrieved)",
      "",
      "Prefer appointment-confirmation when voice is completed and booking is pending.",
      "Keep SMS bodies under 160 characters when possible.",
    ].join("\n");
  }
}
