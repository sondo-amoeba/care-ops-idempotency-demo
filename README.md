# Care-Ops SMS Idempotency Demo

Public runnable lab for **replay-safe care-ops SMS** — inspired by private HIPAA-bound production work at Ellipsis Health, rebuilt so engineering reviewers can click through without cloning.

**Live demo:** https://care-ops-idempotency-demo.vercel.app _(UI live — API requires Railway deploy + `API_PROXY_URL`)_

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
  → NestJS API (Railway / Render)
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

## Deploy (Vercel + Railway)

Split stack — same pattern as the [Glade bankruptcy demo](https://github.com/sondo-amoeba/bankruptcy-intake-triage): **Vercel for the reviewer-facing URL**, managed Postgres + Redis, API on a container host.

### 1. Postgres (Neon / Vercel Postgres)

Create a database (Vercel Storage → Postgres, or Neon). Copy `DATABASE_URL`.

### 2. Redis (Upstash)

Create a Redis database in [Upstash](https://upstash.com/) (Vercel marketplace integration works). Copy `REDIS_URL`.

### 3. API on Railway

1. New project → **Deploy from GitHub** → this repo.
2. Set **Root Directory** to `apps/api`.
3. Environment variables:
   - `DATABASE_URL` — Postgres connection string
   - `REDIS_URL` — Upstash URL
   - `API_PORT` — `3001`
   - `NODE_ENV` — `production`
4. Deploy. Note the public URL (e.g. `https://care-ops-api.up.railway.app`).

TypeORM `synchronize: true` applies schema on first boot (demo only — not for production).

### 4. Web on Vercel

1. Import repo in Vercel (same account as Glade demo).
2. **Root Directory:** `apps/web`
3. **Install Command:** `cd ../.. && pnpm install`
4. **Build Command:** `pnpm build`
5. Environment variable:
   - `API_PROXY_URL` — Railway API URL from step 3
6. Deploy (`vercel --prod` or push to `main` after GitHub connect)

Reviewers hit one URL; Next.js rewrites proxy `/care-ops/*` and `/webhooks/*` to the API.

**Note:** Do not use Vercel's experimental NestJS service — TypeORM decorators fail on serverless. Keep the API on Railway.

### Post-deploy

Update the **Live demo** link at the top of this README.

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
