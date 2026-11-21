import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { Logger } from 'pino';

import { ROOT_LOGGER } from '../../observability/logger';
import { RedisService } from '../../redis/redis.service';
import type { AuthenticatedUser } from './authenticated-user';
import type { TokenUsageRecorder } from './dual-token-verifier';

/** DI token of the {@link TokenUsageMetrics}. */
export const TOKEN_USAGE = Symbol('TOKEN_USAGE');

/** Redis key prefix of the daily counters (`npm run auth:token-usage` reads them). */
export const TOKEN_USAGE_KEY_PREFIX = 'atlas:auth:token-usage:v1';
/** Counters are kept this long. */
export const TOKEN_USAGE_RETENTION_SECONDS = 40 * 86_400;
/** Pending counts are written to Redis this often (one pipeline per instance). */
export const TOKEN_USAGE_FLUSH_MS = 10_000;
/** A summary line is logged this often when tokens were seen. */
export const TOKEN_USAGE_LOG_MS = 15 * 60_000;

type Issuer = AuthenticatedUser['issuer'];
const ISSUERS: readonly Issuer[] = ['supabase', 'atlas'];

/** `YYYY-MM-DD` (UTC) of an instant. */
export function usageDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The Redis keys of one UTC day: request counts per issuer, and distinct users per issuer. */
export function usageKeys(day: string): { counts: string; users: (issuer: Issuer) => string } {
  return {
    counts: `${TOKEN_USAGE_KEY_PREFIX}:${day}`,
    users: (issuer) => `${TOKEN_USAGE_KEY_PREFIX}:${day}:users:${issuer}`,
  };
}

interface Pending {
  requests: Record<Issuer, number>;
  users: Record<Issuer, Set<string>>;
}

const emptyPending = (): Pending => ({
  requests: { supabase: 0, atlas: 0 },
  users: { supabase: new Set(), atlas: new Set() },
});

/**
 * The share of Supabase tokens during the dual-token window (API-100-59 AC2). Every accepted access
 * token counts once, by issuer: requests and distinct users per UTC day, in Redis (hash
 * `atlas:auth:token-usage:v1:<day>` and HyperLogLogs `...:<day>:users:<issuer>`, kept 40 days),
 * written in one pipeline every 10 s, never on the request path. Each instance also logs a summary
 * line every 15 min (`token usage`, with the Supabase share) when it saw tokens. Losing a few counts
 * (Redis down, a crash) is acceptable: this is a trend, not a ledger. User ids never reach a log.
 */
@Injectable()
export class TokenUsageMetrics implements TokenUsageRecorder, OnModuleDestroy {
  private pending = emptyPending();
  private window = emptyPending();
  private readonly flushTimer: NodeJS.Timeout;
  private readonly logTimer: NodeJS.Timeout;

  constructor(
    private readonly redis: RedisService,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
  ) {
    this.flushTimer = setInterval(() => void this.flush(), TOKEN_USAGE_FLUSH_MS);
    this.flushTimer.unref();
    this.logTimer = setInterval(() => this.logSummary(), TOKEN_USAGE_LOG_MS);
    this.logTimer.unref();
  }

  record(issuer: Issuer, userId: string): void {
    for (const target of [this.pending, this.window]) {
      target.requests[issuer] += 1;
      target.users[issuer].add(userId);
    }
  }

  /** Writes the pending counts to Redis (also called on shutdown and by tests). */
  async flush(now: number = Date.now()): Promise<void> {
    const batch = this.pending;
    this.pending = emptyPending();
    if (!this.redis.isConfigured || this.redis.client.status !== 'ready') return;
    if (ISSUERS.every((issuer) => batch.requests[issuer] === 0)) return;
    const keys = usageKeys(usageDay(now));
    try {
      const pipeline = this.redis.client.multi();
      for (const issuer of ISSUERS) {
        if (batch.requests[issuer] === 0) continue;
        pipeline.hincrby(keys.counts, issuer, batch.requests[issuer]);
        pipeline.pfadd(keys.users(issuer), ...batch.users[issuer]);
        pipeline.expire(keys.users(issuer), TOKEN_USAGE_RETENTION_SECONDS);
      }
      pipeline.expire(keys.counts, TOKEN_USAGE_RETENTION_SECONDS);
      await pipeline.exec();
    } catch (err) {
      this.logger.debug({ err }, 'token usage counters not written');
    }
  }

  private logSummary(): void {
    const window = this.window;
    this.window = emptyPending();
    const total = window.requests.supabase + window.requests.atlas;
    if (total === 0) return;
    this.logger.info(
      {
        supabase_requests: window.requests.supabase,
        atlas_requests: window.requests.atlas,
        supabase_users: window.users.supabase.size,
        atlas_users: window.users.atlas.size,
        supabase_share: Math.round((window.requests.supabase / total) * 1000) / 1000,
      },
      'token usage',
    );
  }

  /** Stops the timers; writes what is pending (nothing to wait for when nothing is pending). */
  onModuleDestroy(): Promise<void> | void {
    clearInterval(this.flushTimer);
    clearInterval(this.logTimer);
    if (ISSUERS.every((issuer) => this.pending.requests[issuer] === 0)) return;
    return this.flush();
  }
}
