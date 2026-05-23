'use strict';

const express = require('express');
const http = require('http');
const { Server: IOServer } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const winston = require('winston');
const client = require('prom-client');
const { v4: uuidv4 } = require('uuid');

const StreamRegistry = require('./lib/StreamRegistry');
const PlaylistManager = require('./lib/PlaylistManager');
const QueueManager = require('./lib/QueueManager');
const TunnelInfo = require('./lib/TunnelInfo');

// ─── Logger ──────────────────────────────────────────────────
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message, ...meta }) => {
      const extra = Object.keys(meta).length ? ' ' + JSON.stringify(meta) : '';
      return `${timestamp} [${level}] ${message}${extra}`;
    })
  ),
  transports: [new winston.transports.Console()],
});

// ─── Prometheus ──────────────────────────────────────────────
const register = new client.Registry();
client.collectDefaultMetrics({ register });
const activeStreamsGauge = new client.Gauge({
  name: 'ffmpeg_active_streams',
  help: 'Number of active FFmpeg streams (as reported by workers)',
  registers: [register],
});
const streamRequestsCounter = new client.Counter({
  name: 'ffmpeg_stream_requests_total',
  help: 'Total stream requests',
  labelNames: ['status', 'mode'],
  registers: [register],
});

// ─── App ─────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const io = new IOServer(server, {
  path: '/ws',
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const registry = new StreamRegistry({ logger });
const playlistManager = new PlaylistManager({ logger });
const queueManager = new QueueManager({ logger, io });
const tunnel = new TunnelInfo({ logger });

queueManager.onWorkerEvent(async (event, payload) => {
  if (event === 'stream:started') {
    await registry.markRunning(payload.channelId, payload);
    io.emit('stream:started', payload);
  } else if (event === 'stream:stopped' || event === 'stream:error') {
    await registry.markStopped(payload.channelId, payload);
    io.emit(event, payload);
  }
  activeStreamsGauge.set(await registry.countActive());
});

tunnel.onChange((url, mode) => {
  io.emit('tunnel:up', { url, mode });
});

// ─── Helpers ─────────────────────────────────────────────────
const VALID_AUDIO_MODES = new Set(['auto', 'language', 'index', 'all', 'none']);
const VALID_MODES = new Set(['copy', 'transcode']);

function normalizeJobInput(body) {
  const {
    url,
    channelId,
    channelName,
    qualities = ['540p', '720p'],
    headers = {},
    mode = 'transcode',
    audio = { mode: 'auto', priority: ['ben', 'hin', 'eng'] },
  } = body || {};

  if (!url || !channelId) throw new Error('url and channelId are required');
  if (!VALID_MODES.has(mode)) throw new Error(`mode must be one of: ${[...VALID_MODES].join(', ')}`);
  if (!VALID_AUDIO_MODES.has(audio.mode || 'auto')) {
    throw new Error(`audio.mode must be one of: ${[...VALID_AUDIO_MODES].join(', ')}`);
  }

  return {
    url,
    channelId: String(channelId).replace(/[^a-zA-Z0-9_-]/g, '_'),
    channelName: channelName || channelId,
    qualities: Array.isArray(qualities) ? qualities : ['540p', '720p'],
    headers,
    mode,
    audio: {
      mode: audio.mode || 'auto',
      priority: audio.priority || ['ben', 'hin', 'eng'],
      language: audio.language,
      trackIndex: audio.trackIndex,
    },
  };
}

function buildEndpoints(channelId, mode, qualities) {
  const base = tunnel.getUrl() || '';
  const rel = mode === 'copy'
    ? { source: `/hls/${channelId}/source/index.m3u8` }
    : qualities.reduce((a, q) => ({ ...a, [q]: `/hls/${channelId}/${q}/index.m3u8` }), {});
  const abs = {};
  for (const [k, v] of Object.entries(rel)) abs[k] = base + v;
  return { relative: rel, public: base ? abs : null };
}

// ─── Routes ──────────────────────────────────────────────────
app.get('/health', async (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    activeStreams: await registry.countActive(),
    tunnel: { url: tunnel.getUrl(), mode: tunnel.getMode() },
    timestamp: new Date().toISOString(),
  });
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.get('/tunnel', (req, res) => {
  res.json({
    url: tunnel.getUrl(),
    mode: tunnel.getMode(),
    ready: Boolean(tunnel.getUrl()),
  });
});

app.post('/stream/start', async (req, res) => {
  try {
    const job = normalizeJobInput(req.body);
    const streamId = uuidv4();

    const bullJob = await queueManager.addTranscodeJob({ streamId, ...job, requestedBy: req.ip });

    await registry.markQueued(job.channelId, {
      streamId, jobId: bullJob.id,
      qualities: job.qualities, mode: job.mode, audioMode: job.audio.mode,
    });
    streamRequestsCounter.inc({ status: 'queued', mode: job.mode });
    logger.info('Stream queued', { channelId: job.channelId, mode: job.mode });

    const endpoints = buildEndpoints(job.channelId, job.mode, job.qualities);
    const base = tunnel.getUrl();

    res.json({
      success: true,
      streamId,
      jobId: bullJob.id,
      mode: job.mode,
      audio: job.audio,
      masterPlaylist: `/hls/${job.channelId}/master.m3u8`,
      publicMasterPlaylist: base ? `${base}/hls/${job.channelId}/master.m3u8` : null,
      tunnel: { url: base, mode: tunnel.getMode() },
      endpoints: endpoints.relative,
      publicEndpoints: endpoints.public,
    });
  } catch (err) {
    logger.error('Failed to start stream', { error: err.message });
    res.status(400).json({ error: err.message });
  }
});

app.post('/stream/stop/:channelId', async (req, res) => {
  try {
    await queueManager.requestStop(req.params.channelId);
    res.json({ success: true, message: `Stop requested for ${req.params.channelId}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/stream/status/:channelId', async (req, res) => {
  const s = await registry.get(req.params.channelId);
  if (!s || !s.channelId) return res.status(404).json({ error: 'Channel not found' });
  const base = tunnel.getUrl();
  s.publicMasterPlaylist = base ? `${base}/hls/${req.params.channelId}/master.m3u8` : null;
  res.json(s);
});

app.get('/streams', async (req, res) => {
  const streams = await registry.list();
  const base = tunnel.getUrl();
  if (base) {
    streams.forEach((s) => {
      s.publicMasterPlaylist = `${base}/hls/${s.channelId}/master.m3u8`;
    });
  }
  res.json({ total: streams.length, streams, tunnel: { url: base, mode: tunnel.getMode() } });
});

// ─── Playlist Management ─────────────────────────────────────
app.post('/playlist/load', async (req, res) => {
  try {
    const {
      url, name, autoStart = false,
      qualities = ['540p', '720p'], mode = 'transcode',
      audio = { mode: 'auto', priority: ['ben', 'hin', 'eng'] },
    } = req.body || {};
    if (!url || !name) return res.status(400).json({ error: 'url and name are required' });

    logger.info(`Loading playlist ${name} from ${url}`);
    const channels = await playlistManager.loadM3U(url);
    const playlistId = await playlistManager.savePlaylist(name, channels);

    if (autoStart) {
      const jobs = await queueManager.bulkTranscode(channels, { qualities, mode, audio });
      return res.json({ success: true, playlistId, channels: channels.length, jobs: jobs.length, mode });
    }
    res.json({ success: true, playlistId, channels: channels.length, preview: channels.slice(0, 10) });
  } catch (err) {
    logger.error('Playlist load failed', { error: err.message });
    res.status(500).json({ error: err.message });
  }
});

app.get('/playlist/:name/master.m3u8', async (req, res) => {
  try {
    const m3u8 = await playlistManager.getMasterPlaylist(req.params.name, { baseUrl: tunnel.getUrl() });
    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    res.send(m3u8);
  } catch (err) {
    res.status(404).json({ error: 'Playlist not found' });
  }
});

app.get('/playlist/:name/channels', async (req, res) => {
  const { group, search, page, limit } = req.query;
  res.json(await playlistManager.getChannels(req.params.name, {
    group, search,
    page: parseInt(page || '1', 10),
    limit: parseInt(limit || '100', 10),
  }));
});

app.get('/queue/stats', async (req, res) => {
  res.json(await queueManager.getQueueStats());
});

// ─── WebSocket ───────────────────────────────────────────────
io.on('connection', (socket) => {
  logger.info(`WS client connected: ${socket.id}`);
  socket.emit('tunnel:up', { url: tunnel.getUrl(), mode: tunnel.getMode() });
  socket.on('subscribe:stream', (channelId) => {
    socket.join(`stream:${channelId}`);
    socket.emit('subscribed', { channelId });
  });
  socket.on('disconnect', () => logger.info(`WS client disconnected: ${socket.id}`));
});

// ─── Start ───────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
  logger.info(`🚀 FFmpeg API listening on :${PORT}`);
  queueManager.start();
  await tunnel.start();
});

['SIGTERM', 'SIGINT'].forEach((sig) =>
  process.on(sig, async () => {
    logger.info(`${sig} received, shutting down`);
    server.close();
    await Promise.all([
      tunnel.shutdown().catch(() => {}),
      registry.shutdown().catch(() => {}),
      playlistManager.shutdown().catch(() => {}),
      queueManager.shutdown().catch(() => {}),
    ]);
    setTimeout(() => process.exit(0), 2000).unref();
  })
);

module.exports = { app, io };
