# ADR-0003: Split-stack deploy (Vercel web + container API)

**Status:** Accepted (amended 2026-06-24)  
**Date:** 2026-06-23

## Context

Reviewers need a one-click live URL (like the Glade bankruptcy demo). This repo uses NestJS + Redis + PostgreSQL — not a fit for Vercel serverless alone. Deploy cost must stay **$0** (no Railway Hobby / paid container hosts).

## Decision

- **Web:** Next.js on Vercel Hobby (free); root `apps/web`.
- **API:** NestJS Docker image on **Render free web service**; root `apps/api`; [`render.yaml`](../render.yaml) Blueprint.
- **Postgres:** Neon free tier (`DATABASE_URL`) — not Render Postgres free (30-day expiry).
- **Redis:** Upstash free tier (`REDIS_URL`).
- **Single reviewer URL:** Next.js `rewrites` proxy `/care-ops/*` and `/webhooks/*` to `API_PROXY_URL` (Render service URL).
- **Cold-start mitigation:** GitHub Actions [`keep-warm.yml`](../../.github/workflows/keep-warm.yml) pings the Vercel proxy every 10 minutes (stays within Render's 750 free instance-hours/month).
- **Local dev:** unchanged — Docker Compose for Postgres/Redis; API on :3001; web on :3000.

## Consequences

- EM sees one public URL; NestJS story stays honest in README and code.
- **$0/month** on all tiers (Vercel + Render + Neon + Upstash + GitHub Actions).
- Render free spins down after 15 min without traffic; keep-warm workflow reduces cold starts for demo reviewers.
- Two deploy targets to maintain (acceptable for application demo scope).
- CORS less critical — browser calls same-origin paths on Vercel.

## Alternatives considered

- **Railway Hobby ($5/mo)** — rejected for cost.
- **Port API to Next.js route handlers** — $0 single host but drops NestJS deploy surface; fallback if cold starts remain unacceptable.
- **Vercel experimental NestJS service** — TypeORM `InjectRepository` fails on serverless.
- **Vercel UI only, API local** — reviewers cannot click through without clone.
