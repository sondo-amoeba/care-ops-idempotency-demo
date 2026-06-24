import { CoordinatorTraceEvent } from "../entities";

export type SseTraceEventType = "phase" | "tool" | "proposal" | "interrupt" | "complete";

export function mapTraceToSseEventType(
  event: CoordinatorTraceEvent,
): SseTraceEventType {
  if (event.eventType === "complete") return "complete";
  if (event.eventType === "interrupt") return "interrupt";
  if (event.eventType === "tool") return "tool";
  if (event.name === "propose") return "proposal";
  return "phase";
}

export function formatSseTracePayload(event: CoordinatorTraceEvent) {
  return {
    id: event.id,
    name: event.name,
    detail: event.detail ?? null,
    createdAt: event.createdAt,
  };
}

export function writeSseEvent(
  write: (chunk: string) => void,
  eventType: SseTraceEventType,
  payload: Record<string, unknown>,
) {
  write(`event: ${eventType}\n`);
  write(`data: ${JSON.stringify(payload)}\n\n`);
}
