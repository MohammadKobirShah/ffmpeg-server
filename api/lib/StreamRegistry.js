'use strict';

const Redis = require('ioredis');

/**
 * Thin Redis-backed registry of stream state. The API owns *state*;
 * workers own the *processes*. Workers publish lifecycle events that
 * QueueManager forwards here.
 */
class StreamRegistry {
  constructor({ logger }) {
    this.logger = logger;
    this.redis = new Redis(process.env.REDIS_URL);
    this.setKey = 'streams:active';
    this.keyFor = (id) => `stream:${id}`;
  }

  async markQueued(channelId, data = {}) {
    await this.redis.hset(this.keyFor(channelId), {
      channelId,
      status: 'queued',
      queuedAt: Date.now(),
      ...data,
    });
    await this.redis.sadd(this.setKey, channelId);
  }

  async markRunning(channelId, data = {}) {
    await this.redis.hset(this.keyFor(channelId), {
      channelId,
      status: 'running',
      startedAt: Date.now(),
      ...data,
    });
    await this.redis.sadd(this.setKey, channelId);
  }

  async markStopped(channelId, data = {}) {
    await this.redis.hset(this.keyFor(channelId), {
      channelId,
      status: data.error ? 'error' : 'stopped',
      stoppedAt: Date.now(),
      ...data,
    });
    await this.redis.srem(this.setKey, channelId);
  }

  async get(channelId) {
    const data = await this.redis.hgetall(this.keyFor(channelId));
    return { channelId, ...data };
  }

  async list() {
    const ids = await this.redis.smembers(this.setKey);
    if (!ids.length) return [];
    return Promise.all(ids.map((id) => this.get(id)));
  }

  async countActive() {
    const ids = await this.redis.smembers(this.setKey);
    if (!ids.length) return 0;
    const streams = await Promise.all(ids.map((id) => this.get(id)));
    return streams.filter((s) => s.status === 'running').length;
  }

  async shutdown() {
    try { await this.redis.quit(); } catch (_) {}
  }
}

module.exports = StreamRegistry;
