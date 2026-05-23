'use strict';

const Bull = require('bull');
const Redis = require('ioredis');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');

const { probe: probeAudio } = require('./lib/AudioProbe');

const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';
const HLS_OUTPUT = process.env.HLS_OUTPUT || '/var/www/hls';
const SEGMENT_DURATION = parseInt(process.env.SEGMENT_DURATION || '4', 10);
const HLS_LIST_SIZE = parseInt(process.env.HLS_LIST_SIZE || '6', 10);
const WORKER_CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || '2', 10);
const WORKER_ID = process.env.HOSTNAME || `worker-${process.pid}`;

const COPY_BANDWIDTH = parseInt(process.env.COPY_BANDWIDTH || '2500000', 10);

const redis = new Redis(REDIS_URL);
const pub = new Redis(REDIS_URL);

// ─── Quality presets (transcode mode) ───────────────────────
const QUALITY = {
  '360p':  { w: 640,  h: 360,  vbr: '500k',  max: '600k',   buf: '1000k', abr: '64k',  fps: 25, profile: 'baseline', level: '3.0', preset: 'veryfast' },
  '480p':  { w: 854,  h: 480,  vbr: '1000k', max: '1200k',  buf: '2000k', abr: '96k',  fps: 25, profile: 'main',     level: '3.1', preset: 'veryfast' },
  '540p':  { w: 960,  h: 540,  vbr: '1500k', max: '1800k',  buf: '3000k', abr: '128k', fps: 25, profile: 'main',     level: '3.1', preset: 'veryfast' },
  '720p':  { w: 1280, h: 720,  vbr: '3000k', max: '3500k',  buf: '6000k', abr: '128k', fps: 30, profile: 'main',     level: '4.0', preset: 'veryfast' },
  '1080p': { w: 1920, h: 1080, vbr: '6000k', max: '7000k',  buf: '12000k',abr: '192k', fps: 30, profile: 'high',     level: '4.1', preset: 'fast'     },
};

const MASTER_BW = {
  '360p':  { bw: 564000,  avg: 400000,  res: '640x360',   fps: '25.000', codecs: 'avc1.42c01e,mp4a.40.2' },
  '480p':  { bw: 1096000, avg: 800000,  res: '854x480',   fps: '25.000', codecs: 'avc1.4d401f,mp4a.40.2' },
  '540p':  { bw: 1628000, avg: 1200000, res: '960x540',   fps: '25.000', codecs: 'avc1.4d401f,mp4a.40.2' },
  '720p':  { bw: 3128000, avg: 2400000, res: '1280x720',  fps: '30.000', codecs: 'avc1.4d401f,mp4a.40.2' },
  '1080p': { bw: 6192000, avg: 5000000, res: '1920x1080', fps: '30.000', codecs: 'avc1.640028,mp4a.40.2' },
};

const transcodeQueue = new Bull('transcode', { redis: REDIS_URL });
const controlQueue   = new Bull('control',   { redis: REDIS_URL });

const processes = new Map(); // channelId -> { proc, stopping }

function log(...args) { console.log(`[${WORKER_ID}]`, ...args); }
function emitEvent(event, payload) {
  pub.publish('worker:events', JSON.stringify({ event, payload, worker: WORKER_ID }))
     .catch((e) => log('publish error', e.message));
}

// ─── Filesystem prep ────────────────────────────────────────
async function ensureDirs(channelId, qualities) {
  const outDir = path.join(HLS_OUTPUT, channelId);
  await fs.mkdir(outDir, { recursive: true });
  for (const q of qualities) {
    await fs.mkdir(path.join(outDir, q), { recursive: true });
  }
  return outDir;
}

async function writeMasterPlaylist(outDir, channelName, qualities, audioLabel) {
  const sorted = [...qualities].sort((a, b) => (QUALITY[a]?.w || 0) - (QUALITY[b]?.w || 0));
  let m = '#EXTM3U\n';
  m += '#EXT-X-VERSION:6\n';
  m += '#EXT-X-INDEPENDENT-SEGMENTS\n';
  m += `## ${channelName} — generated ${new Date().toISOString()}\n`;
  if (audioLabel) m += `## audio: ${audioLabel}\n`;
  m += '\n';

  for (const q of sorted) {
    const bw = MASTER_BW[q];
    if (!bw) continue;
    m += '#EXT-X-STREAM-INF:';
    m += `BANDWIDTH=${bw.bw},`;
    m += `AVERAGE-BANDWIDTH=${bw.avg},`;
    m += `RESOLUTION=${bw.res},`;
    m += `FRAME-RATE=${bw.fps},`;
    m += `CODECS="${bw.codecs}",`;
    m += `NAME="${q}"\n`;
    m += `${q}/index.m3u8\n\n`;
  }
  await fs.writeFile(path.join(outDir, 'master.m3u8'), m);
}

/** "copy" mode master — single rendition, codecs unknown so keep generic */
async function writeCopyMaster(outDir, channelName, audioLabel) {
  let m = '#EXTM3U\n';
  m += '#EXT-X-VERSION:3\n';
  m += `## ${channelName} — copy/remux\n`;
  if (audioLabel) m += `## audio: ${audioLabel}\n`;
  m += `#EXT-X-STREAM-INF:BANDWIDTH=${COPY_BANDWIDTH}\n`;
  m += 'source/index.m3u8\n';
  await fs.writeFile(path.join(outDir, 'master.m3u8'), m);
}

// ─── Build the -map args from a probe result ────────────────
function buildMapArgs(pick, audioMode) {
  if (audioMode === 'none') return ['-an'];

  if (!pick) return []; // Couldn't probe; let ffmpeg pick defaults.

  if (pick.audioIndex === 'ALL') {
    return []; // Don't constrain; default behavior keeps first video + first audio
  }

  const args = [];
  if (pick.videoIndex != null) args.push('-map', `0:${pick.videoIndex}`);
  if (pick.audioIndex != null) args.push('-map', `0:${pick.audioIndex}`);
  if (!args.length) return [];
  // Make audio mapping non-fatal if it disappears mid-stream
  return args;
}

// ─── Transcode-mode ffmpeg args (one output per quality) ────
function buildTranscodeArgs({ url, channelId, qualities, headers, mapArgs }) {
  const outDir = path.join(HLS_OUTPUT, channelId);
  const active = qualities.filter((q) => QUALITY[q]);
  if (!active.length) throw new Error('No valid qualities supplied');

  const args = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-stats',
    '-fflags', '+genpts+igndts+discardcorrupt',
    '-err_detect', 'ignore_err',
    '-reconnect', '1',
    '-reconnect_at_eof', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-rw_timeout', '15000000',
    '-analyzeduration', '5M',
    '-probesize', '5M',
  ];

  if (headers && Object.keys(headers).length) {
    const headerStr = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n';
    args.push('-headers', headerStr);
  }

  args.push('-user_agent', 'Mozilla/5.0 (compatible; FFmpegWorker/2.0)');
  args.push('-i', url);

  for (const q of active) {
    const p = QUALITY[q];
    const qDir = path.join(outDir, q);

    // Map per-output (so we can keep the single picked audio track for every quality)
    if (mapArgs.length) {
      args.push(...mapArgs);
    } else {
      args.push('-map', '0:v:0', '-map', '0:a:0?');
    }

    args.push(
      '-vf', `scale=w=${p.w}:h=${p.h}:force_original_aspect_ratio=decrease,pad=${p.w}:${p.h}:(ow-iw)/2:(oh-ih)/2,fps=${p.fps},format=yuv420p`,
      '-c:v', 'libx264',
      '-preset', p.preset,
      '-profile:v', p.profile,
      '-level', p.level,
      '-pix_fmt', 'yuv420p',
      '-sc_threshold', '0',
      '-g', String(p.fps * 2),
      '-keyint_min', String(p.fps * 2),
      '-b:v', p.vbr,
      '-maxrate', p.max,
      '-bufsize', p.buf,
      '-c:a', 'aac',
      '-b:a', p.abr,
      '-ar', '48000',
      '-ac', '2',
      '-f', 'hls',
      '-hls_time', String(SEGMENT_DURATION),
      '-hls_list_size', String(HLS_LIST_SIZE),
      '-hls_flags', 'delete_segments+append_list+program_date_time+independent_segments+temp_file',
      '-hls_segment_type', 'mpegts',
      '-hls_segment_filename', path.join(qDir, '%05d.ts'),
      path.join(qDir, 'index.m3u8')
    );
  }

  return args;
}

// ─── Copy-mode ffmpeg args (single rendition, no re-encode) ──
function buildCopyArgs({ url, channelId, headers, mapArgs }) {
  const outDir = path.join(HLS_OUTPUT, channelId, 'source');

  const args = [
    '-hide_banner',
    '-loglevel', 'warning',
    '-stats',
    '-fflags', '+discardcorrupt+genpts',
    '-flags', 'low_delay',
    '-err_detect', 'ignore_err',
    '-avoid_negative_ts', 'make_zero',
    '-reconnect', '1',
    '-reconnect_at_eof', '1',
    '-reconnect_streamed', '1',
    '-reconnect_delay_max', '5',
    '-rw_timeout', '15000000',
    '-probesize', '1500000',
    '-analyzeduration', '1500000',
  ];

  if (headers && Object.keys(headers).length) {
    const headerStr = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n';
    args.push('-headers', headerStr);
  }
  args.push('-user_agent', 'Mozilla/5.0 (compatible; FFmpegWorker/2.0)');
  args.push('-i', url);

  if (mapArgs.length) {
    args.push(...mapArgs);
  }

  args.push(
    '-c', 'copy',
    '-flush_packets', '1',
    '-max_delay', '500000',
    '-muxdelay', '0.5',
    '-muxpreload', '0.5',
    '-f', 'hls',
    '-hls_time', String(SEGMENT_DURATION),
    '-hls_list_size', String(HLS_LIST_SIZE),
    '-hls_allow_cache', '1',
    '-hls_flags', 'delete_segments+append_list+independent_segments+temp_file',
    '-hls_segment_type', 'mpegts',
    '-hls_segment_filename', path.join(outDir, '%05d.ts'),
    path.join(outDir, 'index.m3u8')
  );

  return args;
}

const PROGRESS_RE = /frame=\s*(\d+).*?fps=\s*([\d.]+).*?bitrate=\s*([\d.]+)kbits.*?speed=\s*([\d.]+)x/;

async function startStream(jobData) {
  const {
    channelId,
    channelName,
    url,
    qualities = ['540p', '720p'],
    headers = {},
    mode = 'transcode',           // 'copy' | 'transcode'
    audio = { mode: 'auto' },      // see AudioProbe.js
  } = jobData;

  // 1) Probe the source (best-effort) — probe first so we have audioLabel for reuse case
  let pick = null;
  try {
    pick = await probeAudio(url, { audio, headers, timeoutMs: 25000 });
    if (pick) {
      log(`Probe ${channelId}: video=${pick.videoIndex} audio=${pick.audioIndex} lang=${pick.language}`);
    } else {
      log(`Probe ${channelId}: failed/empty — ffmpeg will choose defaults`);
    }
  } catch (e) {
    log(`Probe ${channelId} error: ${e.message}`);
  }

  if (processes.has(channelId)) {
    log(`Stream already running for ${channelId}, skipping`);
    const audioLabel = audio.mode === 'none' ? 'none' : (pick ? (pick.language || 'default') : (audio.mode || 'auto'));
    emitEvent('stream:started', { channelId, channelName, mode, qualities, audioLanguage: audioLabel, reused: true });
    return { reused: true };
  }

  const mapArgs = buildMapArgs(pick, audio.mode);
  const audioLabel = audio.mode === 'none' ? 'none' : (pick ? (pick.language || 'default') : (audio.mode || 'auto'));

  // 2) Filesystem layout + master
  let outDir;
  let args;
  if (mode === 'copy') {
    outDir = await ensureDirs(channelId, ['source']);
    await writeCopyMaster(path.join(HLS_OUTPUT, channelId), channelName || channelId, audioLabel);
    args = buildCopyArgs({ url, channelId, headers, mapArgs });
  } else {
    outDir = await ensureDirs(channelId, qualities);
    await writeMasterPlaylist(outDir, channelName || channelId, qualities, audioLabel);
    args = buildTranscodeArgs({ url, channelId, qualities, headers, mapArgs });
  }

  log(`Starting ffmpeg for ${channelId} (mode=${mode}, audio=${audioLabel})`);

  // 3) Persist chosen metadata so the API can show it
  await redis.hset(`stream:${channelId}`, {
    audioLanguage: audioLabel,
    audioIndex: pick && pick.audioIndex != null ? String(pick.audioIndex) : '',
    videoIndex: pick && pick.videoIndex != null ? String(pick.videoIndex) : '',
    mode,
  }).catch(() => {});

  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const slot = { proc, stopping: false };
    processes.set(channelId, slot);

    let resolved = false;
    const firstSegPath = mode === 'copy'
      ? path.join(HLS_OUTPUT, channelId, 'source', '00000.ts')
      : path.join(outDir, qualities[0], '00000.ts');

    const startTimer = setTimeout(() => {
      fs.access(firstSegPath)
        .then(() => { if (!resolved) { resolved = true; resolve({ pid: proc.pid, audio: audioLabel }); } })
        .catch(() => {
          if (!resolved) {
            resolved = true;
            try { proc.kill('SIGKILL'); } catch (_) {}
            reject(new Error('ffmpeg failed to produce segments within 30s'));
          }
        });
    }, 30000);

    proc.stderr.on('data', (buf) => {
      const str = buf.toString();
      if (!resolved && (str.includes('Opening ') || str.includes('frame='))) {
        resolved = true;
        clearTimeout(startTimer);
        resolve({ pid: proc.pid, audio: audioLabel });
        emitEvent('stream:started', {
          channelId, channelName, qualities, mode,
          audioLanguage: audioLabel, pid: proc.pid,
        });
      }
      const m = str.match(PROGRESS_RE);
      if (m) {
        const progress = { frame: m[1], fps: m[2], bitrate: m[3], speed: m[4], ts: Date.now() };
        redis.hset(`progress:${channelId}`, progress).catch(() => {});
        redis.expire(`progress:${channelId}`, 60).catch(() => {});
      }
      str.split('\n').forEach((line) => {
        const t = line.trim();
        if (t) log(`[${channelId}]`, t);
      });
    });

    proc.on('exit', (code, signal) => {
      clearTimeout(startTimer);
      processes.delete(channelId);
      log(`ffmpeg exited for ${channelId} code=${code} signal=${signal}`);
      emitEvent('stream:stopped', { channelId, code, signal, stopping: slot.stopping });
      if (!resolved) {
        resolved = true;
        reject(new Error(`ffmpeg exited before producing output (code=${code})`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(startTimer);
      processes.delete(channelId);
      emitEvent('stream:error', { channelId, error: err.message });
      if (!resolved) { resolved = true; reject(err); }
    });
  });
}

function stopStream(channelId) {
  const slot = processes.get(channelId);
  if (!slot) return false;
  slot.stopping = true;
  try { slot.proc.kill('SIGTERM'); } catch (_) {}
  setTimeout(() => {
    if (processes.has(channelId)) {
      try { slot.proc.kill('SIGKILL'); } catch (_) {}
    }
  }, 5000);
  return true;
}

// ─── Bull consumers ─────────────────────────────────────────
transcodeQueue.process('transcode', WORKER_CONCURRENCY, async (job) => {
  log(`Picked job ${job.id} for ${job.data.channelId}`);
  await job.progress(10);
  const result = await startStream(job.data);
  await job.progress(100);
  return result;
});

controlQueue.process('stop', 5, async (job) => {
  const { channelId } = job.data;
  const ok = stopStream(channelId);
  log(`Stop ${channelId}: ${ok ? 'sent SIGTERM' : 'not running here'}`);
  return { stopped: ok };
});

log(`🎬 FFmpeg worker started — concurrency=${WORKER_CONCURRENCY}, cpus=${os.cpus().length}`);

async function shutdown(sig) {
  log(`${sig} received — stopping ${processes.size} stream(s)`);
  for (const [, slot] of processes.entries()) {
    slot.stopping = true;
    try { slot.proc.kill('SIGTERM'); } catch (_) {}
  }
  setTimeout(async () => {
    try { await redis.quit(); } catch (_) {}
    try { await pub.quit(); } catch (_) {}
    process.exit(0);
  }, 3000).unref();
}
['SIGTERM', 'SIGINT'].forEach((s) => process.on(s, () => shutdown(s)));
