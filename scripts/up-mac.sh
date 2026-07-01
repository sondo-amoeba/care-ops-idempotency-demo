#!/usr/bin/env bash
# Bring up the tailnet-private personal instance on a Mac (ADR-0008).
#
# Runs the PROD build (next start / node dist) so the tailnet-exposed web
# instance avoids Next 15's dev-server cross-origin check. Datastores run in
# OrbStack/Docker; only the web origin (:3000) is exposed via Tailscale Serve.
#
# Usage:
#   bash scripts/up-mac.sh            # datastores + build + start api/web + tailscale serve
#   bash scripts/up-mac.sh --awake    # same, wrapped in caffeinate (lid-closed access)
#   bash scripts/up-mac.sh status
#   bash scripts/up-mac.sh stop       # stop api/web (datastores + serve left running)
#   bash scripts/up-mac.sh logs       # tail api + web logs
#
# Coding on the Mac itself? Use `pnpm --filter @care-ops/web dev` at localhost
# instead (HMR, no cross-origin issue) — this script is for the exposed instance.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$ROOT/.run"
WEB_PORT="${WEB_PORT:-3000}"
API_PORT="${API_PORT:-3001}"
export API_PORT
export API_PROXY_URL="${API_PROXY_URL:-http://localhost:$API_PORT}"
export COORDINATOR_MODEL_MODE="${COORDINATOR_MODEL_MODE:-mock}"
MODE="${1:-up}"

mkdir -p "$RUN_DIR"

pid_alive() { [[ -f "$1" ]] && kill -0 "$(cat "$1")" 2>/dev/null; }

wait_for() {
  local url="$1" name="$2" tries="${3:-60}"
  for ((i = 0; i < tries; i++)); do
    if curl -fsS -o /dev/null "$url" 2>/dev/null; then
      echo "  $name up ($url)"
      return 0
    fi
    sleep 1
  done
  echo "  WARNING: $name did not come up at $url (check $RUN_DIR/*.log)" >&2
  return 1
}

start_datastores() {
  echo "Datastores (OrbStack/Docker: postgres :5433, redis :6380)..."
  (cd "$ROOT" && docker compose up -d postgres redis)
  local ids
  ids="$(cd "$ROOT" && docker compose ps -q postgres redis)"
  [[ -n "$ids" ]] && docker update --restart=unless-stopped $ids >/dev/null
}

build_apps() {
  if [[ ! -d "$ROOT/node_modules" ]]; then
    echo "Installing dependencies (pnpm install)..."
    (cd "$ROOT" && pnpm install)
  fi
  echo "Building api + web (prod)..."
  (cd "$ROOT" && pnpm --filter @care-ops/api build && pnpm --filter @care-ops/web build)
}

start_api() {
  if pid_alive "$RUN_DIR/api.pid"; then
    echo "API already running (pid $(cat "$RUN_DIR/api.pid"))."
    return
  fi
  echo "Starting API (:$API_PORT, migrations run on boot)..."
  (cd "$ROOT/apps/api" && node dist/main.js >"$RUN_DIR/api.log" 2>&1 &
    echo $! >"$RUN_DIR/api.pid")
  wait_for "http://localhost:$API_PORT/care-ops/interactions" "API"
}

start_web() {
  if pid_alive "$RUN_DIR/web.pid"; then
    echo "Web already running (pid $(cat "$RUN_DIR/web.pid"))."
    return
  fi
  echo "Starting web (:$WEB_PORT, next start)..."
  (cd "$ROOT" && pnpm --filter @care-ops/web start >"$RUN_DIR/web.log" 2>&1 &
    echo $! >"$RUN_DIR/web.pid")
  wait_for "http://localhost:$WEB_PORT" "Web"
}

start_serve() {
  if ! command -v tailscale >/dev/null 2>&1; then
    echo "tailscale not found — skipping Serve. Web is at http://localhost:$WEB_PORT" >&2
    return
  fi
  echo "Exposing web over the tailnet (tailscale serve --bg)..."
  tailscale serve --bg https / "http://localhost:$WEB_PORT" || {
    echo "  Serve failed — check MagicDNS + HTTPS Certificates are enabled in the admin console." >&2
    return
  }
  tailscale serve status || true
}

do_up() {
  start_datastores
  build_apps
  start_api
  start_web
  start_serve
  echo "Up. Reach it from any tailnet device at the https URL above."
}

case "$MODE" in
  up)
    do_up
    ;;
  --awake)
    if command -v caffeinate >/dev/null 2>&1; then
      exec caffeinate -dimsu bash "$ROOT/scripts/up-mac.sh" up
    else
      do_up
    fi
    ;;
  stop)
    for svc in api web; do
      if pid_alive "$RUN_DIR/$svc.pid"; then
        kill "$(cat "$RUN_DIR/$svc.pid")" && echo "Stopped $svc."
      fi
      rm -f "$RUN_DIR/$svc.pid"
    done
    echo "Datastores and tailscale serve left running (docker compose stop / tailscale serve reset to clear)."
    ;;
  status)
    for svc in api web; do
      if pid_alive "$RUN_DIR/$svc.pid"; then
        echo "$svc: up (pid $(cat "$RUN_DIR/$svc.pid"))"
      else
        echo "$svc: down"
      fi
    done
    (cd "$ROOT" && docker compose ps postgres redis) || true
    command -v tailscale >/dev/null 2>&1 && tailscale serve status || true
    ;;
  logs)
    tail -n 40 -f "$RUN_DIR/api.log" "$RUN_DIR/web.log"
    ;;
  *)
    echo "Unknown mode: $MODE (use up, --awake, stop, status, logs)" >&2
    exit 1
    ;;
esac
