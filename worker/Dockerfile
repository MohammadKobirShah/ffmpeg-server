# CPU-only FFmpeg worker
FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY . .

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "worker.js"]
