import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Logger } from 'pino';

import { ApiConfigService } from '../../config';
import { ROOT_LOGGER } from '../../observability/logger';
import { RedisService } from '../../redis/redis.service';

/** Prefix of every limiter key in Redis. */
export const RATE_LIMIT_KEY_PREFIX = 'atlas:rl:v1';
/** A second outage warning within this time of the first is not logged (a flapping Redis). */
export const RATE_LIMIT_OUTAGE_LOG_COOLDOWN_MS = 30_000;

/**
 * Sliding-window log, as ONE atomic script. Redis runs a script to completion, so parallel requests
 * cannot both take the last slot, and the entry and its TTL are written together: a crash can never
 * leave a key without an expiry. Time comes from Redis `TIME`, so API instances with skewed clocks
 * agree. Entries are per request, so any window of the policy's length holds at most `max`
 * admissions (no doubling at a fixed-window boundary). A refused request is not recorded.
 *
 * Returns `{ allowed (0|1), remaining, retry_after_ms }`.
 */
export const SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local max = tonumber(ARGV[1])
local window_us = tonumber(ARGV[2])
local member = ARGV[3]
local time = redis.call('TIME')
local now_us = tonumber(time[1]) * 1000000 + tonumber(time[2])
local ttl_ms = string.format('%.0f', math.ceil(window_us / 1000))
redis.call('ZREMRANGEBYSCORE', key, '-inf', string.format('%.0f', now_us - window_us))
local count = redis.call('ZCARD', key)
if count < max then
  redis.call('ZADD', key, string.format('%.0f', now_us), member)
  redis.call('PEXPIRE', key, ttl_ms)
  return {1, max - count - 1, 0}
end
local freeing = redis.call('ZRANGE', key, count - max, count - max, 'WITHSCORES')
redis.call('PEXPIRE', key, ttl_ms)
return {0, 0, math.ceil((tonumber(freeing[2]) + window_us - now_us) / 1000)}
`;

const COMMAND = 'atlasRateLimitConsume';

type ScriptedRedis = Redis & {
  [COMMAND](key: string, max: number, windowUs: number, member: string): Promise<number[]>;
};

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  /** Milliseconds until a slot frees up (0 when allowed). */
  retryAfterMs: number;
}

/** Admitted without being counted: Redis could not answer in time. */
const FAIL_OPEN: RateLimitDecision = { allowed: true, remaining: 0, retryAfterMs: 0 };

class RateLimitTimeoutError extends Error {
  constructor() {
    super('rate limiter: Redis did not answer in time');
    this.name = 'RateLimitTimeoutError';
  }
}

/**
 * Redis-backed counters (API-100-11 AC1). **Fails open**: when Redis is unconfigured, down or slower
 * than RATE_LIMIT_REDIS_TIMEOUT_MS the request is admitted, because an SOS must never be refused
 * because of the limiter. An outage is logged once (warn) and its end once (info), never per request.
 */
@Injectable()
export class RateLimiterService {
  private readonly timeoutMs: number;
  private scripted?: ScriptedRedis;
  private degraded = false;
  private lastOutageLogAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly redis: RedisService,
    config: ApiConfigService,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
  ) {
    this.timeoutMs = config.get('RATE_LIMIT_REDIS_TIMEOUT_MS');
  }

  /** Counts one request against `key`. Never throws. */
  async consume(key: string, max: number, windowSeconds: number): Promise<RateLimitDecision> {
    try {
      const reply = await this.withinTimeout(
        this.client()[COMMAND](key, max, windowSeconds * 1_000_000, randomUUID()),
      );
      this.markHealthy();
      return { allowed: reply[0] === 1, remaining: reply[1], retryAfterMs: reply[2] };
    } catch (err) {
      this.markDegraded(err);
      return FAIL_OPEN;
    }
  }

  private client(): ScriptedRedis {
    if (!this.scripted) {
      const client = this.redis.client;
      client.defineCommand(COMMAND, { numberOfKeys: 1, lua: SLIDING_WINDOW_SCRIPT });
      this.scripted = client as ScriptedRedis;
    }
    return this.scripted;
  }

  private async withinTimeout<T>(command: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new RateLimitTimeoutError()), this.timeoutMs);
    });
    try {
      // A command that answers after the timeout settles the race's handler, so it stays handled.
      return await Promise.race([command, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private markDegraded(err: unknown): void {
    if (this.degraded) return;
    this.degraded = true;
    const now = Date.now();
    if (now - this.lastOutageLogAt < RATE_LIMIT_OUTAGE_LOG_COOLDOWN_MS) return;
    this.lastOutageLogAt = now;
    this.logger.warn({ err }, 'rate limiter unavailable, requests are not being limited');
  }

  private markHealthy(): void {
    if (!this.degraded) return;
    this.degraded = false;
    this.logger.info('rate limiter restored');
  }
}
