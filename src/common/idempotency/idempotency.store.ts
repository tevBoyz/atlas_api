import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';

import { DatabaseService } from '../../db/database.service';
import { ROOT_LOGGER } from '../../observability/logger';

/** Table created by `db/migrations/0001_idempotency_keys.sql` (API-100-10 AC1). */
export const IDEMPOTENCY_TABLE = 'public.idempotency_keys';
/** Keys expire 24 h after their (last) claim; an expired key is unknown (AC9). */
export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
/** An `in_progress` claim older than this is abandoned and may be taken over (AC7). */
export const IDEMPOTENCY_ABANDONED_AFTER_SECONDS = 60;
/** Expired rows are swept at most this often per process, in batches (AC9). */
export const IDEMPOTENCY_CLEANUP_INTERVAL_MS = 10 * 60_000;
export const IDEMPOTENCY_CLEANUP_BATCH = 500;
/** Claim attempts when the row changes between statements (e.g. released by a 5xx). */
const CLAIM_ATTEMPTS = 3;

/** What the request presents: the key's owner and the request fingerprint. */
export interface IdempotencyRequest {
  userId: string;
  key: string;
  method: string;
  path: string;
  requestHash: string;
}

/** A claim held by this request; `claimedAt` (exact database text) fences complete/release. */
export interface IdempotencyClaim {
  userId: string;
  key: string;
  claimedAt: string;
}

export type ClaimOutcome =
  | { kind: 'claimed'; claim: IdempotencyClaim }
  | { kind: 'replay'; status: number; body: unknown }
  | { kind: 'mismatch' }
  | { kind: 'in_progress' };

interface StoredRow {
  method: string;
  path: string;
  request_hash: string;
  status: 'in_progress' | 'completed';
  response_status: number | null;
  response_body: unknown;
  expired: boolean;
}

/**
 * Persistence of Idempotency-Key claims (API-100-10). Plain SQL statements on the pool, each
 * atomic on its own; no transaction is held while the handler runs:
 *
 * 1. `claim`: purge this key if expired → insert `in_progress` (ON CONFLICT DO NOTHING; the
 *    primary key `(user_id, key)` lets exactly one concurrent request win) → otherwise read the row:
 *    different method/path/hash → mismatch; `completed` → replay; `in_progress` older than 60 s →
 *    compare-and-set takeover (again exactly one winner); else in progress.
 * 2. `complete`: store status + body, `completed` (2xx/4xx).
 * 3. `release`: delete the claim (5xx, or a response that cannot be stored) so the key can be retried.
 *
 * `created_at` doubles as the claim time (reset on takeover); complete/release only touch the
 * row if it is still this request's claim, so a late original cannot overwrite a takeover.
 */
@Injectable()
export class IdempotencyStore {
  private lastCleanup = 0;

  constructor(
    private readonly database: DatabaseService,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
  ) {}

  async claim(request: IdempotencyRequest): Promise<ClaimOutcome> {
    const { userId, key } = request;
    for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
      await this.database.query(
        `delete from ${IDEMPOTENCY_TABLE}
          where user_id = $1 and key = $2 and expires_at <= now()`,
        [userId, key],
      );

      const inserted = await this.database.query<{ claimed_at: string }>(
        `insert into ${IDEMPOTENCY_TABLE}
           (user_id, key, method, path, request_hash, status, expires_at)
         values ($1, $2, $3, $4, $5, 'in_progress', now() + make_interval(secs => $6))
         on conflict (user_id, key) do nothing
         returning created_at::text as claimed_at`,
        [userId, key, request.method, request.path, request.requestHash, IDEMPOTENCY_TTL_SECONDS],
      );
      if (inserted[0]) {
        this.cleanupExpiredSoon();
        return { kind: 'claimed', claim: { userId, key, claimedAt: inserted[0].claimed_at } };
      }

      const rows = await this.database.query<StoredRow>(
        `select method, path, request_hash, status, response_status, response_body,
                expires_at <= now() as expired
           from ${IDEMPOTENCY_TABLE}
          where user_id = $1 and key = $2`,
        [userId, key],
      );
      const row = rows[0];
      if (!row || row.expired) continue; // released or expired meanwhile: try again

      if (
        row.method !== request.method ||
        row.path !== request.path ||
        row.request_hash !== request.requestHash
      ) {
        return { kind: 'mismatch' };
      }
      if (row.status === 'completed' && row.response_status !== null) {
        return { kind: 'replay', status: row.response_status, body: row.response_body };
      }

      const takenOver = await this.database.query<{ claimed_at: string }>(
        `update ${IDEMPOTENCY_TABLE}
            set created_at = now(),
                expires_at = now() + make_interval(secs => $3)
          where user_id = $1 and key = $2
            and status = 'in_progress'
            and created_at <= now() - make_interval(secs => $4)
            and expires_at > now()
         returning created_at::text as claimed_at`,
        [userId, key, IDEMPOTENCY_TTL_SECONDS, IDEMPOTENCY_ABANDONED_AFTER_SECONDS],
      );
      if (takenOver[0]) {
        return { kind: 'claimed', claim: { userId, key, claimedAt: takenOver[0].claimed_at } };
      }
      return { kind: 'in_progress' };
    }
    return { kind: 'in_progress' };
  }

  /** Stores the response (2xx / 4xx) and marks the key completed (AC4, AC8). */
  async complete(claim: IdempotencyClaim, status: number, bodyJson: string | null): Promise<void> {
    await this.database.query(
      `update ${IDEMPOTENCY_TABLE}
          set status = 'completed', response_status = $4, response_body = $5::jsonb
        where user_id = $1 and key = $2 and created_at = $3::timestamptz
          and status = 'in_progress'`,
      [claim.userId, claim.key, claim.claimedAt, status, bodyJson],
    );
  }

  /** Forgets the claim so the same key can run again (5xx, AC8). */
  async release(claim: IdempotencyClaim): Promise<void> {
    await this.database.query(
      `delete from ${IDEMPOTENCY_TABLE}
        where user_id = $1 and key = $2 and created_at = $3::timestamptz
          and status = 'in_progress'`,
      [claim.userId, claim.key, claim.claimedAt],
    );
  }

  /** Deletes one batch of expired keys (any user). Returns how many were removed. */
  async deleteExpired(limit = IDEMPOTENCY_CLEANUP_BATCH): Promise<number> {
    const rows = await this.database.query<{ n: number }>(
      `with gone as (
         delete from ${IDEMPOTENCY_TABLE}
          where (user_id, key) in (
            select user_id, key from ${IDEMPOTENCY_TABLE}
             where expires_at <= now()
             limit $1)
         returning 1)
       select count(*)::int as n from gone`,
      [limit],
    );
    return rows[0]?.n ?? 0;
  }

  /** Opportunistic sweep (no job runner yet): at most once per interval, never awaited. */
  private cleanupExpiredSoon(): void {
    const now = Date.now();
    if (now - this.lastCleanup < IDEMPOTENCY_CLEANUP_INTERVAL_MS) return;
    this.lastCleanup = now;
    this.deleteExpired().catch((err: unknown) =>
      this.logger.warn({ err }, 'idempotency: expired key cleanup failed'),
    );
  }
}
