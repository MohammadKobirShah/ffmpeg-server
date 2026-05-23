#!/usr/bin/env bash
# Print the current public tunnel URL.
#   ./tunnel_url.sh           → prints just the URL (or "(pending)")
#   ./tunnel_url.sh --watch   → waits until ready, then prints
set -euo pipefail
API_URL="${API_URL:-http://localhost:3000}"

if [[ "${1:-}" == "--watch" ]]; then
  echo -n "Waiting for tunnel"
  for i in $(seq 1 90); do
    url=$(curl -sS "$API_URL/tunnel" | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("url") or "")' 2>/dev/null || true)
    if [[ -n "$url" ]]; then
      echo
      echo "$url"
      exit 0
    fi
    echo -n "."
    sleep 1
  done
  echo
  echo "(timeout)"
  exit 1
fi

curl -sS "$API_URL/tunnel" | python3 -m json.tool
