#!/usr/bin/env bash
# Cloudflared sidecar entrypoint.
#
# Modes:
#   1. Quick Tunnel (default)     — no config; ephemeral *.trycloudflare.com URL
#   2. Named Tunnel via TOKEN     — set TUNNEL_TOKEN (from Zero Trust dashboard)
#                                   Public URL must be set via PUBLIC_DOMAIN
#   3. Named Tunnel via cert/json — mount /etc/cloudflared with cert.pem +
#                                   tunnel json + config.yml, set TUNNEL_NAME
#
# Required env: REDIS_URL  TARGET_URL
# Optional env: PUBLIC_DOMAIN  TUNNEL_TOKEN  TUNNEL_NAME  EXTRA_ARGS

set -euo pipefail

TARGET_URL="${TARGET_URL:-http://nginx:8080}"
REDIS_URL="${REDIS_URL:-redis://redis:6379}"
PUBLIC_DOMAIN="${PUBLIC_DOMAIN:-}"
LOG_FILE="/tmp/cloudflared.log"
EDGE_REGION="${EDGE_REGION:-}"            # us | (empty = auto, fastest)
PROTOCOL="${PROTOCOL:-http2}"             # http2 | quic | auto
EXTRA_ARGS="${EXTRA_ARGS:-}"

log() { echo "[$(date -u +%H:%M:%S)] tunnel: $*"; }

# ─── Redis CLI helper ─────────────────────────────────────────
# REDIS_URL parsing — redis://host:port
parse_redis() {
  local u="${REDIS_URL#redis://}"
  REDIS_HOST="${u%%:*}"
  REDIS_PORT="${u##*:}"
  [[ "$REDIS_HOST" == "$REDIS_PORT" ]] && REDIS_PORT=6379
}
parse_redis

redis_publish() {
  redis-cli -h "$REDIS_HOST" -p "$REDIS_PORT" "$@" >/dev/null 2>&1 || true
}

# ─── Build cloudflared args ──────────────────────────────────
COMMON_ARGS=(
  --no-autoupdate
  --protocol "$PROTOCOL"
  --edge-ip-version auto
)
[[ -n "$EDGE_REGION" ]] && COMMON_ARGS+=(--region "$EDGE_REGION")

# ─── Decide mode and run ─────────────────────────────────────
if [[ -n "${TUNNEL_TOKEN:-}" ]]; then
  log "Starting NAMED tunnel via token"
  if [[ -z "$PUBLIC_DOMAIN" ]]; then
    log "WARNING: TUNNEL_TOKEN set but PUBLIC_DOMAIN not — the API won't know"
    log "         your hostname. Set PUBLIC_DOMAIN=https://your.domain in env."
  fi
  CMD=(cloudflared tunnel "${COMMON_ARGS[@]}" $EXTRA_ARGS run --token "$TUNNEL_TOKEN")
elif [[ -f /etc/cloudflared/config.yml ]]; then
  TNAME="${TUNNEL_NAME:-}"
  log "Starting NAMED tunnel from config.yml (tunnel=${TNAME:-default})"
  CMD=(cloudflared tunnel "${COMMON_ARGS[@]}" --config /etc/cloudflared/config.yml $EXTRA_ARGS run ${TNAME})
else
  log "Starting QUICK tunnel → $TARGET_URL"
  CMD=(cloudflared tunnel "${COMMON_ARGS[@]}" $EXTRA_ARGS --url "$TARGET_URL")
fi

log "Exec: ${CMD[*]}"

# Run cloudflared in background, tee logs
"${CMD[@]}" >>"$LOG_FILE" 2>&1 &
CF_PID=$!

# Forward SIGTERM
trap 'log "stopping"; kill -TERM "$CF_PID" 2>/dev/null || true; wait "$CF_PID" 2>/dev/null || true; exit 0' INT TERM

# ─── Detect public URL and push to Redis ─────────────────────
PUBLIC_URL=""

# Case 1: user already told us
if [[ -n "$PUBLIC_DOMAIN" ]]; then
  PUBLIC_URL="${PUBLIC_DOMAIN%/}"
  log "PUBLIC_DOMAIN provided: $PUBLIC_URL"
  redis_publish SET tunnel:public_url "$PUBLIC_URL"
  redis_publish SET tunnel:mode "named"
  redis_publish PUBLISH tunnel:events "{\"event\":\"tunnel:up\",\"url\":\"$PUBLIC_URL\",\"mode\":\"named\"}"
fi

# Case 2: poll the log for the quick-tunnel hostname
if [[ -z "$PUBLIC_URL" ]]; then
  log "Waiting for trycloudflare.com URL..."
  for i in $(seq 1 60); do
    if [[ -f "$LOG_FILE" ]]; then
      URL=$(grep -oE 'https://[a-zA-Z0-9._-]+\.trycloudflare\.com' "$LOG_FILE" | tail -1 || true)
      if [[ -n "$URL" ]]; then
        PUBLIC_URL="$URL"
        log "Got URL: $PUBLIC_URL"
        redis_publish SET tunnel:public_url "$PUBLIC_URL"
        redis_publish SET tunnel:mode "quick"
        redis_publish PUBLISH tunnel:events "{\"event\":\"tunnel:up\",\"url\":\"$PUBLIC_URL\",\"mode\":\"quick\"}"
        break
      fi
    fi
    sleep 1
  done
  [[ -z "$PUBLIC_URL" ]] && log "WARNING: no trycloudflare URL after 60s — check $LOG_FILE"
fi

# Tail cloudflared logs to container stdout so `docker logs` works
tail -F "$LOG_FILE" &
TAIL_PID=$!

# Wait on cloudflared; if it dies, restart loop
wait "$CF_PID"
EXIT=$?
log "cloudflared exited (code=$EXIT)"
kill "$TAIL_PID" 2>/dev/null || true
exit "$EXIT"
