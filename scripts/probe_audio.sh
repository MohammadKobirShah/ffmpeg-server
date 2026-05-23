#!/usr/bin/env bash
# Probe a source URL with ffprobe to see what audio tracks are available.
# Useful before deciding whether to use --audio-mode language / index.
#
# Usage: ./probe_audio.sh <url>
set -euo pipefail
URL="${1:?stream url required}"

if ! command -v ffprobe >/dev/null 2>&1; then
  echo "ffprobe not found on host. Running inside the worker container instead..."
  docker compose exec -T worker ffprobe \
    -v error -print_format json \
    -show_entries 'stream=index,codec_type,codec_name,channels:stream_tags=language,title' \
    -user_agent "Mozilla/5.0" \
    "$URL" | python3 -m json.tool
  exit
fi

ffprobe -v error -print_format json \
  -show_entries 'stream=index,codec_type,codec_name,channels:stream_tags=language,title' \
  -user_agent "Mozilla/5.0" \
  "$URL" | python3 -m json.tool
