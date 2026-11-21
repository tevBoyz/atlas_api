import { createHash, randomBytes } from 'node:crypto';

import { sql } from 'drizzle-orm';

import { DomainError } from '../../common/errors';
import type { Database } from '../../db';
import type { DatabaseService } from '../../db/database.service';
import { sqlStateOf } from '../incidents/incident-transaction';

/** The open transaction of an auth write (`database.db.transaction((tx) => ...)`). */
export type AuthTx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * An auth write that failed in the database. It replaces the original error, because a query error
 * carries the statement's parameters (password hashes, token digests, emails, phones). Only the
 * SQLSTATE is kept.
 */
export class AuthOperationFailedError extends Error {
  constructor(readonly sqlState: string | undefined) {
    super('auth operation failed in the database');
    this.name = 'AuthOperationFailedError';
  }
}

/**
 * Runs `work` in one transaction with `TimeZone` UTC (timestamps in JSON are UTC text, as on every
 * other route). A {@link DomainError} passes through (rolled back); anything else becomes an
 * {@link AuthOperationFailedError}.
 */
export async function runAuthTransaction<T>(
  database: DatabaseService,
  work: (tx: AuthTx) => Promise<T>,
): Promise<T> {
  try {
    return await database.db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('TimeZone', 'UTC', true)`);
      return work(tx);
    });
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new AuthOperationFailedError(sqlStateOf(error));
  }
}

/** A new opaque secret: 32 random bytes, base64url (43 characters). Never stored in clear. */
export function newOpaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

/** SHA-256 digest of an opaque token: what the database stores (`token_hash`). */
export function tokenDigest(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/** First row of an `execute` result. */
export function firstRow<T>(result: { rows: unknown[] }): T | undefined {
  return result.rows[0] as T | undefined;
}
