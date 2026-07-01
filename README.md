# Care-Ops SMS Invariant Lab

[![CI](https://github.com/sondo-amoeba/care-ops-idempotency-demo/actions/workflows/ci.yml/badge.svg)](https://github.com/sondo-amoeba/care-ops-idempotency-demo/actions/workflows/ci.yml)

Clinical SMS fails when retries duplicate — agents make that worse. This is a **public rebuild** of the write-path invariants I shipped at Ellipsis Health (HIPAA-bound production code cannot be open-sourced): dedupe first, intelligence second.

**Live lab:** https://care-ops-idempotency-demo.vercel.app _(UI on Vercel — wire API via [Deploy](#deploy-vercel--render--0mo) below)_

**Repository:** https://github.com/sondo-amoeba/care-ops-idempotency-demo

## Problem

Clinical care-ops programs send two-way SMS around voice visits (confirmations, scheduling, follow-ups). Twilio webhooks, queue workers, and human retries all replay the same events. Without idempotent write paths, duplicate texts erode patient trust — in healthcare, a second “your appointment is tomorrow” message is a program failure, not a nuisance.

Production code was private. This repo shows the **invariants and architecture** I shipped against: unified interaction threads, inbound SID upserts, outbound idempotency keys, update-only status callbacks, eligibility gates, orchestrator-style agent triggers, and an **agentic outbound coordinator** (LangGraph + human approval + idempotent execute).

## What I built

| Capability | Where to see it |
|------------|-----------------|
| **Unified thread model** | `interaction_id` links care thread, voice session, booking, and SMS messages |
| **Inbound idempotency** | Twilio webhook upsert on `twilio_message_sid` (UNIQUE) — replays return `duplicate: true` |
| **Outbound idempotency** | SHA256 key over interaction + template + hour window (+ optional `resendKey`); write-only request path claims a transactional outbox + message `pending` |
| **Async outbox relay** | Sole carrier caller (ADR-0006): `FOR UPDATE SKIP LOCKED` drain, backoff retry, dead-letter, reaper for stranded `submitting` rows, carrier-MPS token bucket — **Drain outbox relay** in UI + shell + Vitest |
| **Status callbacks** | Update-only — no new rows on late delivery events; **Simulate delivery callback** in UI |
| **Eligibility gates** | `canContact()` before outbound send; scheduling rule gates inbound YES → confirm |
| **Inbound orchestration** | Patient replies YES → booking confirmed, voice completed, thread resolved |
| **Agent workflow API** | Deterministic orchestrator trigger reuses the same outbound path as care-agent send |
| **AI outbound coordinator** | LangGraph graph + Postgres checkpointer + approval gate; mock/live model adapters |
| **Inbound intent router** | Classifies reschedule/confirm/opt-out; routes to HITL proposal or `confirmFromInbound` |
| **RAG policy retrieval** | pgvector chunks surfaced in coordinator trace (`retrieve_care_context`) |
| **Replay storm** | 50 identical triggers → 1 outbound row (UI button + shell script + Vitest) |
| **Care-agent UI** | Next.js console + **AI Coordinator pane** (trace SSE, approve/reject, lifecycle trigger) |

**Stack:** NestJS · TypeORM · PostgreSQL (pgvector) · Redis · LangGraph · Next.js · Tailwind

## Architecture

```
Browser
  → Next.js (Vercel) — Care Agent Console + AI Coordinator pane
       ↓ runtime proxy /care-ops/* and /webhooks/*
  → NestJS API (Render free)
       ↓
  PostgreSQL (Neon) + pgvector          Redis (Upstash)
       │                                        │
  interactions · sms_outbox · coordinator_*    rate limits · carrier MPS bucket
  care_context_chunks · LangGraph checkpoints
       ↑ relay drains (FOR UPDATE SKIP LOCKED), sole carrier caller
```

**Inbound path:** `POST /webhooks/twilio/inbound` → SID upsert → supervisor → inbound router (intent)  
**Outbound write path (request):** eligibility → rate limit → transactional outbox + message (`pending`) → return  
**Outbound delivery path (relay, ADR-0006):** `SKIP LOCKED` claim → `submitting` → MPS gate → carrier → `submitted`/retry/`dead_letter`; reaper recovers stranded rows  
**Coordinator path:** LangGraph observe → RAG → plan → propose → **HITL approve** → idempotent execute (write-only; relay delivers)  
**Legacy agent path:** `POST /care-ops/agent-workflow/trigger-sms` → same outbound module (non-LLM)

See [docs/adr/](./docs/adr/) for decision records (outbox dedupe, inbound SID upsert, split-stack deploy, coordinator graph, multi-agent + RAG, async outbox relay).

## Guided invariant walkthrough (5 minutes)

### Tier 1 — Idempotency + agentic outbound (interview default)

1. Open the live URL (or local UI at http://localhost:3000).
2. **New care thread** — creates interaction + thread + voice + booking bundle.
3. **Run AI coordinator** (right pane) — trace fills; proposal appears (`awaiting_approval`).
4. **Approve** — one outbound SMS via `ai_coordinator` source (idempotent outbox).
5. **50× replay storm** — activity log shows duplicates blocked; metrics show 1 outbound row.

### Tier 2 — Full stack (stretch)

6. **Simulate visit ended** — lifecycle signal auto-starts coordinator run.
7. **Replay inbound webhook** — YES → badges move to confirmed/completed/resolved.
8. Change inbound body to `"can we move to Thursday?"` → inbound router proposes reschedule (HITL).
9. **Simulate delivery callback** — same row updates to `delivered` (no duplicate insert).
10. **Disable outbound eligibility** — coordinator run → `ineligible`; re-enable and retry.

## Local setup

```bash
git clone https://github.com/sondo-amoeba/care-ops-idempotency-demo.git
cd care-ops-idempotency-demo
cp .env.example .env
cp apps/web/.env.example apps/web/.env.local
pnpm install
bash scripts/start-local-services.sh    # Docker if available, else micromamba
```

`start-local-services.sh` starts Postgres (port **5433**) and Redis (port **6380**). It prefers **Docker Compose** when the daemon is reachable; otherwise it uses a **micromamba** env (`careops`) with PostgreSQL, pgvector, and redis-server — no sudo required.

```bash
# Force a backend
bash scripts/start-local-services.sh docker
bash scripts/start-local-services.sh micromamba
bash scripts/start-local-services.sh status
bash scripts/start-local-services.sh stop
```

After start, export the env vars the script prints (or use Docker Compose directly):

```bash
export POSTGRES_HOST=127.0.0.1 POSTGRES_PORT=5433 POSTGRES_USER=careops \
  POSTGRES_DB=careops_demo REDIS_URL=redis://localhost:6380
```

**Terminal 1 — API (:3001):**

```bash
pnpm --filter @care-ops/api dev
```

**Terminal 2 — UI (:3000, proxies API via rewrites):**

```bash
pnpm --filter @care-ops/web dev
```

Open http://localhost:3000

## Run locally on a Mac over Tailscale (ADR-0008)

A tailnet-private personal instance: the whole stack runs on your Mac and is reachable from your own devices (phone, iPad, second laptop) over the tailnet — no public URL, no cloud free tiers. Because the browser only calls same-origin paths and Next.js proxies to the API server-side, **only the web origin (`:3000`) is exposed**; Postgres, Redis, and the API stay bound to the Mac. See [ADR-0008](./docs/adr/0008-local-tailnet-dev-instance.md) for the rationale and rejected alternatives.

**Prereqs:** OrbStack (or Docker Desktop), Node + pnpm (`corepack enable`), Tailscale. In the Tailscale admin console, enable **MagicDNS** and **HTTPS Certificates**.

```bash
cp .env.example .env
cp apps/web/.env.example apps/web/.env.local     # API_PROXY_URL=http://localhost:3001
bash scripts/up-mac.sh          # datastores + prod build + start api/web + tailscale serve --bg
bash scripts/up-mac.sh --awake  # same, but caffeinate for lid-closed access
bash scripts/up-mac.sh status   # api/web pids, docker ps, serve status
bash scripts/up-mac.sh stop     # stop api/web (datastores + serve left running)
bash scripts/up-mac.sh logs     # tail api + web logs
```

Then open `https://<mac>.<tailnet>.ts.net` from any device on your tailnet.

- The exposed instance runs the **prod build** (`next start`) so it avoids Next 15's dev-server cross-origin check on `/_next/*` (the `Host` over Tailscale is the `*.ts.net` name, not `localhost`). When actively coding **on the Mac**, use `pnpm --filter @care-ops/web dev` at `localhost:3000` instead — HMR, no cross-origin issue.
- The `micromamba` fallback in `start-local-services.sh` is `linux-64`-only; on the Mac use the Docker path above.
- Coordinator stays `mock` by default (set `GEMINI_API_KEY` for live planning); no on-device LLM.

## Tests

Requires Postgres + Redis (`bash scripts/start-local-services.sh`):

```bash
pnpm test
bash scripts/replay-storm.sh   # API must be running on :3001 for shell script
```

Vitest covers inbound SID replay, outbound dedupe, **concurrent parallel sends**, write-only request path + resendKey, YES confirmation orchestration, 100× agent-workflow storm, **async outbox relay** (two-worker `SKIP LOCKED`, retry/backoff, dead-letter, reaper, carrier-MPS throttle), **coordinator graph + HITL + Gemini fallback**, inbound intent routing, RAG trace events, and Gemini planner unit tests (34 tests).

Set `COORDINATOR_MODEL_MODE=mock` (default when no `GEMINI_API_KEY`) for deterministic CI. Optional `GEMINI_API_KEY` from [Google AI Studio](https://aistudio.google.com/apikey) enables live Gemini planning (free tier, no card).

## CI/CD

**Option C (hybrid):** GitHub Actions owns quality gates; platforms own deploy.

| Layer | Trigger | Mechanism |
|-------|---------|-----------|
| **CI** | Every PR + push to `main` | [`.github/workflows/ci.yml`](.github/workflows/ci.yml) — Postgres + Redis service containers, `pnpm test`, build API + web |
| **CD — API** | Push to `main` | [Render](https://render.com/) free web service (Docker), root `apps/api` — see [`render.yaml`](render.yaml) |
| **CD — Web** | Push to `main` | [Vercel](https://vercel.com/) GitHub integration, root `apps/web` |
| **Keep-warm** | Every 10 min | [`.github/workflows/keep-warm.yml`](.github/workflows/keep-warm.yml) — avoids Render cold starts |

**Branch protection (recommended):** require CI status check before merge to `main`. Deploy runs only after green CI.

No deploy secrets in GitHub — `DATABASE_URL`, `REDIS_URL` on Render; `API_PROXY_URL` on Vercel. **Total cost: $0/mo** (Vercel + Render + Neon + Upstash free tiers).

## Docker (full stack)

```bash
docker compose up --build
```

- UI: http://localhost:3000  
- API: http://localhost:3001  

## API reference

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/care-ops/interactions` | Create thread bundle |
| GET | `/care-ops/interactions` | List recent interactions |
| GET | `/care-ops/interactions/:id` | Thread detail + messages |
| POST | `/care-ops/interactions/:id/lifecycle/voice-completed` | Voice completed + coordinator run |
| POST | `/care-ops/sms/send` | Care-agent outbound |
| POST | `/care-ops/agent-workflow/trigger-sms` | Deterministic orchestrator trigger |
| POST | `/care-ops/coordinator/runs` | Start AI coordinator run |
| GET | `/care-ops/coordinator/runs/:id` | Run detail + checkpoint status |
| GET | `/care-ops/coordinator/runs/:id/trace` | Coordinator trace events |
| GET | `/care-ops/coordinator/runs/:id/stream` | SSE trace stream |
| POST | `/care-ops/coordinator/runs/:id/approve` | HITL approve → idempotent send |
| POST | `/care-ops/coordinator/runs/:id/reject` | HITL reject |
| POST | `/webhooks/twilio/inbound` | Simulated inbound webhook |
| POST | `/webhooks/twilio/status` | Delivery status callback |
| GET/POST | `/care-ops/eligibility/rules` | List / toggle rules |
| GET | `/care-ops/metrics/duplicates` | Duplicate stats |

## Deploy (Vercel + Render — $0/mo)

Split stack — same reviewer pattern as the [Glade bankruptcy demo](https://github.com/sondo-amoeba/bankruptcy-intake-triage): **Vercel for the public URL**, managed Postgres + Redis on free tiers, NestJS API on Render free (Docker).

| Service | Provider | Tier | Cost |
|---------|----------|------|------|
| Web | Vercel | Hobby | $0 |
| API | Render | Free web service | $0 |
| Postgres | Neon | Free | $0 |
| Redis | Upstash | Free | $0 |

### 1. Postgres (Neon)

1. [neon.tech](https://neon.tech) → new project → copy `DATABASE_URL`.

Do **not** use Render's free Postgres — it expires after ~30 days.

### 2. Redis (Upstash)

1. [upstash.com](https://upstash.com/) → new Redis database → copy `REDIS_URL`.
2. Vercel marketplace integration also works.

### 3. API on Render

**Option A — Blueprint (recommended)**

1. [render.com](https://render.com/) → **New → Blueprint** → connect `sondo-amoeba/care-ops-idempotency-demo`.
2. Render reads [`render.yaml`](render.yaml) — creates `care-ops-api` web service (Docker, free plan).
3. In the dashboard, set sync'd secrets:
   - `DATABASE_URL` — Neon connection string
   - `REDIS_URL` — Upstash URL
4. Deploy → copy the public URL (e.g. `https://care-ops-api.onrender.com`).

**Option B — Manual web service**

1. **New → Web Service** → connect repo.
2. **Root Directory:** `apps/api`
3. **Runtime:** Docker
4. **Instance type:** Free
5. Same env vars as above (`API_PORT=3001`, `NODE_ENV=production` are in `render.yaml` defaults).

TypeORM migrations apply schema on first boot (`migrationsRun: true`).

**Render free caveat:** services spin down after 15 min idle (~30–60s cold start). The [`keep-warm`](.github/workflows/keep-warm.yml) workflow pings every 10 min once the API is wired.

### 4. Web on Vercel

1. Import repo → connect GitHub `sondo-amoeba/care-ops-idempotency-demo` (Settings → Git if auto-link failed).
2. **Root Directory:** `apps/web`
3. **Install Command:** `cd ../.. && pnpm install`
4. **Build Command:** `pnpm build`
5. Environment variable:
   - `API_PROXY_URL` — Render API URL from step 3
6. Redeploy

Reviewers hit one URL; Next.js rewrites proxy `/care-ops/*` and `/webhooks/*` to the API.

**Note:** Do not use Vercel's experimental NestJS service — TypeORM decorators fail on serverless. Keep the API on Render.

### 5. Verify

Open https://care-ops-idempotency-demo.vercel.app → **New care thread** → **Run AI coordinator** → **Approve** → **50× replay storm**.

### Post-deploy

Keep-warm runs automatically on `main`. Disable it in Render dashboard if you suspend the API.

## Production scaling roadmap

Scaling this lab is gated on the **write path** first ("dedupe first, intelligence second"). The relay is the one fully-specified pillar; the rest are sketched as design, not built.

### Anchor — async outbox relay + retry/DLQ ([ADR-0006](./docs/adr/0006-async-outbox-relay.md)) — **built**

The request path is now **write-only**: it claims a durable `pending` outbox row and returns. A **relay** (`SELECT … FOR UPDATE SKIP LOCKED`) is the sole carrier caller — crash-safe, carrier-latency-isolated, horizontally scalable (N workers, no double-submit), with a backoff/dead-letter state machine, a **reaper** bounding the at-least-once carrier window, and a relay-owned **carrier MPS token-bucket**. Drive it from the **Drain outbox relay** button, `scripts/replay-storm.sh`, or the relay endpoints (`POST /care-ops/relay/drain|reap`, `GET /care-ops/relay/stats`). Covered by `test/relay.spec.ts` (happy path, two-worker `SKIP LOCKED`, retry→success, terminal + max-attempt dead-letter, reaper, MPS throttle). See glossary: **Outbox relay**, **Reaper**, **At-least-once carrier boundary**, **Carrier MPS bucket**.

### Roadmap (sketched, not built)

- **Coordinator on a queue.** LangGraph runs execute via in-process `graph.invoke` today. Move them onto a Redis-backed job queue (BullMQ) with concurrency caps and LLM timeout/retry/backpressure. The queue is the right tool *here* — coordinator runs are jobs — even though it would be the wrong tool for the outbox drain (see ADR-0006 alternatives). The Postgres checkpointer already makes runs durable across restarts.
- **Horizontal HA.** Make the API stateless and multi-instance: fan out **Coordinator trace** SSE over Redis pub/sub (in-process today), graceful drain on deploy. Rate limiting and checkpoints are already shared (Redis / Postgres).
- **Compliance-as-design.** TCPA opt-out (STOP → permanent suppression), quiet-hours gating, Twilio webhook signature validation (**Trust zone: partner webhook**), PHI-at-rest encryption + audit log. Presented as design here; signature validation is the most natural one to actually implement next.

## Tradeoffs and v1 cuts

- No auth, multi-tenant programs, or real Twilio signature validation (phase 3)
- No PHI, live Twilio REST, or HIPAA audit logging (phase 2 uses sandbox next)
- Eligibility is program-level (not per-patient opt-out table)
- NestJS monolith module layout (domain modules deferred)
- **Schema:** TypeORM migrations on boot (`migrationsRun: true`) — no `synchronize`
- **Outbound path:** ledger-first write contract — **write-only request path** claims a transactional outbox + message `pending`; the **async relay** (ADR-0006) is the sole carrier caller (simulated), with backoff retry, `dead_letter`, reaper, and a carrier-MPS bucket. Operator `resendKey` is a new intent (new key); relay retry reuses the same key
- **Carrier boundary:** system is exactly-once; delivery to the carrier is **at-least-once** (reaper bounds the duplicate window). Carrier-side reconciliation is roadmap, not built
- Coordinator uses **mock model** in CI and by default on Render (set `GEMINI_API_KEY` for live Gemini; `GEMINI_MODEL` optional, default `gemini-2.5-flash` with fallback chain)
- LangGraph + pgvector require Neon Postgres with `vector` extension enabled
- Sanitized fake Twilio SIDs — not a Twilio integration test

## Disclaimer

Fictional patient IDs only. Sanitized **public invariant lab** — not production Ellipsis code. No PHI, no live Twilio. Runnable reference architecture for replay-safe agentic care-ops SMS; you can verify the invariants in five minutes or read the ADRs and tests for depth.

## License

MIT
