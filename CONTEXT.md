# Care-Ops SMS Invariant Lab — Glossary

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

## Inbound thread resolution

How an inbound webhook attaches a message to the correct **Interaction** when Twilio sends `From`/`To`/`Body` but not `interactionId`.

| Mode | When | Behavior |
|------|------|----------|
| **Production path** | Twilio sandbox and operable-reference deploy | `From` (E.164) → lookup single **open** interaction for that phone + program line; SID upsert runs before routing |
| **Dev override** | Staging, Vitest fixtures | Optional `interactionId` in body or header — skips phone lookup for deterministic tests |

**Ambiguity rule:** multiple open threads for same phone → attach to most recent `last_activity_at`; log `interaction_resolution=ambiguous`; metric for ops review — never fork to two threads silently.

**Operable-reference cut:** one sandbox Twilio number maps to one `program_id`; org-wide number routing stays in the staff narrative only.

## Outbound idempotency

Deterministic `idempotency_key` = hash(interaction + template + hour window). Outbox insert uses `ON CONFLICT DO NOTHING` so concurrent replays collapse to one row.

## Outbound write contract

The ordering rule for operable-reference outbound sends: **ledger-first, carrier-second**. Dedupe wins in Postgres before any Twilio REST call; the carrier is never contacted until the outbox insert succeeds.

## Submission lifecycle

States an outbound SMS passes through after the write contract applies. Submission is **relay-owned** (ADR-0006): the request path writes `pending` and returns; the **Outbox relay** is the only caller of the carrier.

| State | Meaning |
|-------|---------|
| **pending** | Outbox + message rows exist locally; carrier not yet called. The relay's claim target. |
| **submitting** | Relay has claimed the row (`FOR UPDATE SKIP LOCKED`) and is mid carrier call. Stranded `submitting` rows are recovered by the **Reaper**. |
| **submitted** | Carrier accepted; real `MessageSid` stored |
| **submission_failed** | Legacy inline state (pre-relay). Under the relay, retryable carrier errors return to **pending** with backoff; terminal errors go to **dead_letter** |
| **dead_letter** | Terminal: `attempts` exhausted (5) or a non-retryable carrier error (4xx). Surfaced for human action — never silently dropped |
| **delivered** / **failed** | Terminal delivery states from status callback only (update-existing-row) |

**Retry vs resend (ADR-0006 amends ADR-0001):** the relay retries the **same idempotency key** for transient carrier faults — same intent, still exactly-once. An operator **Explicit resend** is a *new* intent and still requires a new `resendKey` scope. Retry the same key for faults; never reuse a key to send a different message.

## Explicit resend

A new carrier attempt after a **dead_letter** (or `submission_failed` legacy) row, or an intentional resend — requires a new idempotency scope (next hour window or operator-supplied resend key). Distinct from the relay's automatic **retry**, which reuses the same key for transient faults (same intent). An explicit resend is a *new* intent and never reuses the original key to hit the carrier twice.

## Outbox

`sms_outbox` ledger row created before the outbound `sms_messages` row. The unique idempotency key is the dedupe authority for sends.

## Outbox relay

The worker that drains the **Outbox** out-of-band and is the **sole caller of the carrier** (ADR-0006). Claims `pending` rows with `SELECT … FOR UPDATE SKIP LOCKED`, flips them to `submitting` in the claim transaction, then submits outside the lock. `SKIP LOCKED` lets N relays run concurrently and provably never double-claim a row. Postgres stays the single source of truth — no second queue.

The request path (`sendOutbound`) is **write-only**: it claims the ledger (`pending`) and returns. Carrier submission is the relay's job, never the request's.

**Autodrain is opt-in (default off).** In the lab the relay is driven explicitly — the **Drain outbox relay** step is part of the walkthrough so a reviewer watches a row go `pending → submitting → queued`. `OUTBOX_RELAY_AUTODRAIN=true` enables the background poll loop for a hands-off deployment; always off under tests.

_Roadmap:_ `LISTEN/NOTIFY` on ledger insert wakes the relay on demand; the poll loop remains the durable fallback so a dropped notification never strands a row.

_Avoid_: "outbox queue", "job worker" — it is a **relay** draining a ledger, not a queue consumer.

## At-least-once carrier boundary

The honest delivery limit (ADR-0006): the **system** is exactly-once, but **delivery to the carrier is at-least-once** unless the carrier itself dedupes. If the relay submits and crashes before writing `submitted`, the **Reaper** re-queues the row and it may re-submit — a duplicate handset message. We accept a rare carrier-side duplicate over a stranded clinical confirmation, and state that tradeoff plainly rather than pretend the SHA256 key reaches the handset.

_Roadmap:_ push idempotency to the edge — carry the `idempotencyKey` and reconcile against carrier history before re-submitting.

## Reaper

Sweep that recovers rows stranded in **submitting** (relay crashed mid carrier call). Re-queues rows older than a timeout back to `pending` for another claim. The recovery half of the **At-least-once carrier boundary**.

## Carrier MPS bucket

Redis token-bucket owned by the **Outbox relay**, sized to the carrier's account-level messages-per-second ceiling — **distinct** from the per-interaction limiter (ADR-0006).

| Limiter | Invariant | Lives in |
|---------|-----------|----------|
| Per-interaction (`send:${interactionId}`) | fairness / abuse — one thread can't spam one patient | request path |
| Carrier MPS bucket | carrier contract — total send rate ≤ account MPS | relay |

Empty bucket → relay claims nothing this tick; rows stay `pending` (safe, the outbox is durable). The per-interaction limiter's `INCR`-then-`EXPIRE` is two round-trips — a crash between them leaks a never-expiring key and wedges that interaction; replaced with an atomic Lua script.

## Eligibility gate

`canContact()` check against program rules before outbound send or inbound YES confirmation. Rules are keyed by program, channel, and action (`outbound`, `scheduling`).

## Flagged ambiguities

**Agent** is overloaded in this repo. Use the specific term below — never bare "agent" in design docs or UI copy.

| Term | Meaning |
|------|---------|
| **Care coordinator** | Human operator using the Next.js console |
| **Workflow orchestrator** | Deterministic API trigger (`agent-workflow/trigger-sms`) — not LLM-driven |
| **AI care coordinator** | LLM agent that observes interaction state, plans next steps, and proposes outbound actions |

## Workflow orchestrator

Deterministic API entry point that calls the same outbound send module as the care-agent UI — models mid-call SMS from an automated workflow. Formerly called "agent workflow trigger."

## AI care coordinator

LLM-driven agent that observes an **Interaction** bundle (care thread, voice session, booking, messages), plans the next care-ops action, and proposes an outbound SMS. Never sends directly — always stops at an **Approval gate**.

## Coordinator proposal

Structured output from the AI care coordinator: recommended action, draft SMS body, template key, rationale, and tool-call trace. Persisted until approved, rejected, or superseded.

## Approval gate

Mandatory human checkpoint before any AI-proposed outbound SMS executes. The care coordinator approves or rejects; only approval invokes the idempotent outbound path.

## Idempotent approve

The approve endpoint contract: `POST …/approve` is replay-safe per `runId`. First call wins a compare-and-swap on `proposal.status` (`pending` → `approved`) and executes send; replays and concurrent losers return **200** with the same `sendResult` (`duplicate: true` when outbox already won) — never a spurious 400. The outbox is the second line of defense, not the first.

## Coordinator run

One execution of the AI care coordinator against a single **Interaction**. Started manually from the console or automatically when a subscribed **Lifecycle signal** fires.

## Lifecycle signal

Domain event that may enqueue a coordinator run — e.g. voice session transitions to `completed`. Signals are subscribed, not polled.

## Coordinator graph

The staged workflow every **Coordinator run** passes through: observe → plan → propose → await approval → execute or reject → audit. Each stage is a distinct node with explicit inputs, outputs, and terminal conditions.

## Coordinator phase

One node in the **Coordinator graph**. Phases are named for their domain role — not for framework internals.

| Phase | Role |
|-------|------|
| **observe** | Load the interaction bundle |
| **plan** | Reason with read-only tools (eligibility, message history) |
| **propose** | Emit a structured **Coordinator proposal** |
| **await approval** | Interrupt — run pauses until the care coordinator acts |
| **execute** | On approve — idempotent outbound send |
| **reject** | On reject — terminal; proposal marked rejected |
| **ineligible** | Terminal when eligibility blocks the proposed action |
| **audit** | Finalize run status and trace |

**Resume rule:** If a pending proposal already exists for the interaction, a new run skips to **await approval** instead of re-planning.

**Duplicate rule:** If execute hits an existing outbox key, the run still reaches **audit** — `duplicate: true` is a valid outcome, not a failure.

## Coordinator model

Pluggable reasoning backend behind the **plan** phase. The **Coordinator graph** is identical regardless of which model is active.

| Adapter | When | Behavior |
|---------|------|----------|
| **Live** | `GEMINI_API_KEY` present | Gemini generates structured **Coordinator proposal** (template, body, rationale) from observe context |
| **Mock** | CI, no key, or Gemini unavailable | Deterministic state → proposal mapping; same graph path |

Live mode is **Gemini-only** in this repo — no OpenAI path. On quota or API errors during **plan**, fall back to **Mock** for that run: `modelMode` records `mock`, trace includes `liveAttempted: true` and the error reason. Graph continues to HITL.

The active adapter is visible to the care coordinator (mode badge in console).

## Coordinator tool

A capability the **plan** or **execute** phase may invoke. Tools wrap existing domain services — never raw DB access.

| Tool | Access | Wraps |
|------|--------|-------|
| `get_interaction_state` | read | Interaction bundle statuses |
| `check_eligibility` | read | Eligibility gate for an action |
| `list_messages` | read | SMS history for the interaction |
| `send_outbound_sms` | write | Idempotent outbound path — **execute** phase only, post-approval |

The LLM never receives write tools during **plan**. Side effects flow only through the graph's **execute** node.

## Coordinator run record

Persisted metadata for one graph execution: interaction, status, active **Coordinator model** adapter, and checkpoint reference for interrupt/resume.

## Coordinator trace

Append-only log of phase transitions and **Coordinator tool** invocations for a run. Powers the console activity panel — not ephemeral server logs.

**Live delivery:** SSE stream per run (`phase`, `tool`, `proposal`, `interrupt`, `complete` events) with poll fallback when the connection drops.

## Coordinator pane

Split-view UI region in the care-agent console: **Coordinator trace** timeline, proposal card with Approve/Reject, model mode badge, and trigger controls (**Run AI coordinator**, **Simulate visit ended**).

## Care ops supervisor

Top-level multi-agent router for this repo. **Deterministic** — maps signal type to specialist graph, no LLM. Inspects the triggering signal (lifecycle event, manual run, inbound message) and dispatches to outbound coordinator or inbound router.

## Outbound coordinator

Specialist graph (see **Coordinator graph**) for proposing idempotent outbound SMS after voice visits. Formerly "AI care coordinator" in early design — use **Outbound coordinator** when distinguishing from inbound routing.

## Inbound router

Specialist graph invoked after inbound idempotency succeeds on a **new** message (not a SID replay). Classifies **Patient intent** and routes to deterministic handlers or an outbound proposal for HITL.

## Patient intent

Classification label for an inbound SMS body. Router output — not stored on the message row unless audit requires it.

| Intent | Route |
|--------|-------|
| **CONFIRM** | `confirmFromInbound()` when scheduling eligibility passes |
| **RESCHEDULE** | Outbound **Coordinator proposal** for HITL |
| **OPT_OUT** | Terminal — log only, no outbound |
| **UNKNOWN** | Coordinator proposal flagged for human review |

**Replay rule:** SID duplicate → return before supervisor/inbound router runs.

## Care context retrieval

RAG layer that fetches program and episode-scoped snippets before specialist graphs plan. Invoked via shared `retrieve_care_context` tool in each specialist's **observe** phase — not a separate conversational agent.

**Store:** `care_context_chunks` in Postgres with pgvector embeddings, scoped by `program_id`.

**Embeddings:** Deterministic hash vectors in all environments (CI and production). No embedding API — keeps RAG $0-aligned; three seed chunks make semantic ranking unnecessary.

**Seed chunks:** Synthetic program policies (confirm window, reschedule HITL rule, opt-out handling) — no PHI.

## Demo depth tiers

| Tier | What interview walkthrough shows |
|------|----------------------------------|
| **Tier 1 (5 min)** | Outbound coordinator + approval + replay storm idempotency |
| **Tier 2 (stretch)** | Inbound router classifies non-YES reply; SSE trace animates live |
| **Tier 3 (architecture)** | Supervisor dispatch, RAG retrieval chunks visible in trace — promoted into walkthrough steps 5–6, not buried in Stretch demo |
| **Tier 4 (if asked)** | Completed call report edit — Vapi webhook → HITL edit → audit; second workflow in repo, not part of the 5-min hero |

**Demo scope rule**

This repo is one **Ellipsis care-ops platform** artifact: **SMS orchestration** is the default hero walkthrough; **Completed call edit** is a secondary workflow surfaced only when a reviewer asks (Tier 4). Do not split into separate repos.

**Enhancement build order**

Planned SMS depth work, in sequence: (1) Tier 2/3 walkthrough + supervisor/inbound graphs + scheduling loop → (2) **Voice workflow phase** labels on orchestrator triggers → (3) **ReAct plan loop** in coordinator plan. Tier 4 Vapi edit after SMS depth is complete.

## Console experience

**Care coordinator console**

The Next.js UI where a **Care coordinator** reviews patient episodes, approves AI-proposed SMS, and monitors message activity. Primary audience is a cold reviewer, not an engineer reading API docs.

**Guided invariant walkthrough**

The default first-run narrative on the console: voice visit ends → **AI care coordinator** proposes follow-up SMS → **Care coordinator** approves → replay storm proves idempotency. Tier 1 only; copy and layout lead with this story.

_Avoid_: "Demo walkthrough" in UI copy — use **Guided invariant walkthrough**

**Demo walkthrough**

Deprecated label — same as **Guided invariant walkthrough**. Rename in UI and docs.

**Walkthrough tier rows**

Tier 1 (steps 1–4) is always visible — the 5-min EM pitch. Tier 2 (steps 5–6) unlocks after step 4 completes — bidirectional orchestration labeled *continue if time*. Never six equal-weight steps on first load.

_Avoid_: Showing all six steps with equal prominence on cold load

**Architecture lab**

Secondary console region for implementation probes — manual outbound send, workflow orchestrator trigger, webhook replays, eligibility toggles. Visible but visually subordinate to the **Guided invariant walkthrough**; never competes for attention on first load.

_Avoid_: "Developer mode", "advanced settings" (implies product config, not demo depth)

**Stretch lab**

Optional Tier 2 controls on the console — lifecycle trigger, inbound patient reply, delivery status callback. Collapsed by default beneath the **Guided invariant walkthrough**; expands for reviewers who want the full stack narrative.

_Avoid_: "Stretch demo"

**Walkthrough step**

One numbered stage in the **Guided invariant walkthrough**. Steps are visually highlighted in order but never hard-locked — reviewers may skip ahead. Tier 1: start episode → AI proposes SMS → care coordinator approves → replay storm. Tier 2/3 (planned): patient confirms YES → patient requests reschedule (supervisor + inbound router graphs).

## Voice workflow phase

When a **Workflow orchestrator** trigger fires relative to a **Voice session** — `pre_call`, `mid_call`, or `post_call`. Labels the same idempotent outbound path; mirrors Sage/Vapi agent workflow timing from Ellipsis production.

_Avoid_: "agent phase", "call stage" — use **Voice workflow phase**

## ReAct plan loop

Bounded tool-use during the outbound coordinator **plan** phase — iteratively invokes read-only **Coordinator tools** (`get_interaction_state`, `list_messages`) before emitting a **Coordinator proposal**. Deferred in ADR-0004 v1; planned demo enhancement with trace events per tool round.

## Console visualization

**Coordinator graph view**

Primary hero visualization during walkthrough steps 2–3. An animated rendering of the **Coordinator graph** that advances in sync with **Coordinator trace** SSE events — nodes highlight, tool calls branch off, **Approval gate** pulses at interrupt.

Rendered with **React Flow** — read-only node layout mirroring the fixed **Coordinator graph** topology; trace events drive active-node highlighting and edge animation. Not an editor; reviewers cannot rearrange nodes.

**Replay storm view**

Primary hero visualization during walkthrough step 4. Replaces the **Coordinator graph view** in the same panel — animates 50 concurrent trigger attempts collapsing to one persisted outbound row. Proves **Outbound idempotency** visually, not just in metrics text.

Style: **literal counter** — 50 staggered attempt ticks driven by real API results; duplicates flash amber and collapse; one accepted row locks green; final frame shows accepted/blocked ratio tied to activity log numbers.

_Avoid_: Abstract particle or funnel-only animations disconnected from outbox row counts

**Visualization handoff**

The console swaps hero views by **Walkthrough step**: graph view (steps 2–3) → storm view (step 4). One spectacle region; no competing animated panels on screen at once.

**Trace event log**

Collapsed monospace list beneath the hero visualization. Same **Coordinator trace** events as today — expandable for observability drill-down. Subordinate to the React Flow graph; not removed.

**Ops theater panel**

Dark slate hero region (`#0f172a`) housing **Coordinator graph view** or **Replay storm view**. Contrasts with the light **Care coordinator console** — draws reviewer attention to animated infrastructure visuals without a full dark-mode rework.

## Status callback

Twilio delivery webhook path that updates an existing message row only. Never inserts a new message on late `delivered` / `failed` events.

## Trust zone

An auth boundary that maps an actor type to a credential class. Operable reference uses three zones — never one shared secret for all routes.

| Zone | Actor | Credential |
|------|-------|------------|
| **Partner webhook** | Twilio | Request signature on `/webhooks/twilio/*` |
| **Orchestrator** | Workflow orchestrator, lifecycle automation | Service token on programmatic send/trigger paths |
| **Care coordinator** | Human operator in the console | Coordinator JWT on reply, approve/reject, thread read, eligibility admin |

Orchestrator and care-coordinator zones both invoke the same idempotent outbound module — auth differs; write path does not.

## Replay storm

Demo scenario firing dozens of identical outbound triggers to prove duplicate delivery stays at one persisted row.

## Duplicate attempt rate

SLO numerator/denominator for the **idempotency layer**: blocked outbox conflicts (`ON CONFLICT DO NOTHING`) over total send attempts. Proves replay collapse — replay storm and CI gate metric. A spike here signals bad client retry policy, not necessarily patient-facing duplicate texts.

## Duplicate delivery rate

SLO numerator/denominator for **carrier truth**: outbound rows with two distinct real MessageSids for the same clinical intent (same interaction + template + hour window) over total carrier-delivered messages. Target **under 0.1%** (T-M2). Page-worthy — actual program failure.

## SLO reconcile

Scheduled job comparing local outbox/message rows against Twilio sandbox REST history to compute **duplicate delivery rate**. Writes snapshots for dashboard audit; complements real-time **duplicate attempt rate**.

## Completed call edit

Secondary Tier 4 workflow in this repo — mirrors Ellipsis Vapi HITL edit: webhook ingests a completed voice call report, care coordinator reviews and edits before submit, audit trail preserved. Shares the same platform (**Interaction** bundle) but is not part of the SMS hero walkthrough.

_Avoid_: "Vapi demo", "voice edit tab" in glossary — use **Completed call edit**

## Public invariant lab

Public rebuild of production write-path invariants from Ellipsis care-ops SMS — runnable because the HIPAA-bound codebase cannot be open-sourced. Serves two jobs: (1) **Interview proof** — a cold reviewer can verify idempotency claims in five minutes; (2) **Reference implementation** — appendix to blog and talks teaching replay-safe agentic care-ops.

## Operable reference

The elevated state of the **Public invariant lab** — still sanitized (no PHI), but production-operable: migrations, ledger-first Twilio sandbox, split **Trust zones**, tiered SLOs with reconcile, idempotent approve, production-style **Inbound thread resolution**, runbook, and CI gates. Distinct from a deployable multi-tenant SaaS or from private Ellipsis production code.

## Staff narrative pack

Written Track-2 artifacts that prove platform and ops ownership without overclaiming private production code: `interaction-id` platform RFC, org-scale rollout phases, on-call runbook, and lab↔production mapping in README — synced to interview prep terminology.

**Public one-liner (balanced):** Clinical SMS fails when retries duplicate — agents make that worse. Public rebuild of the invariants shipped at Ellipsis: dedupe first, intelligence second.

Employer names (e.g. Solace) belong in application materials, not in repo branding.

_Avoid_: "demo app", "portfolio project", "toy" — use **Public invariant lab** or **reference architecture**

## Application code sample

(Synonym for **Public invariant lab** in resume-workspace harness docs.) Linked from job applications when a proprietary production story needs a reviewer-facing artifact.
