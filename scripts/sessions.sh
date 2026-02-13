#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

cmd="${1:-}"
if [[ -z "$cmd" ]]; then
  echo "usage: bash scripts/sessions.sh <start|stop|status>"
  exit 2
fi

CONFIG_DIR="${RUNNER_CONFIG_DIR:-config}"
if [[ "$CONFIG_DIR" = /* ]]; then
  CONFIG_DIR_PATH="$CONFIG_DIR"
else
  CONFIG_DIR_PATH="$ROOT_DIR/$CONFIG_DIR"
fi

configs=()
for f in "$CONFIG_DIR_PATH"/*.json; do
  [[ -e "$f" ]] || continue
  base="$(basename "$f")"
  [[ "$base" =~ ^(default|local)\.json$ ]] && continue
  configs+=("$base")
done
IFS=$'\n' configs=($(printf '%s\n' "${configs[@]}" | sort))
unset IFS

if [[ ${#configs[@]} -eq 0 ]]; then
  echo "no session configs found in ${CONFIG_DIR}/*.json"
  exit 1
fi

start_one() {
  local cfg="$1"
  local id="${cfg%.json}"
  local log="data/${id}/runner.log"
  local pidfile="data/${id}/runner.pid"

  mkdir -p "data/${id}"

  if [[ -f "$pidfile" ]]; then
    local pid
    pid="$(cat "$pidfile" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      echo "${id}: already running (pid ${pid})"
      return 0
    fi
  fi

  # Password is read from config/local.json (gitignored). Avoid passing secrets in env/argv.
  local cfgPath
  if [[ "$CONFIG_DIR" = /* ]]; then
    cfgPath="${CONFIG_DIR}/${cfg}"
  else
    cfgPath="${CONFIG_DIR}/${cfg}"
  fi
  nohup env RUNNER_CONFIG="$cfgPath" npm run start:headless >"$log" 2>&1 &
  local pid=$!
  echo "$pid" >"$pidfile"
  echo "${id}: started (pid ${pid})"
}

stop_one() {
  local cfg="$1"
  local id="${cfg%.json}"
  local pidfile="data/${id}/runner.pid"

  if [[ ! -f "$pidfile" ]]; then
    echo "${id}: no pidfile"
    return 0
  fi

  local pid
  pid="$(cat "$pidfile" 2>/dev/null || true)"
  if [[ -z "$pid" ]]; then
    echo "${id}: empty pidfile"
    rm -f "$pidfile"
    return 0
  fi

  if kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    echo "${id}: stopped (pid ${pid})"
  else
    echo "${id}: not running (stale pid ${pid})"
  fi
  rm -f "$pidfile"
}

status_one() {
  local cfg="$1"
  local id="${cfg%.json}"
  local pidfile="data/${id}/runner.pid"

  if [[ ! -f "$pidfile" ]]; then
    echo "${id}: stopped"
    return 0
  fi
  local pid
  pid="$(cat "$pidfile" 2>/dev/null || true)"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
    echo "${id}: running (pid ${pid})"
  else
    echo "${id}: stopped (stale pid ${pid})"
  fi
}

case "$cmd" in
  start)
    for cfg in "${configs[@]}"; do start_one "$cfg"; done
    ;;
  stop)
    for cfg in "${configs[@]}"; do stop_one "$cfg"; done
    ;;
  status)
    for cfg in "${configs[@]}"; do status_one "$cfg"; done
    ;;
  *)
    echo "unknown command: $cmd"
    echo "usage: bash scripts/sessions.sh <start|stop|status>"
    exit 2
    ;;
esac
