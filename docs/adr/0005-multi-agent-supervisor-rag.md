# ADR-0005: Multi-agent supervisor, inbound router, and pgvector RAG

**Status:** Accepted  
**Date:** 2026-06-24

## Context

ADR-0004 adds an outbound coordinator for post-visit SMS proposals. Production care-ops is bidirectional: patients reply with confirmations, reschedule requests, and opt-outs. ADR-0002 dedupes inbound webhooks on MessageSid but today uses a regex (`isConfirmationBody`) for side effects — it cannot handle "can we do Thursday?" or route opt-outs.

The expanded demo must also showcase multi-agent orchestration and RAG without turning the 5-minute interview walkthrough into a kitchen sink. Supervisor routing, inbound classification, and retrieval should be **real in code and tests** but narrated only when asked (Tier 3).

## Decision

### Care ops supervisor (deterministic router)

- Add a top-level **care ops supervisor** that dispatches to specialist LangGraph subgraphs by **signal type** — no LLM at the supervisor layer.
  - `lifecycle` / `manual` → **outbound coordinator** (ADR-0004)
  - `inbound` (new message, post-SID-upsert) → **inbound router**
- Inbound signals are enqueued only after ADR-0002 idempotency succeeds on a **new** SID. Replays return `duplicate: true` before the supervisor runs — intelligence never precedes idempotency.

### Inbound router specialist

- Implement a separate LangGraph subgraph: `observe` → `retrieve_care_context` → `classify` → route.
- Classify inbound body into **patient intent** with four labels:
  - `CONFIRM` → `confirmFromInbound()` when scheduling eligibility passes (same path as today)
  - `RESCHEDULE` → create outbound coordinator proposal for HITL
  - `OPT_OUT` → terminal audit only; no outbound
  - `UNKNOWN` → coordinator proposal flagged for human review
- Use the same live/mock model adapter pattern as ADR-0004 for `classify`.
- Reuse ADR-0004 proposal, approval, and execute machinery for intents that need HITL (`RESCHEDULE`, `UNKNOWN`).

### RAG as shared retrieval tool (not a conversational agent)

- Add `retrieve_care_context(query, program_id, k=3)` as a shared read tool invoked in each specialist's `observe` phase.
- Store synthetic program policy chunks in `care_context_chunks` with **pgvector** embeddings on existing Neon Postgres — scoped by `program_id`, no PHI.
- Seed chunks cover confirm-window policy, reschedule HITL rule, and opt-out handling.
- **Live embeddings:** OpenAI `text-embedding-3-small`.
- **Mock embeddings:** deterministic hash → fixed vector so CI retrieval is reproducible without API calls.
- Log retrieved chunk IDs and scores in `coordinator_trace_events` (visible in Tier 3; collapsed by default in UI).

### Demo depth tiers (scope boundary)

| Tier | In interview walkthrough |
|------|--------------------------|
| 1 | Outbound coordinator + approval + replay storm |
| 2 | Inbound non-YES message → proposal; SSE trace |
| 3 | Supervisor dispatch, RAG chunks in trace — architecture on request |

Explicitly **out of scope:** LLM supervisor routing, multi-agent peer swarms, real Twilio/OpenAI in CI, patient-level vector memory across episodes, separate `/coordinator` page.

## Consequences

- Inbound intelligence is additive to ADR-0002 — SID replay safety is preserved and testable independently of classification.
- Two specialist subgraphs + shared RAG demonstrate multi-agent shape without a third "chatty" retrieval agent that is hard to demo.
- pgvector on Neon adds extension + migration work but avoids a second vector host; stays on the $0 stack.
- Replacing regex confirmation with LLM classification in live mode introduces model risk for `CONFIRM`; mock mode and structured output constraints mitigate CI; `CONFIRM` still flows through the same `confirmFromInbound` deterministic handler.
- Inbound + outbound graphs share proposal/HITL tables — simpler persistence but couples specialists at the approval layer (acceptable for demo scope).

## Alternatives considered

- **LLM-driven supervisor** — extra latency and cost to route signals whose destination is already known from type.
- **RAG as a third conversational agent** — impressive on paper; poor 5-minute demo ergonomics.
- **Upstash Vector / separate vector DB** — new infra; rejected for $0-minimal stack.
- **In-memory / keyword-only retrieval** — not defensible as RAG in architecture interviews.
- **Inbound routing without supervisor** — works for two graphs but loses the multi-agent orchestration story and scatters dispatch logic across webhook handlers.
- **ESCALATE intent (clinical urgency)** — deferred; four intents are sufficient for v1 without new terminal alert infrastructure.
