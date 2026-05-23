#!/usr/bin/env bash
# Real-time stream monitoring
API_URL="${API_URL:-http://localhost:3000}"
watch -n 2 "echo '== /health ==' && curl -s $API_URL/health | python3 -m json.tool && \
            echo && echo '== /streams ==' && curl -s $API_URL/streams | python3 -m json.tool && \
            echo && echo '== /queue/stats ==' && curl -s $API_URL/queue/stats | python3 -m json.tool"
