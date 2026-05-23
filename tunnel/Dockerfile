# Cloudflared sidecar — wraps the official binary with a small entrypoint
# that detects the public URL and publishes it to Redis so the API can use it.
FROM cloudflare/cloudflared:latest AS cloudflared

FROM alpine:3.20
RUN apk add --no-cache bash redis grep coreutils tini ca-certificates
COPY --from=cloudflared /usr/local/bin/cloudflared /usr/local/bin/cloudflared

WORKDIR /app
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

ENTRYPOINT ["/sbin/tini", "--", "/app/entrypoint.sh"]
