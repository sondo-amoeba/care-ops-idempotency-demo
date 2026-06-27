#!/usr/bin/env bash
# Start Postgres + Redis for local dev/tests without manual docker/micromamba steps.
#
# Usage:
#   bash scripts/start-local-services.sh          # auto: Docker if available, else micromamba
#   bash scripts/start-local-services.sh docker
#   bash scripts/start-local-services.sh micromamba
#   bash scripts/start-local-services.sh stop
#   bash scripts/start-local-services.sh status
#
# After start, export the printed env vars (or source scripts/local-services.env).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PG_PORT="${POSTGRES_PORT:-5433}"
REDIS_PORT="${REDIS_PORT:-6380}"
PGDATA="${PGDATA:-$HOME/careops-pgdata}"
MAMBA_ROOT="${MAMBA_ROOT_PREFIX:-$HOME/micromamba}"
MAMBA_ENV="${CAREOPS_MAMBA_ENV:-careops}"
MODE="${1:-auto}"

export_local_env() {
  cat <<EOF
export POSTGRES_HOST=127.0.0.1
export POSTGRES_PORT=$PG_PORT
export POSTGRES_USER=careops
export POSTGRES_PASSWORD=careops
export POSTGRES_DB=careops_demo
export REDIS_URL=redis://127.0.0.1:$REDIS_PORT
export COORDINATOR_MODEL_MODE=\${COORDINATOR_MODEL_MODE:-mock}
EOF
}

have_docker() {
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1
}

micromamba_bin() {
  if command -v micromamba >/dev/null 2>&1; then
    command -v micromamba
    return 0
  fi
  if [[ -x /tmp/bin/micromamba ]]; then
    echo /tmp/bin/micromamba
    return 0
  fi
  if [[ -x "$MAMBA_ROOT/bin/micromamba" ]]; then
    echo "$MAMBA_ROOT/bin/micromamba"
    return 0
  fi
  return 1
}

activate_micromamba() {
  local bin
  bin="$(micromamba_bin)" || return 1
  export MAMBA_ROOT_PREFIX="$MAMBA_ROOT"
  eval "$("$bin" shell hook -s bash -r "$MAMBA_ROOT")"
  micromamba activate "$MAMBA_ENV"
}

ensure_micromamba_env() {
  local bin
  bin="$(micromamba_bin)" || {
    echo "micromamba not found. Install: curl -Ls https://micro.mamba.pm/api/micromamba/linux-64/latest | tar -xvj -C /tmp bin/micromamba" >&2
    exit 1
  }
  export MAMBA_ROOT_PREFIX="$MAMBA_ROOT"
  eval "$("$bin" shell hook -s bash -r "$MAMBA_ROOT")"
  if ! micromamba env list | awk '{print $1}' | grep -qx "$MAMBA_ENV"; then
    echo "Creating micromamba env '$MAMBA_ENV' (postgresql + pgvector + redis-server)..."
    micromamba create -y -n "$MAMBA_ENV" -c conda-forge postgresql pgvector redis-server
  fi
  micromamba activate "$MAMBA_ENV"
}

start_docker() {
  echo "Starting Postgres + Redis via Docker Compose..."
  (cd "$ROOT" && docker compose up -d postgres redis)
  echo "Backend: docker (postgres :5433→5432, redis :6380→6379)"
}

stop_docker() {
  if have_docker; then
    (cd "$ROOT" && docker compose stop postgres redis 2>/dev/null) || true
  fi
}

start_micromamba() {
  ensure_micromamba_env
  if [[ ! -f "$PGDATA/PG_VERSION" ]]; then
    echo "Initializing Postgres data dir at $PGDATA..."
    initdb -D "$PGDATA" -U careops -A trust
  fi
  if ! pg_ctl -D "$PGDATA" -o "-p $PG_PORT -h 127.0.0.1" status >/dev/null 2>&1; then
    echo "Starting Postgres on 127.0.0.1:$PG_PORT..."
    pg_ctl -D "$PGDATA" -o "-p $PG_PORT -h 127.0.0.1" -l "$PGDATA/logfile" start
    sleep 2
  fi
  if ! psql -p "$PG_PORT" -h 127.0.0.1 -U careops -d postgres -tc \
    "SELECT 1 FROM pg_database WHERE datname='careops_demo'" | grep -q 1; then
    createdb -p "$PG_PORT" -h 127.0.0.1 -U careops careops_demo
  fi
  if ! redis-cli -p "$REDIS_PORT" ping >/dev/null 2>&1; then
    echo "Starting Redis on 127.0.0.1:$REDIS_PORT..."
    redis-server --port "$REDIS_PORT" --daemonize yes
    sleep 1
  fi
  echo "Backend: micromamba (Postgres 127.0.0.1:$PG_PORT, Redis 127.0.0.1:$REDIS_PORT)"
}

stop_micromamba() {
  if activate_micromamba 2>/dev/null && [[ -d "$PGDATA" ]]; then
    pg_ctl -D "$PGDATA" stop -m fast 2>/dev/null || true
  fi
  if command -v redis-cli >/dev/null 2>&1; then
    redis-cli -p "$REDIS_PORT" shutdown nosave 2>/dev/null || true
  fi
}

status_services() {
  echo "Postgres ($PG_PORT):"
  if command -v pg_isready >/dev/null 2>&1 && pg_isready -h 127.0.0.1 -p "$PG_PORT" -U careops 2>/dev/null; then
    echo "  up"
  elif psql -p "$PG_PORT" -h 127.0.0.1 -U careops -d postgres -c 'SELECT 1' >/dev/null 2>&1; then
    echo "  up"
  else
    echo "  down"
  fi
  echo "Redis ($REDIS_PORT):"
  if redis-cli -p "$REDIS_PORT" ping 2>/dev/null | grep -q PONG; then
    echo "  up"
  else
    echo "  down"
  fi
}

resolve_mode() {
  case "$MODE" in
    auto)
      if have_docker; then
        echo docker
      else
        echo micromamba
      fi
      ;;
    docker | micromamba | stop | status)
      echo "$MODE"
      ;;
    *)
      echo "Unknown mode: $MODE (use auto, docker, micromamba, stop, status)" >&2
      exit 1
      ;;
  esac
}

MODE="$(resolve_mode)"

case "$MODE" in
  docker)
    start_docker
    ;;
  micromamba)
    start_micromamba
    ;;
  stop)
    stop_docker
    stop_micromamba
    echo "Stopped local Postgres + Redis."
    exit 0
    ;;
  status)
    status_services
    exit 0
    ;;
esac

echo ""
echo "Export these before pnpm test / dev:"
export_local_env
echo ""
echo "Tip: eval \"\$(bash scripts/start-local-services.sh status >/dev/null; bash scripts/start-local-services.sh 2>/dev/null | sed -n '/^export /p')\""
