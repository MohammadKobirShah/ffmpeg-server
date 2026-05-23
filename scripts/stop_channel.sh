#!/usr/bin/env bash
# Usage: ./stop_channel.sh <channel_id>
set -euo pipefail
API_URL="${API_URL:-http://localhost:3000}"
CHANNEL_ID="${1:?channel id required}"
curl -sS -X POST "$API_URL/stream/stop/$CHANNEL_ID" | python3 -m json.tool
