# Care-Ops SMS Idempotency Demo

[![CI](https://github.com/sondo-amoeba/care-ops-idempotency-demo/actions/workflows/ci.yml/badge.svg)](https://github.com/sondo-amoeba/care-ops-idempotency-demo/actions/workflows/ci.yml)

Public runnable lab for **replay-safe care-ops SMS** — inspired by private HIPAA-bound production work at Ellipsis Health, rebuilt so engineering reviewers can click through without cloning.

**Live demo:** https://care-ops-idempotency-demo.vercel.app _(UI on Vercel — wire API via [Deploy](#deploy-vercel--render--0mo) below)_

**Repository:** https://github.com/sondo-amoeba/care-ops-idempotency-demo

## Problem

Clinical care-ops programs send two-way SMS around voice visits (confirmations, scheduling, follow-ups). Twilio webhooks, queue workers, and human retries all replay the same events. Without idempotent write paths, duplicate texts erode patient trust — in healthcare, a second “your appointment is tomorrow” message is a program failure, not a nuisance.

Production code was private. This repo shows the **invariants and architecture** I shipped against: unified interaction threads, inbound SID upserts, outbound idempotency keys, update-only status callbacks, eligibility gates, and orchestrator-style agent triggers.

## What I built

| Capability | Where to see it |
|------------|-----------------|
| **Unified thread model** | `interaction_id` links care thread, voice session, booking, and SMS messages |
| **Inbound idempotency** | Twilio webhook upsert on `twilio_message_sid` (UNIQUE) — replays return `duplicate: true` |
| **Outbound idempotency** | SHA256 key over interaction + template + hour window; `INSERT … ON CONFLICT DO NOTHING` on outbox |
| **Status callbacks** | Update-only — no new rows on late delivery events; **Simulate delivery callback** in UI |
| **Eligibility gates** | `canContact()` before outbound send; scheduling rule gates inbound YES → confirm |
| **Inbound orchestration** | Patient replies YES → booking confirmed, voice completed, thread resolved |
| **Agent workflow API** | Orchestrator trigger reuses the same outbound path as care-agent send |
| **Replay storm** | 50 identical triggers → 1 outbound row (UI button + shell script + Vitest) |
| **Care-agent UI** | Next.js console — create thread, send, replay, storm, toggle rules, activity log |

**Stack:** NestJS · TypeORM · PostgreSQL · Redis · Next.js · Tailwind

## Architecture

```
Browser
  → Next.js (Vercel) — Care Agent Console
       ↓ rewrites /care-ops/* and /webhooks/*
  → NestJS API (Render free)
       ↓
  PostgreSQL (Neon / Vercel Postgres)     Redis (Upstash)
       │                                        │
  interactions · care_threads · bookings       rate limits
  sms_messages · sms_outbox · eligibility_rules
```

**Inbound path:** `POST /webhooks/twilio/inbound` → upsert message by SID → optional YES orchestration  
**Outbound path:** eligibility → rate limit → outbox insert (conflict-safe) → message row  
**Agent path:** `POST /care-ops/agent-workflow/trigger-sms` → same outbound module as care-agent send

See [docs/adr/](./docs/adr/) for decision records (outbox dedupe, inbound SID upsert, split-stack deploy).

## Demo walkthrough (5 minutes)

1. Open the live URL (or local UI at http://localhost:3000).
2. **New care thread** — creates interaction + thread + voice + booking bundle.
3. **Care-agent send** — one outbound message (status `queued`).
4. **Simulate delivery callback** — same row updates to `delivered` (no duplicate insert).
5. **Replay inbound webhook** — twice with same SID → second call blocked; badges move to confirmed/completed/resolved.
6. **50× replay storm** — activity log shows 49 duplicates blocked, metrics show 1 outbound row.
7. **Disable outbound eligibility** — send fails with `403`; re-enable and retry.

## Local setup

```bash
git clone https://github.com/sondo-amoeba/care-ops-idempotency-demo.git
cd care-ops-idempotency-demo
cp .env.example .env
cp apps/web/.env.example apps/web/.env.local
docker compose up -d postgres redis
pnpm install
```

**Terminal 1 — API (:3001):**

```bash
export POSTGRES_PORT=5433 REDIS_URL=redis://localhost:6380
pnpm --filter @care-ops/api dev
```

**Terminal 2 — UI (:3000, proxies API via rewrites):**

```bash
pnpm --filter @care-ops/web dev
```

Open http://localhost:3000

## Tests

Requires Postgres + Redis (`docker compose up -d postgres redis`):

```bash
export POSTGRES_PORT=5433 REDIS_URL=redis://localhost:6380
pnpm test
bash scripts/replay-storm.sh
```

Vitest covers inbound SID replay, outbound dedupe, **concurrent parallel sends**, YES confirmation orchestration, and 100× agent-workflow storm.

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
| POST | `/care-ops/sms/send` | Care-agent outbound |
| POST | `/care-ops/agent-workflow/trigger-sms` | Orchestrator trigger |
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

TypeORM `synchronize: true` applies schema on first boot (demo only).

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

Open https://care-ops-idempotency-demo.vercel.app → **New care thread** → **50× replay storm**.

### Post-deploy

Keep-warm runs automatically on `main`. Disable it in Render dashboard if you suspend the API.

## Tradeoffs and v1 cuts

- No auth, multi-tenant programs, or real Twilio signature validation
- No PHI, live Twilio, or HIPAA audit logging
- Eligibility is program-level (not per-patient opt-out table)
- NestJS monolith module layout (domain modules deferred)
- `synchronize: true` for demo schema — use migrations in production
- Sanitized fake Twilio SIDs — not a Twilio integration test

## Disclaimer

Fictional patient IDs only. This is an **illustrative lab**, not production Ellipsis or Solace code. No PHI, no live Twilio. Built as an engineering demo for job application review and interview walkthroughs.

## License

MIT
