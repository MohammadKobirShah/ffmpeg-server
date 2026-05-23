'use strict';

const { spawn } = require('child_process');

/**
 * Probe an input URL with ffprobe and pick ONE audio track by language priority.
 *
 * Returns { videoIndex, audioIndex, language, allStreams } or null on failure.
 *
 *   audio.mode        'auto' | 'language' | 'index' | 'all' | 'none'
 *   audio.priority    ['ben','hin','eng']   (auto mode)
 *   audio.language    'ben' | 'eng' | ...   (language mode)
 *   audio.trackIndex  number                (index mode — absolute stream index)
 *
 * 'all' returns null → caller should not pass -map flags (ffmpeg default = first
 *       video + first audio; many demuxers will pick all).
 * 'none' is handled by the caller (audio dropped via -an).
 */

// Common ISO-639 aliases → 3-letter code we compare against
const LANG_ALIASES = {
  ben: 'ben', beng: 'ben', bengali: 'ben', bn: 'ben',
  hin: 'hin', hindi: 'hin', hi: 'hin',
  eng: 'eng', english: 'eng', en: 'eng',
  ara: 'ara', arabic: 'ara', ar: 'ara',
  spa: 'spa', spanish: 'spa', es: 'spa',
  fra: 'fra', fre: 'fra', french: 'fra', fr: 'fra',
  deu: 'deu', ger: 'deu', german: 'deu', de: 'deu',
  rus: 'rus', russian: 'rus', ru: 'rus',
  por: 'por', portuguese: 'por', pt: 'por',
  jpn: 'jpn', japanese: 'jpn', ja: 'jpn',
  kor: 'kor', korean: 'kor', ko: 'kor',
  zho: 'zho', chi: 'zho', chinese: 'zho', zh: 'zho',
  tam: 'tam', tamil: 'tam', ta: 'tam',
  tel: 'tel', telugu: 'tel', te: 'tel',
  urd: 'urd', urdu: 'urd', ur: 'urd',
};

function normalizeLang(s) {
  if (!s) return 'und';
  const k = String(s).toLowerCase().trim();
  return LANG_ALIASES[k] || k.slice(0, 3);
}

/** Run ffprobe and return parsed JSON, or null if it fails. */
function ffprobe(url, { headers = {}, timeoutMs = 25000 } = {}) {
  return new Promise((resolve) => {
    const args = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_entries', 'stream=index,codec_type,codec_name,channels:stream_tags=language,title',
      '-user_agent', 'Mozilla/5.0 (compatible; FFmpegProbe/1.0)',
      '-probesize', '3000000',
      '-analyzeduration', '3000000',
    ];

    if (headers && Object.keys(headers).length) {
      const headerStr = Object.entries(headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n') + '\r\n';
      args.push('-headers', headerStr);
    }

    args.push(url);

    const proc = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try { proc.kill('SIGKILL'); } catch (_) {}
    }, timeoutMs);

    proc.stdout.on('data', (b) => (out += b.toString()));
    proc.on('error', () => { clearTimeout(timer); resolve(null); });
    proc.on('exit', () => {
      clearTimeout(timer);
      if (killed) return resolve(null);
      try {
        const json = JSON.parse(out || '{}');
        resolve(json);
      } catch (_) {
        resolve(null);
      }
    });
  });
}

/**
 * Inspect the streams object and choose a single audio track.
 * Returns { videoIndex, audioIndex, language, audioCodec, audioChannels, allStreams }
 */
function pickTrack(streams, audio) {
  const mode = audio.mode || 'auto';
  const videos = streams.filter((s) => s.codec_type === 'video');
  const audios = streams.filter((s) => s.codec_type === 'audio');

  const videoIndex = videos.length ? videos[0].index : null;

  if (!audios.length || mode === 'none') {
    return { videoIndex, audioIndex: null, language: null, allStreams: streams };
  }

  // Annotate audio with normalized language
  const annotated = audios.map((s) => ({
    index: s.index,
    codec: s.codec_name,
    channels: s.channels,
    lang: normalizeLang(s.tags && s.tags.language),
    title: (s.tags && s.tags.title) || '',
  }));

  let chosen = null;
  let label = null;

  if (mode === 'index' && typeof audio.trackIndex === 'number') {
    chosen = annotated.find((a) => a.index === audio.trackIndex) || null;
    label = chosen ? `index:${chosen.index}` : null;
  } else if (mode === 'language' && audio.language) {
    const want = normalizeLang(audio.language);
    chosen = annotated.find((a) => a.lang === want) || null;
    label = chosen ? want : null;
  } else if (mode === 'all') {
    // Caller will not pass -map; ffmpeg default behavior applies.
    return { videoIndex, audioIndex: 'ALL', language: 'all', allStreams: streams };
  } else {
    // auto — priority list, fallback to first audio
    const priority = (audio.priority && audio.priority.length
      ? audio.priority
      : ['ben', 'hin', 'eng']).map(normalizeLang);

    for (const want of priority) {
      const match = annotated.find((a) => a.lang === want);
      if (match) { chosen = match; label = want; break; }
    }
    if (!chosen) {
      chosen = annotated[0];
      label = chosen.lang && chosen.lang !== 'und' ? chosen.lang : 'default';
    }
  }

  if (!chosen) {
    // Asked for a specific language/index but it wasn't there → fallback to first
    chosen = annotated[0];
    label = chosen.lang && chosen.lang !== 'und' ? chosen.lang : 'default';
  }

  return {
    videoIndex,
    audioIndex: chosen.index,
    language: label,
    audioCodec: chosen.codec,
    audioChannels: chosen.channels,
    allStreams: streams,
  };
}

async function probe(url, { audio = {}, headers = {}, timeoutMs = 25000 } = {}) {
  const data = await ffprobe(url, { headers, timeoutMs });
  if (!data || !Array.isArray(data.streams) || !data.streams.length) {
    return null;
  }
  return pickTrack(data.streams, audio);
}

module.exports = { probe, normalizeLang };
