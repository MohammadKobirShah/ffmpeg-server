# FFmpeg HLS Transcoding Server

Containerized stack that ingests live source streams (HLS / MPEG-TS / RTMP-over-HTTP / …), processes them with FFmpeg, and serves multi-bitrate HLS through nginx with adaptive bitrate.

Supports two processing modes:

| Mode | What it does | When to use it |
|---|---|---|
| **`copy`** | Remux only — no re-encode. Picks one audio track, repackages into HLS. | Source is already H.264/AAC. **Lowest CPU.** Best for "restream as-is". |
| **`transcode`** | Full ABR ladder (360p–1080p) with x264 + AAC. | You need adaptive bitrate, your source is in a non-browser-friendly codec, or you want to normalize quality. |

Both modes do **single-language audio auto-selection** by default (Bengali → Hindi → English → first available, configurable).

```
┌─────────────────────────────────────────────────────────┐
│                    FFmpeg Server Stack                  │
├─────────────────┬───────────────┬───────────────────────┤
│  Nginx (HLS)    │  Node.js API  │   FFmpeg Workers      │
│  :8080          │  :3000        │   (Bull consumers)    │
├─────────────────┴───────────────┴───────────────────────┤
│              Redis (queue + state)  :6379               │
└─────────────────────────────────────────────────────────┘
```

## Public access via Cloudflare Tunnel

A `tunnel` sidecar (cloudflared) is included and starts automatically. Two modes:

### Mode A — Quick Tunnel (default, zero-config)

No setup required. You get a random `https://<something>.trycloudflare.com` URL
that the tunnel sidecar writes into Redis. The API picks it up and includes it
in every response (`publicMasterPlaylist`, `publicEndpoints`, etc.) and in
`/playlist/:name/master.m3u8`.

```bash
docker compose up -d
./scripts/tunnel_url.sh --watch
# → https://lively-banana-1234.trycloudflare.com
```

> ⚠️ Quick Tunnels are **ephemeral**. The URL changes on every restart and
> Cloudflare may throttle. Use Mode B for anything real.

### Mode B — Named Tunnel via token (production)

1. Cloudflare Zero Trust → **Networks → Tunnels → Create tunnel**
2. Copy the **tunnel token**
3. Add a **public hostname** route → service `http://nginx:8080`
4. Set these in `.env` (copy from `.env.example`):

   ```dotenv
   TUNNEL_TOKEN=eyJhIjoi...
   PUBLIC_DOMAIN=https://hls.yourdomain.com
   ```

5. Restart:

   ```bash
   docker compose up -d --force-recreate tunnel api
   ```

The API will now use `https://hls.yourdomain.com` everywhere.

### Performance knobs (fastest server)

| Variable | Effect |
|---|---|
| `TUNNEL_PROTOCOL=http2` *(default)* | Most compatible. |
| `TUNNEL_PROTOCOL=quic` | Fastest if your egress allows UDP — lower handshake latency, better on lossy networks. |
| `TUNNEL_PROTOCOL=auto` | Let cloudflared pick. |
| `TUNNEL_REGION=` *(default, auto)* | Cloudflare auto-routes to the nearest edge — usually fastest. |
| `TUNNEL_REGION=us` | Pin to US edge if your audience is there. |

The sidecar also passes `--edge-ip-version auto` so it can use IPv6 when faster.

### Inspect tunnel state

```bash
curl http://localhost:3000/tunnel
# { "url": "https://...trycloudflare.com", "mode": "quick", "ready": true }

./scripts/tunnel_url.sh
./scripts/tunnel_url.sh --watch     # block until ready
```

Both Quick Tunnels and Named Tunnels publish `tunnel:up` events over the
WebSocket (`/ws`), so any connected client gets the URL pushed immediately.

---

## Quick start

```bash
cd ffmpeg-server
chmod +x scripts/*.sh scripts/*.py
./scripts/deploy.sh
```

Play any started stream with VLC / hls.js / Safari:

    http://localhost:8080/hls/<channelId>/master.m3u8

---

## Audio track selection

When a job starts, the worker runs `ffprobe` on the source first and picks **one** audio track based on the `audio.mode` you pass:

| `audio.mode` | Behavior |
|---|---|
| `auto`     *(default)* | Priority list (default `[ben, hin, eng]`); falls back to the first available track. |
| `language` | Pick first track whose `tags:language` matches `audio.language` (ISO-639-2/3 or common names). Falls back to first if not found. |
| `index`    | Pick the absolute ffmpeg stream index `audio.trackIndex` (use `./scripts/probe_audio.sh` to find it). |
| `all`      | Don't pass `-map` — let ffmpeg keep its default (first video + first audio). |
| `none`     | Drop audio entirely (`-an`). |

The worker writes the chosen language into Redis (`stream:<channelId>.audioLanguage`) and into the `## audio:` comment of the generated `master.m3u8`.

---

## API examples

### 1. Restream as-is (copy mode), auto-pick best audio

```bash
curl -X POST http://localhost:3000/stream/start \
  -H 'Content-Type: application/json' \
  -d '{
    "url": "https://upstream.example/source.m3u8",
    "channelId": "ndtv",
    "channelName": "NDTV",
    "mode": "copy"
  }'
```

Resulting master: `http://localhost:8080/hls/ndtv/master.m3u8`
Single rendition under: `http://localhost:8080/hls/ndtv/source/index.m3u8`

### 2. ABR transcode with forced Bengali audio

```bash
curl -X POST http://localhost:3000/stream/start \
  -H 'Content-Type: application/json' \
  -d '{
    "url": "https://upstream.example/multi-audio.m3u8",
    "channelId": "channel_i",
    "channelName": "Channel i",
    "mode": "transcode",
    "qualities": ["480p", "720p"],
    "audio": { "mode": "language", "language": "ben" }
  }'
```

### 3. Pick the 3rd audio stream by index

First inspect:

```bash
./scripts/probe_audio.sh https://upstream.example/source.m3u8
```

Then:

```bash
curl -X POST http://localhost:3000/stream/start \
  -H 'Content-Type: application/json' \
  -d '{
    "url": "https://upstream.example/source.m3u8",
    "channelId": "espn_es",
    "channelName": "ESPN (ES)",
    "mode": "copy",
    "audio": { "mode": "index", "trackIndex": 3 }
  }'
```

### 4. Custom auto-priority (Hindi first, then Tamil, then English)

```bash
curl -X POST http://localhost:3000/stream/start \
  -H 'Content-Type: application/json' \
  -d '{
    "url": "https://upstream.example/source.m3u8",
    "channelId": "sun_tv",
    "channelName": "Sun TV",
    "mode": "copy",
    "audio": { "mode": "auto", "priority": ["hin", "tam", "eng"] }
  }'
```

### 5. Referer-protected source (custom HTTP headers)

```bash
curl -X POST http://localhost:3000/stream/start \
  -H 'Content-Type: application/json' \
  -d '{
    "url": "https://protected.example/live/x.m3u8",
    "channelId": "hbo",
    "channelName": "HBO",
    "mode": "copy",
    "headers": {
      "Referer": "https://protected.example/",
      "Origin":  "https://protected.example"
    }
  }'
```

### 6. Load a full M3U playlist and copy-restream every channel

```bash
curl -X POST http://localhost:3000/playlist/load \
  -H 'Content-Type: application/json' \
  -d '{
    "url": "https://provider/playlist.m3u",
    "name": "my_iptv",
    "autoStart": true,
    "mode": "copy",
    "audio": { "mode": "auto", "priority": ["ben", "hin", "eng"] }
  }'
```

Then the aggregate playlist that points to all your restreamed channels:

    http://localhost:8080/api/playlist/my_iptv/master.m3u8

### 7. Drop audio (video only)

```bash
curl -X POST http://localhost:3000/stream/start \
  -H 'Content-Type: application/json' \
  -d '{
    "url": "https://upstream.example/source.m3u8",
    "channelId": "silent_cam",
    "mode": "copy",
    "audio": { "mode": "none" }
  }'
```

---

## CLI helpers

All scripts wrap the API calls above with sensible defaults.

```bash
# Inspect what audio streams exist on a source
./scripts/probe_audio.sh https://upstream.example/source.m3u8

# Copy mode, auto audio (Bengali>Hindi>English)
./scripts/start_channel.sh https://upstream.example/x.m3u8 zee5 "Zee5" --mode copy

# Transcode + force Hindi
./scripts/start_channel.sh https://upstream.example/x.m3u8 sony "Sony" \
  --qualities 480p,720p --audio-mode language --audio-lang hin

# Index-based pick
./scripts/start_channel.sh https://upstream.example/x.m3u8 espn "ESPN" \
  --mode copy --audio-mode index --audio-index 3

# Custom auto priority
./scripts/start_channel.sh https://upstream.example/x.m3u8 sun "Sun TV" \
  --mode copy --audio-priority hin,tam,eng

# Referer-protected
./scripts/start_channel.sh https://protected.example/x.m3u8 hbo "HBO" \
  --mode copy \
  --header "Referer: https://protected.example/" \
  --header "Origin: https://protected.example"

# Stop a channel
./scripts/stop_channel.sh zee5

# Load a whole M3U + auto-start as copy
./scripts/load_playlist.sh https://provider/playlist.m3u my_iptv \
  --auto-start --mode copy

# Live TUI status
./scripts/monitor.sh
```

---

## Stream payload reference

```jsonc
{
  "url": "https://…",            // REQUIRED — source stream
  "channelId": "cnn",            // REQUIRED — used in URL paths
  "channelName": "CNN",          // optional

  "mode": "copy" | "transcode",  // default: "transcode"

  "qualities": ["540p","720p"],  // only for transcode mode
                                 // valid: 360p|480p|540p|720p|1080p

  "audio": {
    "mode": "auto" | "language" | "index" | "all" | "none",
    "priority":  ["ben","hin","eng"],     // for mode=auto
    "language":  "ben",                    // for mode=language
    "trackIndex": 3                        // for mode=index
  },

  "headers": { "Referer": "…", … }   // optional HTTP request headers
}
```

Supported language codes (auto-normalized): `ben/bn/bengali`, `hin/hi/hindi`, `eng/en/english`, `ara/ar`, `spa/es`, `fra/fr`, `deu/de`, `rus/ru`, `por/pt`, `jpn/ja`, `kor/ko`, `zho/zh`, `tam/ta`, `tel/te`, `urd/ur`. Anything else falls through as a 3-letter code.

---

## Architecture notes

- **API (`api/`)** — Express + socket.io. Owns playlist parsing, the Redis-backed registry, and the Bull `transcode` queue. **The API never spawns ffmpeg.**
- **Worker (`worker/`)** — Sole ffmpeg spawner. On each job:
  1. `ffprobe` the source (best-effort; 25s timeout).
  2. Choose audio track per `audio.mode`.
  3. Write `master.m3u8`.
  4. Spawn ffmpeg with the proper `-map` and per-mode encoding/muxing flags.
  5. Publish lifecycle events on Redis pub/sub `worker:events`.
- **nginx** — Serves the shared `hls_data` volume read-only with proper HLS cache headers (segments cacheable, playlists `no-cache`).
- **Redis** — Bull queues + stream/channel state.

## Scaling

```bash
docker compose up -d --scale worker=8
# Per-worker concurrency: WORKER_CONCURRENCY env var (default 2)
```

Rough x264 `veryfast` budget:
- 720p30 ≈ 0.5–1.0 vCPU
- 1080p30 ≈ 1.5–2.5 vCPU
- **copy mode ≈ 0.05 vCPU** (it's just remuxing)

If you can use `copy`, do — it scales 10-50× better.

## Monitoring (optional)

```bash
docker compose --profile monitoring up -d
# Grafana:    http://localhost:3001  (admin / admin123)
# Prometheus: http://localhost:9090
```

API exposes Prometheus metrics at `/metrics`:
- `ffmpeg_active_streams` (gauge)
- `ffmpeg_stream_requests_total{status,mode}` (counter)
- default Node.js process metrics

## Notes & limitations

- **No auth.** Put it behind your own gateway/VPN if exposing publicly.
- **CPU only.** Add a `worker-gpu` service with a CUDA-based image if you want NVENC.
- A job "completes" as soon as the first segment is written; the ffmpeg process keeps running owned by the worker. If the worker dies, the stream stops — the next `start` call will reschedule it.
- Renditions live on a shared Docker volume mounted into nginx read-only. For multi-host setups, replace with S3 + CDN.
