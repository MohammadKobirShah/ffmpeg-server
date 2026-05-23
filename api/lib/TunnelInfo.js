'use strict';

const Redis = require('ioredis');

/**
 * Tracks the current Cloudflare Tunnel public URL.
 * - Pulls initial value from Redis (set by the tunnel sidecar)
 * - Subscribes to tunnel:events for live updates
 * - Falls back to PUBLIC_DOMAIN env var if no tunnel is up
 */
class TunnelInfo {
  constructor({ logger }) {
    this.logger = logger;
    this.url = (process.env.PUBLIC_DOMAIN || '').replace(/\/$/, '') || null;
    this.mode = process.env.PUBLIC_DOMAIN ? 'env' : null;
    this.redis = new Redis(process.env.REDIS_URL);
    this.sub = new Redis(process.env.REDIS_URL);
    this.listeners = [];
  }

  async start() {
    try {
      const fromRedis = await this.redis.get('tunnel:public_url');
      const mode = await this.redis.get('tunnel:mode');
      if (fromRedis) {
        this.url = fromRedis.replace(/\/$/, '');
        this.mode = mode || 'unknown';
        this.logger.info(`Tunnel URL loaded: ${this.url} (${this.mode})`);
      }
    } catch (e) {
      this.logger.warn('Failed to read tunnel:public_url', { err: e.message });
    }

    this.sub.subscribe('tunnel:events', (err) => {
      if (err) this.logger.error('subscribe tunnel:events failed', { err: err.message });
      else this.logger.info('Subscribed to tunnel:events');
    });
    this.sub.on('message', (ch, raw) => {
      if (ch !== 'tunnel:events') return;
      try {
        const msg = JSON.parse(raw);
        if (msg.event === 'tunnel:up' && msg.url) {
          this.url = msg.url.replace(/\/$/, '');
          this.mode = msg.mode || 'unknown';
          this.logger.info(`Tunnel URL updated: ${this.url} (${this.mode})`);
          this.listeners.forEach((fn) => {
            try { fn(this.url, this.mode); } catch (_) {}
          });
        }
      } catch (_) {}
    });
  }

  getUrl() { return this.url; }
  getMode() { return this.mode; }
  onChange(fn) { this.listeners.push(fn); }

  async shutdown() {
    try { await this.redis.quit(); } catch (_) {}
    try { await this.sub.quit(); } catch (_) {}
  }

  /** Build an absolute HLS URL for a channel. */
  hlsUrl(channelId, file = 'master.m3u8') {
    const base = this.url || '';
    return `${base}/hls/${channelId}/${file}`;
  }
}

module.exports = TunnelInfo;
