# ADR-0004: Outbound coordinator graph (LangGraph + HITL interrupt)

**Status:** Accepted  
**Date:** 2026-06-24

## Context

The demo already proves idempotent SMS writes (ADR-0001, ADR-0002). To showcase agentic system engineering without bypassing those invariants, we need an LLM-driven **outbound coordinator** that proposes care-ops SMS actions and executes them only through the existing outbound path — after human approval and with full traceability.

Render free tier sleeps after idle; a coordinator run may pause at approval for minutes. In-memory graph state would not survive cold starts.

## Decision

- Implement the **outbound coordinator** as a LangGraph state machine with eight phases: `observe` → `plan` → `propose` → `await_approval` → (`execute` | `reject` | `ineligible`) → `audit`.
- Use LangGraph's **interrupt-before-execute** pattern at `await_approval`. Persist checkpoints via **Postgres checkpointer** on the existing Neon database (same `DATABASE_URL` as ADR-0003).
- Persist run metadata in `coordinator_runs`, structured proposals in `coordinator_proposals`, and an append-only `coordinator_trace_events` log for the UI activity panel.
- Expose exactly four **coordinator tools**:
  - Read (plan phase, ≤3 iterations): `get_interaction_state`, `check_eligibility`, `list_messages`
  - Write (execute phase only, post-approval): `send_outbound_sms` → wraps `SmsService.sendOutbound` with `source: ai_coordinator`
- The LLM never receives write tools during `plan`. Side effects flow only through the graph's `execute` node.
- **Pluggable coordinator model** behind the `plan` phase:
  - **Live** when `OPENAI_API_KEY` is set (structured outputs + tool calling, `gpt-4o-mini`)
  - **Mock** in CI and when no key is present (deterministic state → proposal mapping; same graph path)
- **Triggers:** manual API/UI action and **lifecycle signal** (voice session → `completed`).
- **Resume rule:** if a pending proposal exists for the interaction, a new run skips to `await_approval` instead of re-planning.
- **Duplicate rule:** if `execute` hits an existing outbox idempotency key, the run still reaches `audit` with `duplicate: true` — not an error.
- **Branch:** if `check_eligibility` blocks outbound during `plan`, route to `ineligible` terminal without proposing a send.
- Deliver trace events to the UI via **SSE** per run (`phase`, `tool`, `proposal`, `interrupt`, `complete`) with poll fallback when the connection drops.

## Consequences

- Agentic outbound coordination is demonstrable without weakening ADR-0001 outbox dedupe — replay storms through the coordinator still collapse to one row.
- Human-in-the-loop is structurally enforced (graph interrupt), not a UI convention — appropriate for healthcare outreach.
- Postgres checkpointer adds migration surface but reuses Neon; no new infra cost on the $0 stack.
- LangGraph introduces a framework dependency; graph topology and checkpoint schema are hard to reverse once shipped.
- CI runs the full graph in **mock** mode — no OpenAI calls, no flaky network.
- The existing **workflow orchestrator** (`agent-workflow/trigger-sms`) remains as a deterministic non-LLM path for comparison and regression tests.

## Alternatives considered

- **Single-shot LLM call** (state in → proposal out) — too thin to demonstrate agentic engineering; no tool trace.
- **Bounded ReAct without explicit phases** — workable but harder to demo and test than named phases with interrupt.
- **In-memory graph state** — breaks on Render cold start mid-approval.
- **Redis checkpointer** — already in stack for rate limits, but Postgres is the persistence authority for clinical-adjacent audit data; Neon is already provisioned.
- **LLM executes sends directly** — rejected; bypasses approval gate and eligibility re-check at execute time.
