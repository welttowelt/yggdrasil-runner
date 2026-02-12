#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <0x...> [more...]" >&2
  exit 2
fi

bad=0
for s in "$@"; do
  if [[ "$s" =~ ^0x[0-9a-fA-F]+$ ]]; then
    continue
  fi
  echo "invalid hex address: $s" >&2
  bad=1
done

exit "$bad"

