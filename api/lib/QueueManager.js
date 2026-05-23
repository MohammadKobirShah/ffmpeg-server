'use strict';

const Bull = require('bull');
const Redis = require('ioredis');

class QueueManager {
  constructor({ logger, io }) {
    this.logger = logger;
    this.io = io;
    this.redisUrl = process.env.REDIS_URL;
    this.transcodeQueue = new Bull('transcode', {
      redis: this.redisUrl,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 100,
        removeOnFail: 100,
      },
    });
    this.controlQueue = new Bull('control', { redis: this.redisUrl });
    this.sub = new Redis(this.redisUrl);
    this.handlers = [];
  }

  start() {
    this.sub.subscribe('worker:events', (err) => {
      if (err) this.logger.error('subscribe failed', { err: err.message });
      else this.logger.info('Subscribed to worker:events');
    });
    this.sub.on('message', (ch, raw) => {
      if (ch !== 'worker:events') return;
      try {
        const msg = JSON.parse(raw);
        Promise.all(this.handlers.map((fn) => fn(msg.event, msg.payload).catch((e) => this.logger.error('Handler error', { err: e.message })))).catch(() => {});
      } catch (e) {
        this.logger.warn('Bad worker event payload', { raw });
      }
    });
    this.transcodeQueue.on('failed', (job, err) => {
      this.logger.error('Job failed', { jobId: job.id, error: err.message });
    });
  }

  onWorkerEvent(fn) { this.handlers.push(fn); }

  async addTranscodeJob(config) {
    const { delay, ...jobData } = config;
    const opts = {
      jobId: `tx:${config.channelId}`,
      priority: config.priority || 1,
    };
    if (delay != null) opts.delay = delay;
    return this.transcodeQueue.add('transcode', jobData, opts);
  }

  async bulkTranscode(channels, { qualities = ['540p', '720p'], mode = 'transcode', audio } = {}) {
    const BATCH = 25;
    const jobs = [];
    for (let i = 0; i < channels.length; i += BATCH) {
      const slice = channels.slice(i, i + BATCH);
      const added = await Promise.all(
        slice.map((ch, j) =>
          this.addTranscodeJob({
            channelId: ch.id,
            channelName: ch.name,
            url: ch.url,
            qualities, mode, audio,
            delay: (i + j) * 250,
          }).catch((err) => {
            this.logger.warn(`Failed to enqueue ${ch.name}`, { err: err.message });
            return null;
          })
        )
      );
      jobs.push(...added.filter(Boolean));
    }
    return jobs;
  }

  async requestStop(channelId) {
    await this.controlQueue.add('stop', { channelId }, { removeOnComplete: true });
    const job = await this.transcodeQueue.getJob(`tx:${channelId}`);
    if (job) { try { await job.remove(); } catch (_) {} }
  }

  async shutdown() {
    try { await this.sub.quit(); } catch (_) {}
    try { await this.transcodeQueue.close(); } catch (_) {}
    try { await this.controlQueue.close(); } catch (_) {}
  }

  async getQueueStats() {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      this.transcodeQueue.getWaitingCount(),
      this.transcodeQueue.getActiveCount(),
      this.transcodeQueue.getCompletedCount(),
      this.transcodeQueue.getFailedCount(),
      this.transcodeQueue.getDelayedCount(),
    ]);
    return { waiting, active, completed, failed, delayed };
  }
}

module.exports = QueueManager;
