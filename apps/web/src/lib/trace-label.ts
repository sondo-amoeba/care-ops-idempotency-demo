import type { CoordinatorTraceEvent } from "@/lib/api";

export function traceLabel(event: CoordinatorTraceEvent): string {
  if (event.detail && "allowed" in event.detail) {
    return `${event.name} (allowed=${String(event.detail.allowed)})`;
  }
  if (event.detail && "policyKeys" in event.detail) {
    const keys = event.detail.policyKeys as string[];
    return `${event.name} [${keys.join(", ")}]`;
  }
  if (event.detail && event.name === "gemini_plan") {
    if (event.detail.liveAttempted) {
      return `${event.name} → mock fallback (Gemini unavailable)`;
    }
    if (event.detail.model) {
      return `${event.name} (${String(event.detail.model)})`;
    }
  }
  return event.name;
}

export function geminiFallbackReason(events: CoordinatorTraceEvent[]): string | null {
  const geminiEvent = events.find((event) => event.name === "gemini_plan");
  if (!geminiEvent?.detail?.liveAttempted) return null;
  const error = String(geminiEvent.detail.error ?? "");
  if (error.includes("limit: 0")) {
    return "Gemini free-tier quota unavailable — try gemini-2.5-flash or enable billing in AI Studio";
  }
  if (error.includes("429")) {
    return "Gemini rate limited — fell back to mock planner";
  }
  return "Gemini call failed — fell back to mock planner";
}

export type GraphNodeState = "idle" | "active" | "done" | "hitl";

export function deriveNodeStates(
  trace: CoordinatorTraceEvent[],
  runStatus?: string | null,
): Record<string, GraphNodeState> {
  const names = trace.map((e) => e.name);
  const seen = new Set(names);
  const last = trace[trace.length - 1];
  const isComplete = last?.eventType === "complete" || runStatus === "completed";

  const pipeline = [
    "observe",
    "plan",
    "propose",
    "await_approval",
    "execute",
    "audit",
    "complete",
  ];
  const tools = ["retrieve_care_context", "check_eligibility", "send_outbound_sms"];

  const states: Record<string, GraphNodeState> = {};

  for (const id of [...pipeline, ...tools]) {
    if (!seen.has(id) && id !== "complete") {
      states[id] = "idle";
    }
  }

  if (isComplete) {
    for (const id of pipeline) states[id] = "done";
    for (const id of tools) {
      if (seen.has(id)) states[id] = "done";
    }
    states.complete = "done";
    return states;
  }

  const activeName =
    last?.eventType === "interrupt"
      ? "await_approval"
      : last?.eventType === "tool"
        ? last.name
        : last?.eventType === "phase"
          ? last.name
          : last?.name;

  for (const id of [...pipeline, ...tools]) {
    if (!seen.has(id)) continue;
    if (id === activeName) {
      states[id] =
        id === "await_approval" && runStatus === "awaiting_approval" ? "hitl" : "active";
    } else {
      states[id] = "done";
    }
  }

  if (seen.has("await_approval") && runStatus === "awaiting_approval") {
    states.await_approval = "hitl";
  }

  return states;
}
