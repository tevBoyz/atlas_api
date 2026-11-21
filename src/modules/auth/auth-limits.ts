import { createHash } from 'node:crypto';

import { Injectable } from '@nestjs/common';

import { DomainError, type ErrorCode } from '../../common/errors';
import type { RateLimitPolicy } from '../../common/rate-limit';
import {
  RATE_LIMIT_KEY_PREFIX,
  RateLimiterService,
} from '../../common/rate-limit/rate-limiter.service';

/**
 * Per-IP limits of the public auth routes (Phase 6). Spec rule 48 for the lockout pair (60 status /
 * login calls per IP per 5 minutes, `login_lockout:rate_limited`), and the Supabase Auth limits the
 * app has today for the rest (spec §8: sign-in / sign-up 30, token verifications 30, token refresh
 * 150, each per IP per 5 minutes).
 */
const FIVE_MINUTES = 300;

/** `GET /v1/auth/lockout-status` and `POST /v1/auth/login` share it (the app read the status before each sign-in). */
export const LOGIN_STATUS_LIMIT: RateLimitPolicy = {
  name: 'login_status',
  max: 60,
  windowSeconds: FIVE_MINUTES,
  scope: 'ip',
  code: 'login_lockout:rate_limited',
};

/** Wrong passwords per IP (`record_login_failure`: 15). Also checked before a password is tried. */
export const LOGIN_FAILURE_LIMIT = { name: 'login_failure', max: 15, windowSeconds: FIVE_MINUTES };
/** Lockout clears per IP (`clear_login_failures`: 30); over it, a sign-in succeeds without clearing. */
export const LOGIN_CLEAR_LIMIT = { name: 'login_clear', max: 30, windowSeconds: FIVE_MINUTES };

export const SIGN_UP_LIMIT: RateLimitPolicy = {
  name: 'auth_signup',
  max: 30,
  windowSeconds: FIVE_MINUTES,
  scope: 'ip',
};
export const SIGN_IN_LIMIT: RateLimitPolicy = {
  name: 'auth_signin',
  max: 30,
  windowSeconds: FIVE_MINUTES,
  scope: 'ip',
};
export const VERIFY_LIMIT: RateLimitPolicy = {
  name: 'auth_verify',
  max: 30,
  windowSeconds: FIVE_MINUTES,
  scope: 'ip',
};
export const SEND_LIMIT: RateLimitPolicy = {
  name: 'auth_send',
  max: 30,
  windowSeconds: FIVE_MINUTES,
  scope: 'ip',
};
export const REFRESH_LIMIT: RateLimitPolicy = {
  name: 'auth_refresh',
  max: 150,
  windowSeconds: FIVE_MINUTES,
  scope: 'ip',
};

/**
 * Sends per identifier (spec §6.9 rule 49, now on the server): the first message plus 3 resends in
 * any sliding 15 minutes, per email address (links) or phone number (codes), whether or not an
 * account exists (no enumeration).
 */
export const SENDS_PER_IDENTIFIER = 4;
export const SEND_WINDOW_SECONDS = 15 * 60;

/** Redis keys never hold an address in clear: a SHA-256 of it. */
export function identifierKey(identifier: string): string {
  return createHash('sha256').update(identifier, 'utf8').digest('hex');
}

/** Counts against the per-IP / per-identifier limits that services check themselves. */
@Injectable()
export class AuthLimits {
  constructor(private readonly limiter: RateLimiterService) {}

  /** Counts one; false when over the limit (fails open when Redis is down, as every limit). */
  async take(name: string, subject: string, max: number, windowSeconds: number): Promise<boolean> {
    const decision = await this.limiter.consume(
      `${RATE_LIMIT_KEY_PREFIX}:${name}:${subject}`,
      max,
      windowSeconds,
    );
    return decision.allowed;
  }

  /** A send to an email address or phone: 429 `code` past the 4th in 15 minutes. */
  async takeSend(kind: 'email' | 'phone', identifier: string, code: ErrorCode): Promise<number> {
    const decision = await this.limiter.consume(
      `${RATE_LIMIT_KEY_PREFIX}:auth_send_${kind}:${identifierKey(identifier)}`,
      SENDS_PER_IDENTIFIER,
      SEND_WINDOW_SECONDS,
    );
    if (!decision.allowed) {
      throw new DomainError(code, {
        retryAfterSeconds: Math.max(1, Math.ceil(decision.retryAfterMs / 1000)),
        details: { resends_remaining: 0 },
      });
    }
    return decision.remaining;
  }
}
