import { createHash, timingSafeEqual } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';

import { DomainError } from '../../common/errors';
import { currentRequestContext } from '../../common/http/request-context';
import { DatabaseService } from '../../db/database.service';
import { AuditService } from '../audit/audit.service';
import type { DeviceInput } from './auth-input';
import { AuthLimits, LOGIN_CLEAR_LIMIT } from './auth-limits';
import { type AuthTx, runAuthTransaction } from './auth-transaction';
import {
  ID_TOKEN_VERIFIER,
  type IdTokenClaims,
  IdTokenInvalidError,
  type IdTokenVerifier,
  type OAuthProvider,
} from './id-token-verifier';
import { LockoutRepository } from './lockout.repository';
import type { ClientContext } from './sessions.repository';
import { type PendingSession, type SessionJson, SessionsService } from './sessions.service';
import { UsersRepository } from './users.repository';

export interface OAuthSessionJson extends SessionJson {
  is_new_user: boolean;
}

export interface OAuthExtras {
  /** Apple: the raw nonce whose SHA-256 (hex) the app gave Apple. */
  nonce: string | null;
  /** Apple: the name Apple returns once, on the first sign-in. */
  fullName: string | null;
}

const invalid = () =>
  new DomainError('auth:oauth_invalid_token', { details: { field: 'id_token' } });

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Google and Apple sign-in with an ID token (API-100-55, spec §8.5, D6).
 *
 * 1. Provider off (Google without client ids, Apple unless APPLE_SIGN_IN_ENABLED) → 503
 *    `auth:provider_disabled` (the app shows "not available yet").
 * 2. The token is verified against the provider's JWKS (`iss`, `aud` ∈ client ids, `exp`) → else
 *    401 `auth:oauth_invalid_token`; keys unreachable → 503 `auth:provider_unavailable`. Apple: a
 *    nonce on either side must match (SHA-256 of the raw nonce).
 * 3. The account: by `(provider, sub)`; else an account with the same email is linked ONLY when the
 *    provider asserts the email is verified (D6), otherwise 409 `auth:identity_conflict` (neutral
 *    wording); else a new account (`is_new_user: true`).
 * 4. Google clears the account's lockout rows (rule 47, as today; Apple does not), then a session.
 */
@Injectable()
export class OAuthService {
  constructor(
    private readonly database: DatabaseService,
    private readonly users: UsersRepository,
    private readonly sessions: SessionsService,
    private readonly lockouts: LockoutRepository,
    private readonly limits: AuthLimits,
    private readonly audit: AuditService,
    @Inject(ID_TOKEN_VERIFIER) private readonly verifier: IdTokenVerifier,
  ) {}

  async signIn(
    provider: OAuthProvider,
    idToken: string,
    extras: OAuthExtras,
    device: DeviceInput,
    client: ClientContext,
  ): Promise<OAuthSessionJson> {
    if (!this.verifier.isEnabled(provider)) throw new DomainError('auth:provider_disabled');
    let claims: IdTokenClaims;
    try {
      claims = await this.verifier.verify(provider, idToken);
    } catch (error) {
      if (error instanceof IdTokenInvalidError) throw invalid();
      throw new DomainError('auth:provider_unavailable');
    }
    if (provider === 'apple') this.checkNonce(claims, extras.nonce);

    const clears =
      provider === 'google' &&
      (await this.limits.take(
        LOGIN_CLEAR_LIMIT.name,
        `ip:${currentRequestContext()?.ip ?? 'unknown'}`,
        LOGIN_CLEAR_LIMIT.max,
        LOGIN_CLEAR_LIMIT.windowSeconds,
      ));

    const outcome = await runAuthTransaction(this.database, async (tx) => {
      const { userId, isNew } = await this.accountFor(tx, provider, claims, extras);
      const user = await this.users.byId(tx, userId, true);
      if (!user) throw invalid();
      if (user.disabled) throw new DomainError('auth:user_disabled');
      if (clears) await this.lockouts.clear(tx, await this.lockouts.keysOfUser(tx, userId));
      await this.audit.record(
        {
          action: 'auth.login.success',
          actor_user_id: userId,
          target_type: 'user',
          target_id: userId,
          detail: { method: provider, new_user: isNew },
        },
        tx,
      );
      const pending: PendingSession = await this.sessions.open(
        tx,
        userId,
        provider,
        device,
        client,
      );
      return { pending, isNew };
    });
    return { ...(await this.sessions.finish(outcome.pending)), is_new_user: outcome.isNew };
  }

  private checkNonce(claims: IdTokenClaims, nonce: string | null): void {
    if (nonce === null && claims.nonce === null) return;
    if (nonce === null || claims.nonce === null) throw invalid();
    const hashed = createHash('sha256').update(nonce, 'utf8').digest('hex');
    if (!sameText(hashed, claims.nonce)) throw invalid();
  }

  private async accountFor(
    tx: AuthTx,
    provider: OAuthProvider,
    claims: IdTokenClaims,
    extras: OAuthExtras,
  ): Promise<{ userId: string; isNew: boolean }> {
    const linkedId = await this.users.userOfIdentity(tx, provider, claims.sub);
    if (linkedId) return { userId: linkedId, isNew: false };

    if (claims.email) {
      const existing = await this.users.byEmail(tx, claims.email);
      if (existing) {
        // D6: link only when the provider asserts the email is verified.
        if (!claims.emailVerified) throw new DomainError('auth:identity_conflict');
        await this.users.addIdentity(tx, existing.id, provider, claims.sub, claims.email);
        await this.users.confirmEmail(tx, existing.id);
        await this.audit.record(
          {
            action: 'auth.identity.linked',
            actor_user_id: existing.id,
            target_type: 'user',
            target_id: existing.id,
            detail: { provider },
          },
          tx,
        );
        return { userId: existing.id, isNew: false };
      }
    }

    const metadata: Record<string, unknown> = { provider };
    if (extras.fullName) metadata.full_name = extras.fullName;
    const id = await this.users.insert(tx, {
      email: claims.email,
      phone: null,
      emailConfirmed: claims.emailVerified,
      metadata,
    });
    // A concurrent sign-in created the account (unique email): let the client retry.
    if (!id) throw new DomainError('auth:identity_conflict');
    await this.users.addIdentity(tx, id, provider, claims.sub, claims.email);
    await this.audit.record(
      {
        action: 'auth.signup',
        actor_user_id: id,
        target_type: 'user',
        target_id: id,
        detail: { method: provider },
      },
      tx,
    );
    return { userId: id, isNew: true };
  }
}
