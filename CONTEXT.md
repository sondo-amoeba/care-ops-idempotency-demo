# Care-Ops Idempotency Demo — Glossary

Domain language for this repo. Implementation details live in code and ADRs under `docs/adr/`.

## Interaction

The root aggregate for one patient touchpoint in a care program. Owns the unified thread bundle (care thread, voice session, booking) and all SMS messages for that episode.

## Care thread

Status badge for the overall SMS + voice episode tied to an interaction. Moves to `resolved` when the patient confirms via inbound YES.

## Voice session

Scheduled voice visit placeholder tied to an interaction. Moves to `completed` when the patient confirms via inbound YES.

## Booking

Appointment record tied to an interaction. Moves to `confirmed` when the patient replies YES and the scheduling eligibility rule is enabled.

## Inbound idempotency

Twilio-style webhook handler that upserts on `twilio_message_sid`. Replays update the existing row and return `duplicate: true` without inserting a second message.

## Outbound idempotency

Deterministic `idempotency_key` = hash(interaction + template + hour window). Outbox insert uses `ON CONFLICT DO NOTHING` so concurrent replays collapse to one row.

## Outbox

`sms_outbox` ledger row created before the outbound `sms_messages` row. The unique idempotency key is the dedupe authority for sends.

## Eligibility gate

`canContact()` check against program rules before outbound send or inbound YES confirmation. Rules are keyed by program, channel, and action (`outbound`, `scheduling`).

## Agent workflow trigger

Orchestrator-style API entry point that calls the same outbound send module as the care-agent UI — models mid-call SMS from an automated workflow.

## Status callback

Twilio delivery webhook path that updates an existing message row only. Never inserts a new message on late `delivered` / `failed` events.

## Replay storm

Demo scenario firing dozens of identical outbound triggers to prove duplicate delivery stays at one persisted row.

## Application code sample

(Inherited from resume-workspace `CONTEXT.md`.) Public runnable demo linked from job applications when a proprietary production story needs a reviewer-facing artifact. This repo is that artifact for Ellipsis/Solace care-ops SMS idempotency.
