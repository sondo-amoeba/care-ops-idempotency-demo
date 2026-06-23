# Care-Ops SMS Idempotency Demo

Sanitized, runnable demo of **replay-safe care-ops SMS** patterns — inspired by private HIPAA-bound production work at Ellipsis Health, rebuilt for public review.

**Stack:** NestJS · TypeORM · PostgreSQL · Redis · Next.js · Tailwind (shadcn-style UI)

## What it demonstrates

| Pattern | Implementation |
|---------|----------------|
| Unified thread model | `interaction_id` links `care_thread`, `voice_session`, `booking`, and `sms_messages` |
| Inbound idempotency | Twilio-style webhook upsert on `twilio_message_sid` (UNIQUE) |
| Outbound idempotency | Deterministic `idempotency_key` = hash(interaction + template + hour window) |
| Status callbacks | Update-only — no duplicate rows on late delivery events |
| Eligibility gate | `canContact()` before outbox insert |
| Agent workflow API | Orchestrator-style trigger reuses same send path |
| Replay storm | 50 identical triggers → 1 outbound row |

## Quick start (local)

```bash
cp .env.example .env
docker compose up -d postgres redis
pnpm install
pnpm --filter @care-ops/api dev   # terminal 1 — API on :3001
pnpm --filter @care-ops/web dev   # terminal 2 — UI on :3000
```

Open http://localhost:3000 — create a thread, send SMS, run **50× replay storm**.

## Tests

Requires Postgres + Redis (docker compose):

```bash
export POSTGRES_PORT=5433 REDIS_URL=redis://localhost:6380
pnpm --filter @care-ops/api test
bash scripts/replay-storm.sh
```

## Docker (full stack)

```bash
docker compose up --build
```

- UI: http://localhost:3000  
- API: http://localhost:3001  

## API endpoints

- `POST /care-ops/interactions` — create thread bundle
- `POST /care-ops/sms/send` — care-agent outbound
- `POST /care-ops/agent-workflow/trigger-sms` — orchestrator trigger
- `POST /webhooks/twilio/inbound` — simulated inbound webhook
- `POST /webhooks/twilio/status` — delivery status callback
- `GET /care-ops/metrics/duplicates` — duplicate stats

## Disclaimer

This is an **illustrative lab**, not production Ellipsis or Solace code. No PHI, no live Twilio. Production system was private; this repo shows the idempotency design for reviewers and interview walkthroughs.

## License

MIT
