/** Same-origin API paths; Next.js rewrites proxy to NestJS (see next.config.mjs). */
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
};
