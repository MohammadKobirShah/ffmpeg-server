#!/usr/bin/env bash
# Start a channel via the API.
#
# Usage:
#   ./start_channel.sh <url> <channel_id> [channel_name] [options]
#
# Options:
#   --mode copy|transcode             (default: transcode)
#   --qualities 540p,720p,1080p       (default: 540p,720p; ignored if --mode copy)
#   --audio-mode auto|language|index|all|none   (default: auto)
#   --audio-lang ben|hin|eng|...      (when --audio-mode language)
#   --audio-index N                   (when --audio-mode index)
#   --audio-priority ben,hin,eng      (override default priority for auto)
#   --header "Key: Value"             (repeatable)
#
# Examples:
#   # 1) Low-CPU copy + auto Bengali > Hindi > English audio pick
#   ./start_channel.sh https://src.test/x.m3u8 zee5 "Zee5" --mode copy
#
#   # 2) ABR transcode + force Hindi audio
#   ./start_channel.sh https://src.test/x.m3u8 sony "Sony" \
#       --qualities 480p,720p --audio-mode language --audio-lang hin
#
#   # 3) Pick a specific absolute stream index (from ffprobe)
#   ./start_channel.sh https://src.test/x.m3u8 espn "ESPN" \
#       --mode copy --audio-mode index --audio-index 3
#
#   # 4) Keep all default streams (no -map)
#   ./start_channel.sh https://src.test/x.m3u8 news "News" --audio-mode all
#
#   # 5) Referer-protected source
#   ./start_channel.sh https://src.test/x.m3u8 hbo "HBO" --mode copy \
#       --header "Referer: https://hbo.example/" --header "Origin: https://hbo.example"

set -euo pipefail
API_URL="${API_URL:-http://localhost:3000}"

URL="${1:?stream url required}"
CHANNEL_ID="${2:?channel id required}"
NAME="${3:-$CHANNEL_ID}"
if [[ $# -ge 3 ]]; then shift 3; else shift $#; fi

MODE="transcode"
QUAL_CSV="540p,720p"
AUDIO_MODE="auto"
AUDIO_LANG=""
AUDIO_INDEX=""
AUDIO_PRIO="ben,hin,eng"
declare -a HEADER_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode)            MODE="$2"; shift 2 ;;
    --qualities)       QUAL_CSV="$2"; shift 2 ;;
    --audio-mode)      AUDIO_MODE="$2"; shift 2 ;;
    --audio-lang)      AUDIO_LANG="$2"; shift 2 ;;
    --audio-index)     AUDIO_INDEX="$2"; shift 2 ;;
    --audio-priority)  AUDIO_PRIO="$2"; shift 2 ;;
    --header)          HEADER_ARGS+=("$2"); shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

csv_to_json_array() {
  printf '%s' "$1" | awk -F',' '{
    printf "["; for (i=1;i<=NF;i++){ printf "%s\"%s\"", (i>1?",":""), $i } printf "]"
  }'
}

QUAL_JSON=$(csv_to_json_array "$QUAL_CSV")
PRIO_JSON=$(csv_to_json_array "$AUDIO_PRIO")

# Build audio object
AUDIO_JSON='{"mode":"'"$AUDIO_MODE"'"'
case "$AUDIO_MODE" in
  auto)
    AUDIO_JSON+=',"priority":'"$PRIO_JSON"
    ;;
  language)
    [[ -z "$AUDIO_LANG" ]] && { echo "--audio-lang required for language mode" >&2; exit 1; }
    AUDIO_JSON+=',"language":"'"$AUDIO_LANG"'"'
    ;;
  index)
    [[ -z "$AUDIO_INDEX" ]] && { echo "--audio-index required for index mode" >&2; exit 1; }
    AUDIO_JSON+=',"trackIndex":'"$AUDIO_INDEX"
    ;;
  all|none) ;;  # nothing extra
  *) echo "unknown --audio-mode: $AUDIO_MODE" >&2; exit 1 ;;
esac
AUDIO_JSON+='}'

# Build headers object
HEADERS_JSON='{}'
if (( ${#HEADER_ARGS[@]} > 0 )); then
  HEADERS_JSON='{'
  first=1
  for h in "${HEADER_ARGS[@]}"; do
    k="${h%%:*}"
    v="${h#*:}"; v="${v# }"
    k_esc=${k//\"/\\\"}; v_esc=${v//\"/\\\"}
    [[ $first -eq 0 ]] && HEADERS_JSON+=','
    HEADERS_JSON+="\"$k_esc\":\"$v_esc\""
    first=0
  done
  HEADERS_JSON+='}'
fi

PAYLOAD=$(cat <<JSON
{
  "url": "$URL",
  "channelId": "$CHANNEL_ID",
  "channelName": "$NAME",
  "mode": "$MODE",
  "qualities": $QUAL_JSON,
  "audio": $AUDIO_JSON,
  "headers": $HEADERS_JSON
}
JSON
)

echo "→ POST $API_URL/stream/start"
echo "$PAYLOAD" | python3 -m json.tool
echo "---"
curl -sS -X POST "$API_URL/stream/start" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" | python3 -m json.tool
