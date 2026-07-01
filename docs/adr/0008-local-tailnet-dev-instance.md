# ADR-0008: Local tailnet-private dev instance (Mac + Tailscale)

**Status:** Accepted
**Date:** 2026-07-01
**Relates to:** ADR-0003 (split-stack cloud deploy) — this adds a run mode, it does not replace it.

## Context

ADR-0003 deploys the reviewer-facing artifact to Vercel + Render + Neon + Upstash and says "local dev: unchanged." Separately I want to run the whole stack on my own MacBook and reach it from my other devices (phone, iPad, second laptop) to use local machine resources instead of cloud free tiers — no Render 15-min cold start, no free-tier quotas. Access should stay private to me, not public.

## Decision

Add a **tailnet-private personal run mode** on the Mac, alongside (not replacing) the ADR-0003 cloud deploy:

- **Topology:** everything runs on the Mac. Datastores in containers (OrbStack: `pgvector/pgvector:pg16` on `:5433`, `redis:7` on `:6380`); API and web as Node processes.
- **Single exposed surface:** because the browser only calls same-origin `/care-ops/*` and `/webhooks/*` and Next.js proxies to the API **server-side** (`apps/web/src/lib/proxy-request.ts`, `apiBaseUrl()` → `API_PROXY_URL`), only the **web origin (`:3000`)** is exposed. Postgres, Redis, and the API (`:3001`) stay bound to the Mac — the API is never reachable off-box.
- **Exposure mechanism:** `tailscale serve --bg https / http://localhost:3000` — HTTPS on the MagicDNS name, **tailnet-only** (no Funnel), auto-provisioned TLS, config persists across reboots.
- **Web run mode split:** `pnpm --filter @care-ops/web dev` (HMR) only when editing **on the Mac at localhost**; a **production build** (`next build && next start`) for the tailnet-exposed instance. This sidesteps Next 15's dev-server cross-origin check on `/_next/*` (the `Host` header over Tailscale is the `*.ts.net` name, not `localhost`), which would otherwise require bumping to Next >= 15.3 and hardcoding `allowedDevOrigins`.
- **Coordinator model:** unchanged — `mock` default (deterministic, $0, no key), `GEMINI_API_KEY` optional for live planning. No on-device LLM. The idempotency invariants this repo exists to prove do not touch the model.
- **Lifecycle:** `tailscale serve --bg` persists the proxy; OrbStack `restart: unless-stopped` persists the datastores; a one-shot script brings API + web up on demand; `caffeinate -dimsu` only when lid-closed access is needed. No launchd daemons.

## Considered options

- **Tailscale Funnel / full self-host as the public URL** — rejected. A closed-lid MacBook sleeps; it is a bad *public* demo host. The cloud deploy (ADR-0003) remains the public face.
- **Hybrid (Vercel public front, Mac backend over Tailscale)** — viable but not the goal here; access was scoped to my own devices, so the public Vercel front adds no value for this mode.
- **Dev server everywhere + `allowedDevOrigins`** — rejected. Requires a Next >= 15.3 bump and hardcoding the tailnet hostname; a dev server exposed 24/7 is flakier than a prod build. HMR is only useful while coding at localhost, where there is no cross-origin issue.
- **On-device Ollama adapter** — deferred. Genuinely uses the Mac GPU but is net-new code (a third `Coordinator model` adapter through the ADR-0004 graph) and deserves its own ADR. Out of scope for "just run it locally."
- **launchd appliance** — deferred. Full self-heal after reboot/logout is more moving parts than a personal artifact needs.
- **`micromamba` local-services path** (`scripts/start-local-services.sh`) — not usable on the Mac: it is pinned `linux-64`. The Mac uses the container path.

## Consequences

- Reachable only while the Mac is awake and on the tailnet — acceptable for a personal instance.
- Two run modes to keep straight (dev at localhost vs prod build behind Serve).
- The SSE coordinator trace still degrades to poll fallback: the catch-all proxy buffers with `arrayBuffer()`, so streaming never arrives incrementally (pre-existing, ADR-independent — surfaces more over a tailnet hop).
- Pre-existing debt untouched: `render.yaml:25` references a never-written **ADR-0007** (migrate-on-boot → port-binding). That slot stays reserved for that topic; this ADR is 0008 to avoid the collision.
