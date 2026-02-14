#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

cmd="${1:-}"
if [[ -z "$cmd" ]]; then
  echo "usage: bash scripts/sessions.sh <start|stop|status>"
  echo "       bash scripts/sessions.sh <start|stop|status> <profile...>"
  echo ""
  echo "Env:"
  echo "  RUNNER_DRIVER=nohup|screen   (default: nohup if tty, else screen)"
  echo "  RUNNER_START_STAGGER_MS=...  (default: 0)"
  exit 2
fi

CONFIG_DIR="${RUNNER_CONFIG_DIR:-config}"
if [[ "$CONFIG_DIR" = /* ]]; then
  CONFIG_DIR_PATH="$CONFIG_DIR"
else
  CONFIG_DIR_PATH="$ROOT_DIR/$CONFIG_DIR"
fi

configs=()
shift 1

driver="${RUNNER_DRIVER:-}"
if [[ -z "$driver" ]]; then
  if [[ -t 1 ]]; then
    driver="nohup"
  else
    driver="screen"
  fi
fi
if [[ "$driver" != "nohup" && "$driver" != "screen" ]]; then
  echo "unknown RUNNER_DRIVER: $driver (expected nohup|screen)"
  exit 2
fi

stagger_ms="${RUNNER_START_STAGGER_MS:-0}"
if ! [[ "$stagger_ms" =~ ^[0-9]+$ ]]; then
  echo "invalid RUNNER_START_STAGGER_MS: $stagger_ms (expected integer ms)"
  exit 2
fi

find_config_case_insensitive() {
  local wanted="$1"
  local stem="${wanted%.json}"
  local stem_lower
  stem_lower="$(printf '%s' "$stem" | tr '[:upper:]' '[:lower:]')"
  local f base candidate candidate_lower
  for f in "$CONFIG_DIR_PATH"/*.json; do
    [[ -e "$f" ]] || continue
    base="$(basename "$f")"
    [[ "$base" =~ ^(default|local)\.json$ ]] && continue
    candidate="${base%.json}"
    candidate_lower="$(printf '%s' "$candidate" | tr '[:upper:]' '[:lower:]')"
    if [[ "$candidate_lower" == "$stem_lower" ]]; then
      printf '%s' "$base"
      return 0
    fi
  done
  return 1
}

screen_running() {
  local name="$1"
  # `screen -ls` returns exit code 1 on macOS even when sessions exist, and `set -o pipefail`
  # would otherwise make this always fail. Ignore the exit code and match on output.
  local out
  out="$(screen -ls 2>/dev/null || true)"
  printf '%s\n' "$out" | grep -qE "[0-9]+\\.${name}[[:space:]]"
}

if [[ $# -gt 0 ]]; then
  # Explicit profile list provided (basename without .json or full filename).
  for name in "$@"; do
    base="$name"
    [[ "$base" != *.json ]] && base="${base}.json"
    # macOS often uses case-insensitive FS; always canonicalize config casing so screen session
    # names remain deterministic (ls2_<lowercase id>), even if the caller passes "Hugobiss".
    match="$(find_config_case_insensitive "$base" || true)"
    if [[ -n "$match" ]]; then
      base="$match"
    elif [[ ! -f "$CONFIG_DIR_PATH/$base" ]]; then
      echo "config not found: ${CONFIG_DIR}/${base}"
      exit 1
    fi
    [[ "$base" =~ ^(default|local)\.json$ ]] && continue
    configs+=("$base")
  done
else
  for f in "$CONFIG_DIR_PATH"/*.json; do
    [[ -e "$f" ]] || continue
    base="$(basename "$f")"
    [[ "$base" =~ ^(default|local)\.json$ ]] && continue
    configs+=("$base")
  done
fi

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
  local sessionName="ls2_${id}"

  mkdir -p "data/${id}"

  # Password is read from config/local.json (gitignored). Avoid passing secrets in env/argv.
  local cfgPath
  if [[ "$CONFIG_DIR" = /* ]]; then
    cfgPath="${CONFIG_DIR}/${cfg}"
  else
    cfgPath="${CONFIG_DIR}/${cfg}"
  fi

  if [[ "$driver" == "screen" ]]; then
    if screen_running "$sessionName"; then
      echo "${id}: already running (screen ${sessionName})"
      return 0
    fi
    screen -dmS "$sessionName" bash -lc "cd \"$ROOT_DIR\" && exec env RUNNER_CONFIG=\"$cfgPath\" npm run start:headless >\"$log\" 2>&1"
    echo "screen:${sessionName}" >"$pidfile"
    echo "${id}: started (screen ${sessionName})"
    return 0
  fi

  if [[ -f "$pidfile" ]]; then
    local pid
    pid="$(cat "$pidfile" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      echo "${id}: already running (pid ${pid})"
      return 0
    fi
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
  local sessionName="ls2_${id}"

  if [[ "$driver" == "screen" ]]; then
    if screen_running "$sessionName"; then
      screen -S "$sessionName" -X quit || true
      echo "${id}: stopped (screen ${sessionName})"
    else
      echo "${id}: not running (screen ${sessionName})"
    fi
    rm -f "$pidfile"
    return 0
  fi

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
  local sessionName="ls2_${id}"

  if [[ "$driver" == "screen" ]]; then
    if screen_running "$sessionName"; then
      echo "${id}: running (screen ${sessionName})"
    else
      echo "${id}: stopped (screen ${sessionName})"
    fi
    return 0
  fi

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
    for cfg in "${configs[@]}"; do
      start_one "$cfg"
      if [[ "$stagger_ms" -gt 0 ]]; then
        sleep "$(python3 - <<'PY'
import os
ms=int(os.environ.get("RUNNER_START_STAGGER_MS","0"))
print(ms/1000)
PY
)"
      fi
    done
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
