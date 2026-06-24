# ADR-0002: Inbound webhook upsert on MessageSid

**Status:** Accepted  
**Date:** 2026-06-23

## Context

Twilio retries inbound webhooks on timeout or 5xx. A naive insert creates duplicate inbound rows and can re-run side effects (e.g. booking confirmation).

## Decision

- Unique constraint on `sms_messages.twilio_message_sid`.
- On webhook receipt: lookup by SID; if found, update body/status and return `duplicate: true` without orchestration side effects.
- On first insert: optionally run inbound orchestration (YES → confirm booking) once.

## Consequences

- Replays are visible in API responses (`duplicate: true`) for demos and tests.
- Side effects (booking confirmation) run at most once per SID.

## Alternatives considered

- Idempotency-Key header — Twilio inbound webhooks use MessageSid as the natural key.
- Separate dedupe table — redundant when SID is already unique per message.
