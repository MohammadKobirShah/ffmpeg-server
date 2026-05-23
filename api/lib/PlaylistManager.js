'use strict';

const axios = require('axios');
const fs = require('fs').promises;
const Redis = require('ioredis');
const { v4: uuidv4 } = require('uuid');

class PlaylistManager {
  constructor({ logger }) {
    this.logger = logger;
    this.redis = new Redis(process.env.REDIS_URL);
    this.playlistDir = process.env.PLAYLIST_DIR || '/playlists';
  }

  async loadM3U(urlOrPath) {
    let content;
    try {
      if (/^https?:\/\//i.test(urlOrPath)) {
        const r = await axios.get(urlOrPath, {
          timeout: 30000,
          headers: { 'User-Agent': 'Mozilla/5.0 IPTV-Loader', Accept: '*/*' },
          responseType: 'text',
          maxContentLength: 50 * 1024 * 1024,
        });
        content = r.data;
      } else {
        content = await fs.readFile(urlOrPath, 'utf8');
      }
    } catch (err) {
      throw new Error(`Failed to fetch playlist: ${err.message}`);
    }
    return this.parseM3U(content);
  }

  parseM3U(content) {
    const lines = content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const channels = [];
    let current = null;

    for (const line of lines) {
      if (line.startsWith('#EXTM3U')) continue;

      if (line.startsWith('#EXTINF')) {
        current = this.parseExtInf(line);
        continue;
      }

      if (line.startsWith('#')) continue; // ignore other tags for now

      if (current) {
        current.url = line;
        current.id = this.generateChannelId(current.name);
        channels.push(current);
        current = null;
      }
    }
    return channels;
  }

  parseExtInf(line) {
    const commaIdx = line.lastIndexOf(',');
    const name = commaIdx !== -1 ? line.substring(commaIdx + 1).trim() : 'Unknown';
    const attrStr = commaIdx !== -1 ? line.substring(0, commaIdx) : line;

    const re = {
      'tvg-id':       /tvg-id="([^"]+)"/,
      'tvg-name':     /tvg-name="([^"]+)"/,
      'tvg-logo':     /tvg-logo="([^"]+)"/,
      'tvg-country':  /tvg-country="([^"]+)"/,
      'tvg-language': /tvg-language="([^"]+)"/,
      'group-title':  /group-title="([^"]+)"/,
    };
    const meta = {};
    for (const [k, r] of Object.entries(re)) {
      const m = attrStr.match(r);
      if (m) meta[k] = m[1];
    }

    return {
      name,
      tvgId: meta['tvg-id'] || '',
      tvgName: meta['tvg-name'] || name,
      logo: meta['tvg-logo'] || '',
      group: meta['group-title'] || 'Uncategorized',
      country: meta['tvg-country'] || '',
      language: meta['tvg-language'] || '',
      url: '',
      id: '',
    };
  }

  generateChannelId(name) {
    return (
      name
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '_')
        .replace(/_+/g, '_')
        .slice(0, 50) +
      '_' +
      uuidv4().split('-')[0]
    );
  }

  async savePlaylist(name, channels) {
    const playlistId = uuidv4();
    const listKey = `playlist:${name}`;
    await this.redis.del(listKey);

    const pipe = this.redis.pipeline();
    channels.forEach((ch, i) => {
      pipe.hset(`channel:${ch.id}`, ch);
      pipe.zadd(listKey, i, ch.id);
    });
    await pipe.exec();

    await this.redis.hset(`playlistmeta:${name}`, {
      id: playlistId,
      name,
      total: channels.length,
      createdAt: new Date().toISOString(),
    });
    return playlistId;
  }

  async getMasterPlaylist(name, { baseUrl = '' } = {}) {
    const ids = await this.redis.zrange(`playlist:${name}`, 0, -1);
    if (!ids.length) throw new Error(`Playlist ${name} not found`);

    const base = (baseUrl || '').replace(/\/$/, '');
    let m3u8 = '#EXTM3U\n';
    for (const id of ids) {
      const ch = await this.redis.hgetall(`channel:${id}`);
      if (!ch || !ch.name) continue;
      m3u8 += `#EXTINF:-1 tvg-id="${ch.tvgId || ''}" tvg-name="${ch.tvgName || ch.name}" tvg-logo="${ch.logo || ''}" group-title="${ch.group || ''}",${ch.name}\n`;
      m3u8 += `${base}/hls/${id}/master.m3u8\n`;
    }
    return m3u8;
  }

  async shutdown() {
    try { await this.redis.quit(); } catch (_) {}
  }

  async getChannels(name, { group, search, page = 1, limit = 100 } = {}) {
    const ids = await this.redis.zrange(`playlist:${name}`, 0, -1);
    const all = await Promise.all(ids.map((id) => this.redis.hgetall(`channel:${id}`)));
    let filtered = all.filter(Boolean);
    if (group) filtered = filtered.filter((c) => c.group === group);
    if (search) {
      const q = search.toLowerCase();
      filtered = filtered.filter(
        (c) =>
          (c.name && c.name.toLowerCase().includes(q)) ||
          (c.group && c.group.toLowerCase().includes(q))
      );
    }
    const start = (page - 1) * limit;
    return {
      total: filtered.length,
      page,
      limit,
      channels: filtered.slice(start, start + limit),
    };
  }
}

module.exports = PlaylistManager;
