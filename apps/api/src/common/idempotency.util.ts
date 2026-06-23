import { createHash } from "crypto";

export function buildIdempotencyKey(
  interactionId: string,
  templateId: string,
  windowStart: string,
): string {
  return createHash("sha256")
    .update(`${interactionId}:${templateId}:${windowStart}`)
    .digest("hex")
    .slice(0, 32);
}

export function hourWindowStart(iso?: string): string {
  const date = iso ? new Date(iso) : new Date();
  date.setMinutes(0, 0, 0);
  return date.toISOString();
}

export function fakeTwilioSid(prefix: string, seed: string): string {
  return `SM${prefix}${createHash("sha256").update(seed).digest("hex").slice(0, 30)}`;
}
