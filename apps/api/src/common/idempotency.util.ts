import { createHash } from "crypto";

export function buildIdempotencyKey(
  interactionId: string,
  templateId: string,
  windowStart: string,
  resendKey?: string,
): string {
  const scope = resendKey
    ? `${interactionId}:${templateId}:${windowStart}:resend:${resendKey}`
    : `${interactionId}:${templateId}:${windowStart}`;
  return createHash("sha256").update(scope).digest("hex").slice(0, 32);
}

export function localPendingSid(idempotencyKey: string): string {
  return `LP${idempotencyKey}`;
}

export function hourWindowStart(iso?: string): string {
  const date = iso ? new Date(iso) : new Date();
  date.setMinutes(0, 0, 0);
  return date.toISOString();
}

export function fakeTwilioSid(prefix: string, seed: string): string {
  return `SM${prefix}${createHash("sha256").update(seed).digest("hex").slice(0, 30)}`;
}
