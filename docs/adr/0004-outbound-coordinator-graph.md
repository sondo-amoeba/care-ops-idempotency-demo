# ADR-0004: Outbound coordinator graph (LangGraph + HITL interrupt)

**Status:** Accepted (amended 2026-06-24)  
**Date:** 2026-06-24

## Context

The demo already proves idempotent SMS writes (ADR-0001, ADR-0002). To showcase agentic system engineering without bypassing those invariants, we need an LLM-driven **outbound coordinator** that proposes care-ops SMS actions and executes them only through the existing outbound path — after human approval and with full traceability.

Render free tier sleeps after idle; a coordinator run may pause at approval for minutes. In-memory graph state would not survive cold starts.

## Decision

- Implement the **outbound coordinator** as a LangGraph state machine with eight phases: `observe` → `plan` → `propose` → `await_approval` → (`execute` | `reject` | `ineligible`) → `audit`.
- Use LangGraph's **interrupt-before-execute** pattern at `await_approval`. Persist checkpoints via **Postgres checkpointer** on the existing Neon database (same `DATABASE_URL` as ADR-0003).
- Persist run metadata in `coordinator_runs`, structured proposals in `coordinator_proposals`, and an append-only `coordinator_trace_events` log for the UI activity panel.
- **Coordinator tools (v1):**
  - **observe** loads interaction bundle and invokes `retrieve_care_context` (shared RAG read).
  - **check_eligibility** wraps the eligibility gate before planning.
  - **execute** (post-approval only): `send_outbound_sms` → wraps `SmsService.sendOutbound` with `source: ai_coordinator`
- The LLM never sends during **plan**. Side effects flow only through the graph's **execute** node.
- **Pluggable coordinator model** behind the **plan** phase:
  - **Live (Gemini-only):** when `GEMINI_API_KEY` is set — single structured JSON call via `@google/generative-ai` (`gemini-2.0-flash` default, `GEMINI_MODEL` override). Observe output (bundle + RAG chunks) is passed as prompt context.
  - **Mock:** CI, no key, or `COORDINATOR_MODEL_MODE=mock` — deterministic state → proposal mapping; same graph path.
  - **Graceful fallback:** on Gemini error (429, timeout, bad JSON) → mock proposal for that run, `modelMode` recorded as `mock`, trace includes `liveAttempted: true`.
  - **Inbound coordinator runs** (router-sourced `RESCHEDULE` / `UNKNOWN`) stay deterministic — no Gemini on inbound signal type.
- **Deferred:** bounded ReAct tool loop (`get_interaction_state`, `list_messages` iteratively during plan) — observe already gathers context; tool loop adds latency and free-tier RPM cost without demo value in v1.
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
- CI runs the full graph in **mock** mode — no Gemini calls, no flaky network. Unit tests mock the Google SDK; one e2e asserts fallback path.
- Gemini free tier (Google AI Studio, no card) aligns with the $0 demo stack.
- The existing **workflow orchestrator** (`agent-workflow/trigger-sms`) remains as a deterministic non-LLM path for comparison and regression tests.

## Alternatives considered

- **OpenAI live adapter** — rejected for demo; no free tier; Gemini free tier sufficient for structured planning.
- **Bounded ReAct tool loop in v1** — deferred; observe pre-loads context; single structured call is enough for interview demo.
- **In-memory graph state** — breaks on Render cold start mid-approval.
- **Redis checkpointer** — already in stack for rate limits, but Postgres is the persistence authority for clinical-adjacent audit data; Neon is already provisioned.
- **LLM executes sends directly** — rejected; bypasses approval gate and eligibility re-check at execute time.
