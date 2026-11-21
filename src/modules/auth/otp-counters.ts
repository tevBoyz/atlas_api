import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';

import { RedisService } from '../../redis/redis.service';
import { identifierKey, SEND_WINDOW_SECONDS, SENDS_PER_IDENTIFIER } from './auth-limits';
import { OTP_TTL_SECONDS } from './phone-verification';

/** Failed attempts that invalidate the current code until a resend (spec §6.9 rule 49). */
export const OTP_MAX_ATTEMPTS = 5;

const PREFIX = 'atlas:auth:otp:v1';

/**
 * SEND (KEYS: sends, attempts, pending; ARGV: max, window_us, member, ttl_ms):
 * a sliding log of sends; when under `max`, records this one, resets the failed-attempt count (a
 * resend resets it) and clears the pending marker (set again once the code is out). Returns
 * `{allowed, remaining, retry_after_ms}`.
 */
const SEND_SCRIPT = `
local max = tonumber(ARGV[1])
local window_us = tonumber(ARGV[2])
local time = redis.call('TIME')
local now_us = tonumber(time[1]) * 1000000 + tonumber(time[2])
local ttl_ms = string.format('%.0f', math.ceil(window_us / 1000))
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', string.format('%.0f', now_us - window_us))
local count = redis.call('ZCARD', KEYS[1])
if count >= max then
  local oldest = redis.call('ZRANGE', KEYS[1], count - max, count - max, 'WITHSCORES')
  return {0, 0, math.ceil((tonumber(oldest[2]) + window_us - now_us) / 1000)}
end
redis.call('ZADD', KEYS[1], string.format('%.0f', now_us), ARGV[3])
redis.call('PEXPIRE', KEYS[1], ttl_ms)
redis.call('DEL', KEYS[2], KEYS[3])
return {1, max - count - 1, 0}
`;

/**
 * ATTEMPT (KEYS: attempts, pending; ARGV: max): no pending code → -1 (expired); else counts this
 * attempt (atomically, so parallel guesses cannot exceed the limit) and returns the count; above
 * `max` the code is invalidated (the caller answers 423 without checking it).
 */
const ATTEMPT_SCRIPT = `
local ttl = redis.call('PTTL', KEYS[2])
if ttl <= 0 then return -1 end
local n = redis.call('INCR', KEYS[1])
redis.call('PEXPIRE', KEYS[1], ttl)
return n
`;

type Scripted = Redis & {
  atlasOtpSend(
    sends: string,
    attempts: string,
    pending: string,
    max: number,
    windowUs: number,
    member: string,
  ): Promise<number[]>;
  atlasOtpAttempt(attempts: string, pending: string): Promise<number>;
};

/** Redis is unavailable: OTP routes fail closed (503 `auth:sms_unavailable`). */
export class OtpCountersUnavailableError extends Error {
  constructor() {
    super('otp counters unavailable');
    this.name = 'OtpCountersUnavailableError';
  }
}

export interface SendDecision {
  allowed: boolean;
  resendsRemaining: number;
  retryAfterMs: number;
}

/**
 * Server-enforced OTP limits (API-100-53 AC2) in Redis, per phone number (hashed in the key): at
 * most 4 codes (the first + 3 resends) in any sliding 15 minutes; 5 failed attempts invalidate the
 * current code until a resend; a resend resets the failure count; a code is usable 600 s after it
 * was sent (the pending marker). Unlike the request rate limits these FAIL CLOSED: without Redis
 * no code is sent or checked. Nothing here holds the code itself.
 */
@Injectable()
export class OtpCounters {
  private scripted?: Scripted;

  constructor(private readonly redis: RedisService) {}

  private keys(phone: string) {
    const id = identifierKey(phone);
    return {
      sends: `${PREFIX}:sends:${id}`,
      attempts: `${PREFIX}:attempts:${id}`,
      pending: `${PREFIX}:pending:${id}`,
    };
  }

  private client(): Scripted {
    if (!this.scripted) {
      const client = this.redis.client;
      client.defineCommand('atlasOtpSend', { numberOfKeys: 3, lua: SEND_SCRIPT });
      client.defineCommand('atlasOtpAttempt', { numberOfKeys: 2, lua: ATTEMPT_SCRIPT });
      this.scripted = client as Scripted;
    }
    return this.scripted;
  }

  private async guarded<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch {
      throw new OtpCountersUnavailableError();
    }
  }

  /** Counts a send (send or resend). */
  takeSend(phone: string): Promise<SendDecision> {
    const k = this.keys(phone);
    return this.guarded(async () => {
      const [allowed, remaining, retry] = await this.client().atlasOtpSend(
        k.sends,
        k.attempts,
        k.pending,
        SENDS_PER_IDENTIFIER,
        SEND_WINDOW_SECONDS * 1_000_000,
        randomUUID(),
      );
      return { allowed: allowed === 1, resendsRemaining: remaining, retryAfterMs: retry };
    });
  }

  /** A code is out: verification attempts are possible for 600 s. */
  markPending(phone: string): Promise<void> {
    const k = this.keys(phone);
    return this.guarded(async () => {
      await this.client().set(k.pending, '1', 'PX', OTP_TTL_SECONDS * 1000);
    });
  }

  /** Counts an attempt: -1 = no code pending (expired); else the attempt number (1-based). */
  takeAttempt(phone: string): Promise<number> {
    const k = this.keys(phone);
    return this.guarded(() => this.client().atlasOtpAttempt(k.attempts, k.pending));
  }

  /** The code was used or is gone: no further attempts until the next send. */
  clear(phone: string): Promise<void> {
    const k = this.keys(phone);
    return this.guarded(async () => {
      await this.client().del(k.attempts, k.pending);
    });
  }
}
