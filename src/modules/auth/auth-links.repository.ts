import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DomainError } from '../../common/errors';
import { type AuthTx, firstRow, newOpaqueToken, tokenDigest } from './auth-transaction';

/** `auth_tokens.purpose`: what an emailed link does. */
export type LinkPurpose = 'email_verify' | 'password_reset' | 'magic_link';

export interface ConsumedLink {
  id: string;
  user_id: string;
  purpose: LinkPurpose;
}

/**
 * One-time email links (`public.auth_tokens`, migration 0008): verification (API-100-52), magic link
 * and password reset (API-100-57). The link carries a random 32-byte token; only its SHA-256 digest
 * is stored. A new link of a purpose replaces the user's unused ones of that purpose (an older link
 * then answers `auth:link_invalid`).
 */
@Injectable()
export class AuthLinksRepository {
  /** A new link token (returned once, in clear, for the email). */
  async create(
    tx: AuthTx,
    userId: string,
    purpose: LinkPurpose,
    ttlSeconds: number,
  ): Promise<string> {
    await tx.execute(sql`
      delete from public.auth_tokens
       where user_id = ${userId}::uuid and purpose = ${purpose} and used_at is null`);
    const token = newOpaqueToken();
    await tx.execute(sql`
      insert into public.auth_tokens (user_id, purpose, token_hash, expires_at)
      values (${userId}::uuid, ${purpose}, ${tokenDigest(token)},
              now() + make_interval(secs => ${ttlSeconds}))`);
    return token;
  }

  /**
   * Locks the link of `token` and checks it: unknown, already used or of another purpose → 400
   * `auth:link_invalid`; past its expiry → 410 `auth:link_expired`. Does not mark it used (the
   * caller does, after its own checks, in the same transaction).
   */
  async lockUsable(
    tx: AuthTx,
    token: string,
    purposes: readonly LinkPurpose[],
  ): Promise<ConsumedLink> {
    const row = firstRow<ConsumedLink & { used: boolean; expired: boolean }>(
      await tx.execute(sql`
        select id::text as id, user_id::text as user_id, purpose,
               (used_at is not null) as used, (expires_at <= now()) as expired
          from public.auth_tokens
         where token_hash = ${tokenDigest(token)}
         for update`),
    );
    if (!row || row.used || !purposes.includes(row.purpose)) {
      throw new DomainError('auth:link_invalid', { details: { field: 'token' } });
    }
    if (row.expired) throw new DomainError('auth:link_expired', { details: { field: 'token' } });
    return { id: row.id, user_id: row.user_id, purpose: row.purpose };
  }

  async markUsed(tx: AuthTx, id: string): Promise<void> {
    await tx.execute(sql`update public.auth_tokens set used_at = now() where id = ${id}::uuid`);
  }
}
