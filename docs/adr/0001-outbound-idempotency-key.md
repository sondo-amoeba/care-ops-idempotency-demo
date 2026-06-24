# ADR-0001: Outbound idempotency via outbox + hour window

**Status:** Accepted  
**Date:** 2026-06-23

## Context

Agent workflows and care agents can trigger the same outbound SMS many times within seconds (retries, double-clicks, queue redelivery). We need duplicate delivery under 0.1% without distributed locks.

## Decision

- Compute `idempotency_key = SHA256(interaction_id + template_id + hour_window_start)` truncated to 32 hex chars.
- Insert into `sms_outbox` first with `INSERT … ON CONFLICT ("idempotencyKey") DO NOTHING`.
- Only the winning insert creates the `sms_messages` row.
- Hour window buckets retries within the same clinical outreach window while allowing a fresh reminder in the next hour.

## Consequences

- Concurrent replays are safe without application-level locks.
- Duplicate attempts return the existing outbox + message ( `duplicate: true` ).
- Fake Twilio SIDs are deterministic from the idempotency key for demo reproducibility.

## Alternatives considered

- Redis SETNX only — lost on eviction; not the persistence authority.
- Check-then-insert without conflict handling — race window under parallel requests.
