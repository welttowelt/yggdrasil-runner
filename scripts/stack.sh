#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

cmd="${1:-}"
if [[ -z "$cmd" ]]; then
  echo "usage: bash scripts/stack.sh <start|stop|status|restart>"
  echo ""
  echo "Env:"
  echo "  RUNNER_CONFIG_DIR=...   (default: config)"
  echo "  DASHBOARD_PORT=...      (default: 3199)"
  exit 2
fi

dashboard_pidfile="data/dashboard.pid"
dashboard_log="data/dashboard.log"

autofund_pidfile="data/autofund/autofund.pid"
autofund_log="data/autofund/autofund.log"

is_alive() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

start_dashboard() {
  mkdir -p data
  if [[ -f "$dashboard_pidfile" ]]; then
    local pid
    pid="$(cat "$dashboard_pidfile" 2>/dev/null || true)"
    if is_alive "$pid"; then
      echo "dashboard: already running (pid $pid)"
      return 0
    fi
  fi
  nohup npm run dashboard >"$dashboard_log" 2>&1 &
  local pid=$!
  echo "$pid" >"$dashboard_pidfile"
  echo "dashboard: started (pid $pid)"
}

stop_dashboard() {
  if [[ ! -f "$dashboard_pidfile" ]]; then
    echo "dashboard: stopped"
    return 0
  fi
  local pid
  pid="$(cat "$dashboard_pidfile" 2>/dev/null || true)"
  if is_alive "$pid"; then
    kill "$pid" 2>/dev/null || true
    echo "dashboard: stopped (pid $pid)"
  else
    echo "dashboard: stopped (stale pid $pid)"
  fi
  rm -f "$dashboard_pidfile"
}

status_dashboard() {
  if [[ ! -f "$dashboard_pidfile" ]]; then
    echo "dashboard: stopped"
    return 0
  fi
  local pid
  pid="$(cat "$dashboard_pidfile" 2>/dev/null || true)"
  if is_alive "$pid"; then
    echo "dashboard: running (pid $pid)"
  else
    echo "dashboard: stopped (stale pid $pid)"
  fi
}

start_autofund() {
  mkdir -p data/autofund
  if [[ -f "$autofund_pidfile" ]]; then
    local pid
    pid="$(cat "$autofund_pidfile" 2>/dev/null || true)"
    if is_alive "$pid"; then
      echo "autofund: already running (pid $pid)"
      return 0
    fi
  fi
  nohup npm run autofund >"$autofund_log" 2>&1 &
  local pid=$!
  echo "$pid" >"$autofund_pidfile"
  echo "autofund: started (pid $pid)"
}

stop_autofund() {
  if [[ ! -f "$autofund_pidfile" ]]; then
    echo "autofund: stopped"
    return 0
  fi
  local pid
  pid="$(cat "$autofund_pidfile" 2>/dev/null || true)"
  if is_alive "$pid"; then
    kill "$pid" 2>/dev/null || true
    echo "autofund: stopped (pid $pid)"
  else
    echo "autofund: stopped (stale pid $pid)"
  fi
  rm -f "$autofund_pidfile"
}

status_autofund() {
  if [[ ! -f "$autofund_pidfile" ]]; then
    echo "autofund: stopped"
    return 0
  fi
  local pid
  pid="$(cat "$autofund_pidfile" 2>/dev/null || true)"
  if is_alive "$pid"; then
    echo "autofund: running (pid $pid)"
  else
    echo "autofund: stopped (stale pid $pid)"
  fi
}

case "$cmd" in
  start)
    start_dashboard
    start_autofund
    bash scripts/sessions.sh start
    ;;
  stop)
    bash scripts/sessions.sh stop
    stop_autofund
    stop_dashboard
    ;;
  status)
    status_dashboard
    status_autofund
    bash scripts/sessions.sh status
    ;;
  restart)
    bash scripts/stack.sh stop
    bash scripts/stack.sh start
    ;;
  *)
    echo "unknown command: $cmd"
    echo "usage: bash scripts/stack.sh <start|stop|status|restart>"
    exit 2
    ;;
esac

