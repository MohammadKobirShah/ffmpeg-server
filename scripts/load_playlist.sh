#!/usr/bin/env bash
# Load an M3U playlist into the API. Optionally auto-start every channel.
#
# Usage:
#   ./load_playlist.sh <playlist_url> <name> [options]
#
# Options:
#   --auto-start                       enqueue a transcode job for every channel
#   --mode copy|transcode              (default: transcode; copy is much cheaper)
#   --qualities 540p,720p              (default: 540p,720p; ignored if --mode copy)
#   --audio-mode auto|language|all|none   (default: auto)
#   --audio-lang ben|hin|eng           (when --audio-mode language)
#   --audio-priority ben,hin,eng       (override default for auto)
#
# Examples:
#   # 1) Just parse + index, no transcoding yet
#   ./load_playlist.sh https://provider/playlist.m3u my_iptv
#
#   # 2) Load + auto-start everything in copy mode (low CPU, fastest)
#   ./load_playlist.sh https://provider/playlist.m3u my_iptv \
#       --auto-start --mode copy
#
#   # 3) Auto-start with ABR transcode + force Bengali audio if present
#   ./load_playlist.sh https://provider/playlist.m3u bd_iptv \
#       --auto-start --mode transcode --qualities 480p,720p \
#       --audio-mode language --audio-lang ben

set -euo pipefail
API_URL="${API_URL:-http://localhost:3000}"

URL="${1:?playlist url required}"
NAME="${2:?playlist name required}"
shift 2

AUTO_START=false
MODE="transcode"
QUAL_CSV="540p,720p"
AUDIO_MODE="auto"
AUDIO_LANG=""
AUDIO_PRIO="ben,hin,eng"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --auto-start)      AUTO_START=true; shift ;;
    --mode)            MODE="$2"; shift 2 ;;
    --qualities)       QUAL_CSV="$2"; shift 2 ;;
    --audio-mode)      AUDIO_MODE="$2"; shift 2 ;;
    --audio-lang)      AUDIO_LANG="$2"; shift 2 ;;
    --audio-priority)  AUDIO_PRIO="$2"; shift 2 ;;
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

AUDIO_JSON='{"mode":"'"$AUDIO_MODE"'"'
case "$AUDIO_MODE" in
  auto)     AUDIO_JSON+=',"priority":'"$PRIO_JSON" ;;
  language) [[ -z "$AUDIO_LANG" ]] && { echo "--audio-lang required" >&2; exit 1; }
            AUDIO_JSON+=',"language":"'"$AUDIO_LANG"'"' ;;
esac
AUDIO_JSON+='}'

PAYLOAD=$(cat <<JSON
{
  "url": "$URL",
  "name": "$NAME",
  "autoStart": $AUTO_START,
  "mode": "$MODE",
  "qualities": $QUAL_JSON,
  "audio": $AUDIO_JSON
}
JSON
)

echo "→ POST $API_URL/playlist/load"
echo "$PAYLOAD" | python3 -m json.tool
echo "---"
curl -sS -X POST "$API_URL/playlist/load" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" | python3 -m json.tool

echo
echo "📺 Aggregate master playlist: $API_URL/playlist/$NAME/master.m3u8"
