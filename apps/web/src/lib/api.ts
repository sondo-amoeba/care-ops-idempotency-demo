/** Same-origin API paths; route handlers proxy to NestJS via API_PROXY_URL. */
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || res.statusText);
  }
  return res.json() as Promise<T>;
}

export type InteractionSummary = {
  id: string;
  patientId: string;
  programId: string;
  createdAt: string;
  messageCount: number;
};

export type SmsMessage = {
  id: string;
  direction: "inbound" | "outbound";
  body: string;
  status: string;
  source?: string;
  twilioMessageSid: string;
  createdAt: string;
};

export type ThreadDetail = {
  interaction: InteractionSummary;
  careThread: { status: string } | null;
  voiceSession: { status: string } | null;
  booking: { status: string } | null;
  messages: SmsMessage[];
};

export type EligibilityRule = {
  id: string;
  programId: string;
  channel: string;
  action: string;
  enabled: boolean;
};

export type SendSmsResult = {
  duplicate: boolean;
  idempotencyKey?: string;
  message?: SmsMessage;
};

export type InboundResult = {
  duplicate: boolean;
  confirmed?: boolean;
  intent?: string;
  coordinatorRun?: CoordinatorRun;
};

export type CoordinatorProposal = {
  id: string;
  runId: string;
  interactionId: string;
  templateId: string;
  body: string;
  rationale: string;
  status: string;
};

export type CoordinatorRun = {
  id: string;
  interactionId: string;
  status: string;
  modelMode: "mock" | "live";
  signalType: string;
  proposal: CoordinatorProposal | null;
  graphEngine?: "langgraph";
  checkpointReady?: boolean;
  resumed?: boolean;
  ineligibleReason?: string | null;
};

export type CoordinatorTraceEvent = {
  id: string;
  runId: string;
  eventType: string;
  name: string;
  detail?: Record<string, unknown> | null;
  createdAt: string;
};

export type StatusCallbackResult = {
  updated: boolean;
  reason?: string;
  message?: SmsMessage;
};

export const careOpsApi = {
  listInteractions: () => api<InteractionSummary[]>("/care-ops/interactions"),
  createInteraction: (patientId: string, programId: string) =>
    api<InteractionSummary>("/care-ops/interactions", {
      method: "POST",
      body: JSON.stringify({ patientId, programId }),
    }),
  getThread: (id: string) => api<ThreadDetail>(`/care-ops/interactions/${id}`),
  sendSms: (body: Record<string, string>) =>
    api<SendSmsResult>("/care-ops/sms/send", { method: "POST", body: JSON.stringify(body) }),
  triggerAgentSms: (body: Record<string, string>) =>
    api<SendSmsResult>("/care-ops/agent-workflow/trigger-sms", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  replayInbound: (body: Record<string, string>) =>
    api<InboundResult>("/webhooks/twilio/inbound", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  updateStatus: (body: Record<string, string>) =>
    api<StatusCallbackResult>("/webhooks/twilio/status", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  listRules: () => api<EligibilityRule[]>("/care-ops/eligibility/rules"),
  upsertRule: (body: Omit<EligibilityRule, "id">) =>
    api("/care-ops/eligibility/rules", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  duplicateMetrics: () =>
    api<{ totalOutbound: number; distinctKeys: number; duplicateRate: number }>(
      "/care-ops/metrics/duplicates",
    ),
  completeVoiceLifecycle: (interactionId: string) =>
    api<{ voiceSession: { status: string }; coordinatorRun: CoordinatorRun }>(
      `/care-ops/interactions/${interactionId}/lifecycle/voice-completed`,
      { method: "POST" },
    ),
  startCoordinatorRun: (interactionId: string, signal: "manual" | "lifecycle" = "manual") =>
    api<CoordinatorRun>("/care-ops/coordinator/runs", {
      method: "POST",
      body: JSON.stringify({ interactionId, signal }),
    }),
  getCoordinatorRun: (runId: string) =>
    api<CoordinatorRun>(`/care-ops/coordinator/runs/${runId}`),
  getCoordinatorTrace: (runId: string) =>
    api<{ runId: string; events: CoordinatorTraceEvent[] }>(
      `/care-ops/coordinator/runs/${runId}/trace`,
    ),
  approveCoordinatorRun: (runId: string, windowStart?: string) =>
    api<CoordinatorRun & { sendResult?: SendSmsResult }>(
      `/care-ops/coordinator/runs/${runId}/approve`,
      {
        method: "POST",
        body: JSON.stringify(windowStart ? { windowStart } : {}),
      },
    ),
  rejectCoordinatorRun: (runId: string) =>
    api<CoordinatorRun>(`/care-ops/coordinator/runs/${runId}/reject`, {
      method: "POST",
    }),
};
