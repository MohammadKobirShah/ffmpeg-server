#!/usr/bin/env bash
# scripts/deploy.sh — build & start the stack
set -euo pipefail

cd "$(dirname "$0")/.."

echo "🚀 Building images..."
docker compose build --parallel

echo "🚀 Starting core services..."
docker compose up -d

echo "⏳ Waiting for API..."
for i in {1..30}; do
  if curl -fsS http://localhost:3000/health >/dev/null 2>&1; then
    echo "✅ API is up."
    break
  fi
  sleep 1
done

curl -s http://localhost:3000/health | python3 -m json.tool || true

cat <<EOF

✅ Stack deployed.

Endpoints:
  HLS (via nginx):    http://localhost:8080/hls/<channelId>/master.m3u8
  API:                http://localhost:3000
  API health:         http://localhost:3000/health
  API metrics:        http://localhost:3000/metrics

Quick start:
  ./scripts/start_channel.sh "http://your-stream.m3u8" cnn "CNN"
  ./scripts/load_playlist.sh  "http://provider/playlist.m3u" my_iptv
  ./scripts/monitor.sh

Scale workers:
  docker compose up -d --scale worker=8

Enable Grafana/Prometheus:
  docker compose --profile monitoring up -d
EOF
