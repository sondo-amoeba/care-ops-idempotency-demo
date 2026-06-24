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
| **Live** | `OPENAI_API_KEY` present | Real LLM planning, tool selection, and rationale |
| **Mock** | CI, or no API key | Deterministic state → proposal mapping; same graph path |

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

**Embeddings:** Live uses OpenAI `text-embedding-3-small`; mock uses deterministic hash vectors for CI.

**Seed chunks:** Synthetic program policies (confirm window, reschedule HITL rule, opt-out handling) — no PHI.

## Demo depth tiers

| Tier | What interview walkthrough shows |
|------|----------------------------------|
| **Tier 1 (5 min)** | Outbound coordinator + approval + replay storm idempotency |
| **Tier 2 (stretch)** | Inbound router classifies non-YES reply; SSE trace animates live |
| **Tier 3 (architecture)** | Supervisor dispatch, RAG retrieval chunks visible in trace — present in code/tests, not narrated unless asked |

## Status callback

Twilio delivery webhook path that updates an existing message row only. Never inserts a new message on late `delivered` / `failed` events.

## Replay storm

Demo scenario firing dozens of identical outbound triggers to prove duplicate delivery stays at one persisted row.

## Application code sample

(Inherited from resume-workspace `CONTEXT.md`.) Public runnable demo linked from job applications when a proprietary production story needs a reviewer-facing artifact. This repo is that artifact for Ellipsis/Solace care-ops SMS idempotency.
