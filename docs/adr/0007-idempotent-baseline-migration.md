# ADR-0007: Idempotent baseline migration (adopt migrations on an existing DB)

**Status:** Accepted
**Date:** 2026-06-29

## Context

Every Render deploy since `2a7925d` ("phase 0–1: migrations and ledger-first outbound") failed with `update_failed`. Render logs showed the real cause:

```
Migration "InitialSchema1730000000001" failed, error: relation "interactions" already exists
QueryFailedError: relation "interactions" already exists
  at InitialSchema1730000000001.up (.../1730000000001-InitialSchema.js:17:9)
==> Port scan timeout reached, no open ports detected.
```

On boot, `migrationsRun: true` runs `InitialSchema`, whose first statement was `CREATE TABLE "interactions"` (no `IF NOT EXISTS`). The Neon database **already had every table** — created during an earlier `synchronize`-era deploy — but the `migrations` table had **no record** that `InitialSchema` ran. So:

1. `InitialSchema.up` throws on the first `CREATE TABLE`.
2. `DataSource.initialize` fails; TypeORM retries (10×); the process never holds a stable port.
3. Render's port scan times out → `update_failed`.

This is the classic "adopt migrations on a database that already has a schema" problem. It was **not** caused by the async-relay work (ADR-0006) — that merge merely inherited a break that started two commits earlier. Reproduced locally by deleting the `migrations` rows from a populated DB (tables present, no record) and booting: identical `relation "interactions" already exists` → retry loop → health fail.

## Decision

Make the **baseline migration idempotent** so it runs cleanly against an empty, partial, *or* fully-populated database:

- `CREATE TABLE` → `CREATE TABLE IF NOT EXISTS` (all 11 tables).
- `CREATE INDEX` → `CREATE INDEX IF NOT EXISTS` (all 3 indexes).
- The `vector` extension block already used `CREATE EXTENSION IF NOT EXISTS` + exception handling.

On a pre-populated DB, `InitialSchema` becomes a no-op that **records itself**, unblocking the rest of the chain. `OutboxRelay` (ADR-0006) is already idempotent (`ADD COLUMN IF NOT EXISTS`), so it then adds the relay columns to the existing `sms_outbox`.

Editing an already-written baseline migration is safe **here** specifically because it has never successfully run anywhere: it fails on the only deployed DB, and on local DBs it is already recorded (so `migrationsRun` skips it — the edit never re-executes it). FK/UNIQUE constraints defined inline are skipped when a table already exists, which is correct: the existing table already carries them.

## Consequences

- Deploys boot regardless of whether the DB is fresh, partially created, or fully populated — self-healing.
- Verified locally against the exact failure state: tables present + empty `migrations` → boots green, both migrations recorded, relay columns present, health 200. Full suite 34/34.
- Constraint drift caveat: `IF NOT EXISTS` skips an existing table wholesale, so a table whose live shape diverged from the entity would *not* be reconciled here. Acceptable for this lab (tables came from the same entities via `synchronize`); a real fleet would use explicit forward migrations per change rather than relying on the baseline.

## Follow-ups (separate from the deploy fix)

Two infrastructure-truth issues surfaced while diagnosing — tracked, not yet actioned:

1. **`render.yaml` is dead config.** The live `care-ops-api` service is a **native Node service** (`buildCommand: "npm install && npm run build"`, `env: node`), not the Docker/Blueprint setup `render.yaml` describes. Dashboard config is the source of truth; Blueprint edits (incl. `OUTBOX_RELAY_AUTODRAIN=false`) never applied. Either adopt the Blueprint or update `render.yaml` to match reality.
2. **Relay autodrain on prod.** Because (1), `OUTBOX_RELAY_AUTODRAIN` is unset on the live service, so the relay autodrains on a poll loop in production. Harmless (it just delivers `pending` rows), but it makes the demo's manual **Drain outbox relay** button a no-op. Set the env var on the actual service if the interactive demo is wanted.

## Alternatives considered

- **Manually insert the `InitialSchema` row into the Neon `migrations` table** (baseline marker) — one-time, fragile, leaves the migration non-idempotent for the next environment. Rejected in favor of a self-healing migration.
- **Wipe the Neon DB and migrate fresh** — viable for a no-PHI demo, but discards the "adopt migrations on an existing DB" robustness and would recur. Rejected.
