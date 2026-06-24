# ADR-0003: Split-stack deploy (Vercel web + container API)

**Status:** Accepted  
**Date:** 2026-06-23

## Context

Reviewers need a one-click live URL (like the Glade bankruptcy demo). This repo uses NestJS + Redis + PostgreSQL — not a fit for Vercel serverless alone.

## Decision

- **Web:** Next.js on Vercel; same account / Postgres provider pattern as Glade.
- **API:** NestJS Docker image on Railway (or Render); `DATABASE_URL` → Neon/Vercel Postgres; `REDIS_URL` → Upstash.
- **Single reviewer URL:** Next.js `rewrites` proxy `/care-ops/*` and `/webhooks/*` to `API_PROXY_URL`.
- **Local dev:** unchanged — Docker Compose for Postgres/Redis; API on :3001; web on :3000 with rewrite to localhost.

## Consequences

- EM sees one public URL; NestJS story stays honest in README and code.
- Two deploy targets to maintain (acceptable for application demo scope).
- CORS less critical — browser calls same-origin paths on Vercel.

## Alternatives considered

- Port API to Next.js route handlers — drops NestJS from deploy surface; weakens proud-code narrative.
- Vercel UI only, API local — reviewers cannot click through without clone.
