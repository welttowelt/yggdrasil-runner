#!/usr/bin/env bash
set -euo pipefail

if ! command -v controller >/dev/null 2>&1; then
  echo "error: 'controller' not found in PATH (install controller-cli first)" >&2
  exit 127
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "error: 'jq' not found in PATH (required to parse controller --json output)" >&2
  exit 127
fi

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <command> [args...]" >&2
  exit 2
fi

cmd="$1"
shift

needs_network="false"
case "$cmd" in
  call|execute|register|transaction)
    needs_network="true"
    ;;
esac

has_chain_id="false"
has_rpc_url="false"
has_json="false"
for arg in "$@"; do
  [[ "$arg" == "--chain-id" ]] && has_chain_id="true"
  [[ "$arg" == "--rpc-url" ]] && has_rpc_url="true"
  [[ "$arg" == "--json" ]] && has_json="true"
done

if [[ "$needs_network" == "true" && "$has_chain_id" == "false" && "$has_rpc_url" == "false" ]]; then
  echo "error: controller '$cmd' requires explicit network: pass --chain-id SN_MAIN|SN_SEPOLIA or --rpc-url <url>" >&2
  exit 2
fi

args=("$@")
if [[ "$has_json" == "false" ]]; then
  args+=("--json")
fi

tmp_out="$(mktemp)"
tmp_err="$(mktemp)"
trap 'rm -f "$tmp_out" "$tmp_err"' EXIT

set +e
controller "$cmd" "${args[@]}" >"$tmp_out" 2>"$tmp_err"
rc=$?
set -e

out="$(cat "$tmp_out")"
err="$(cat "$tmp_err")"

if ! jq -e . >/dev/null 2>&1 <<<"$out"; then
  [[ -n "$err" ]] && echo "$err" >&2
  echo "error: controller output is not valid JSON (exit $rc)" >&2
  echo "$out" >&2
  exit 1
fi

status="$(jq -r '.status? // empty' <<<"$out")"
if [[ "$status" == "error" ]]; then
  code="$(jq -r '.error_code? // empty' <<<"$out")"
  msg="$(jq -r '.message? // empty' <<<"$out")"
  hint="$(jq -r '.recovery_hint? // empty' <<<"$out")"

  echo "controller error: ${code:-unknown}" >&2
  [[ -n "$msg" ]] && echo "message: $msg" >&2
  [[ -n "$hint" ]] && echo "recovery_hint: $hint" >&2
  [[ -n "$err" ]] && echo "$err" >&2
  exit 1
fi

# Surface stderr (if any) but keep stdout as canonical JSON.
[[ -n "$err" ]] && echo "$err" >&2
jq . <<<"$out"
exit 0

