# ADR-0006: Async outbox relay + retry/DLQ

**Status:** Accepted
**Date:** 2026-06-28

## Context

ADR-0001 established the ledger-first write contract: insert `sms_outbox` + `sms_messages` in one transaction, then call the carrier. In the current code that carrier call happens **inline in the same HTTP request** (`SmsService.sendOutbound` → `claimOutboundLedger` → `submitToCarrier`). This half-implements the transactional outbox pattern: the durable table exists, but the part that makes it valuable — out-of-band delivery — does not.

Inline submission has three production failure modes:

- **Crash window.** If the process dies after the ledger commit but before `markSubmitted`, the row is stranded `pending` with nothing to recover it. The outbox is durable but nothing drains it.
- **Carrier-latency coupling.** A slow or timing-out Twilio call blocks the request thread; carrier degradation becomes API degradation.
- **No carrier throttle.** Twilio enforces an account-level messages-per-second ceiling. Inline sends have no shared choke point — a burst (campaign, replay storm against distinct keys) submits as fast as requests arrive and earns 429s.

The scope for this ADR is the **interview-narrative win condition**: build the relay as the one fully-implemented scaling pillar; sketch coordinator-on-queue, horizontal HA, and compliance-as-design as roadmap (see README roadmap section).

## Decision

**Move carrier submission out of the request path.** `sendOutbound` becomes **write-only**: it claims the ledger (`pending`) and returns. The **relay** becomes the *sole* caller of the carrier.

### Relay mechanism — polling claim with `FOR UPDATE SKIP LOCKED`

A relay worker loop drains the outbox:

```sql
SELECT * FROM sms_outbox
WHERE status = 'pending' AND next_attempt_at <= now()
ORDER BY created_at
FOR UPDATE SKIP LOCKED
LIMIT :batch;
```

- Keeps **Postgres as the single source of truth** — no second ledger (BullMQ/Redis queue) that can diverge from the table via a dual-write, which is the exact problem the outbox pattern exists to kill.
- `SKIP LOCKED` gives **safe multi-worker concurrency** — N relay workers drain in parallel and provably never double-claim a row.
- `LISTEN/NOTIFY` is a **roadmap latency optimization** layered on top: `NOTIFY` on ledger insert wakes the relay on demand. The poll loop stays as the durable fallback — a missed `NOTIFY` must never strand a row.

### State machine

`pending → submitting → submitted → {delivered | failed}`, plus terminal `dead_letter`.

New columns on `sms_outbox`: `attempts` (int, default 0), `next_attempt_at` (timestamptz, default `now()`), `last_error` (text, null).

| Transition | Rule |
|------------|------|
| `pending → submitting` | In the claim transaction, before the carrier call (released from the lock for the call itself). |
| `submitting → submitted` | Carrier accepted; real `MessageSid` stored. |
| `submitting → pending` (retry) | **Retryable** carrier error (timeout, 429, 5xx): `attempts++`, `next_attempt_at = now() + backoff(attempts)` with jitter. |
| `submitting → dead_letter` | `attempts >= max` (5), **or** a **terminal** carrier error (4xx: invalid number, blocked). |
| `submitted → delivered/failed` | Status callback only (update-existing-row, per ADR-0001). |

### Reconciling automatic retry with ADR-0001's "no silent carrier retry"

ADR-0001 forbade silent carrier retry because submission was inline and a retry meant re-running the request. The relay refines, not contradicts, that rule:

- **Retryable** failures are retried automatically **under the same idempotency key** — same interaction + template + hour window, same intent. This preserves **exactly-once intent**; it is not a second clinical message.
- **Terminal** failures go straight to `dead_letter` — no retry, surfaced for human action.
- **Operator-initiated resend** still requires a **new `resendKey` scope** (ADR-0001 unchanged) — that is a *new* intent, not a retry of the same one.

So: retry the same key for transient carrier faults; never reuse a key to send a *different* message.

### At-least-once carrier boundary

If the relay submits to the carrier and crashes before writing `submitted`, restart finds a row in `submitting` and may re-submit → a duplicate handset message. This is the one place intra-system idempotency cannot help, because the duplicate occurs carrier-side.

- **v1 (built): bound the window.** A **reaper** re-queues `submitting` rows older than a timeout. We accept a rare carrier-side duplicate over a stranded clinical confirmation, and we state that tradeoff plainly.
- **Roadmap: push idempotency to the edge.** Twilio does not dedupe arbitrary keys natively; the reconciliation path would query the carrier for our `idempotencyKey` reference before re-submitting.

The system stays **exactly-once**; delivery to the carrier is **at-least-once** unless the carrier itself dedupes.

### Carrier MPS bucket

The relay owns a **Redis token-bucket** sized to the carrier's messages-per-second ceiling — distinct from the existing per-interaction limiter:

| Limiter | Invariant | Lives in |
|---------|-----------|----------|
| Per-interaction (`send:${interactionId}`, existing) | fairness / abuse — one thread can't spam one patient | request path |
| Global MPS bucket (new) | carrier contract — total send rate ≤ account MPS | relay |

When the bucket is empty the relay simply doesn't claim more this tick; rows stay `pending`, which is safe because the outbox is durable. The existing limiter's `INCR`-then-`EXPIRE` is two round-trips (a crash between them leaks a never-expiring key and wedges that interaction) — replaced with an atomic Lua script.

## Consequences

- **Crash-safe delivery.** Any `pending` row is eventually drained; any stranded `submitting` row is reaped. No row is lost to a process death.
- **Carrier isolation.** Carrier latency/outage no longer degrades the API; it just slows the drain.
- **Horizontal relay scaling** for free via `SKIP LOCKED`.
- **At-least-once to the carrier** is now an explicit, documented boundary rather than a silent assumption.
- **Demo** (extends the replay-storm hero, not a new surface): (1) the single accepted row walking `pending → submitting → submitted → delivered`; (2) two relay workers draining a backlog with `carrier_submits == distinct_keys`; (3) fault-injection (`SMS_SIMULATE_SUBMISSION_FAILURE`) kills a worker mid-`submitting`, reaper re-queues, row reaches `submitted` — and the demo honestly surfaces any at-least-once carrier duplicate.

## Alternatives considered

- **BullMQ / Redis queue after the outbox insert** — introduces a second source of truth and a dual-write (row inserted vs job enqueued) that can diverge; reintroduces the problem the outbox kills. Rejected as the primary mechanism; the queue is the right tool for *coordinator runs* (roadmap), not for the outbox drain.
- **`LISTEN/NOTIFY`-first (no poll)** — a dropped notification strands a row with no recovery. Kept as a latency add-on over the durable poll, not a replacement.
- **Keep inline submission, add a sweep for stuck rows** — leaves carrier-latency coupling and the crash window in the hot path; the sweep would race the inline submitter. Rejected.
