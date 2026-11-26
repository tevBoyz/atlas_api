import { isIP } from 'node:net';

import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';

import type { AuthenticatedUser } from '../../common/auth';
import { DomainError } from '../../common/errors';
import { currentRequestContext } from '../../common/http/request-context';
import { ApiConfigService } from '../../config';
import { DatabaseService } from '../../db/database.service';
import { ROOT_LOGGER } from '../../observability/logger';
import { AuditService } from '../audit/audit.service';
import { AccessTokenSigner } from './access-tokens';
import type { DeviceInput } from './auth-input';
import { type AuthTx, runAuthTransaction } from './auth-transaction';
import {
  type AuthMethod,
  type ClientContext,
  type IssuedRefresh,
  type Lifetimes,
  type SessionListEntry,
  SessionsRepository,
} from './sessions.repository';
import { type UserJson, UsersRepository } from './users.repository';

/** `Session` of spec §11.3 (A2, A6, A7, A9-A11, A15, exchange). */
export interface SessionJson {
  access_token: string;
  access_token_expires_at: string;
  refresh_token: string;
  refresh_token_expires_at: string;
  session_id: string;
  user: UserJson;
}

/** A session opened inside a transaction; its access token is signed after the commit. */
export interface PendingSession extends IssuedRefresh {
  userId: string;
  user: UserJson;
}

const USER_AGENT_MAX = 256;

/** Client address and user agent of the current request (for the session row only). */
export function clientContext(userAgent: unknown): ClientContext {
  const context = currentRequestContext();
  const ua =
    typeof userAgent === 'string' && /^[\x20-\x7E]+$/.test(userAgent)
      ? userAgent.slice(0, USER_AGENT_MAX)
      : null;
  return { ip: context && isIP(context.ip) !== 0 ? context.ip : null, userAgent: ua };
}

/**
 * Device sessions (API-100-56, D7): opened by every sign-in, one per device; refresh tokens rotate
 * on every use (30-day lifetime) and a session not refreshed for 7 days ends; a used token presented
 * again revokes the whole session (reuse detection). Sign-out revokes the session and clears its
 * device's push token.
 */
@Injectable()
export class SessionsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly sessions: SessionsRepository,
    private readonly users: UsersRepository,
    private readonly signer: AccessTokenSigner,
    private readonly audit: AuditService,
    private readonly config: ApiConfigService,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
  ) {}

  get lifetimes(): Lifetimes {
    return {
      refreshDays: this.config.get('AUTH_REFRESH_TOKEN_TTL_DAYS'),
      idleDays: this.config.get('AUTH_SESSION_IDLE_DAYS'),
    };
  }

  /** Opens a session in the caller's transaction (sign-in of any kind). */
  async open(
    tx: AuthTx,
    userId: string,
    method: AuthMethod,
    device: DeviceInput,
    client: ClientContext,
    exchangedFrom: string | null = null,
  ): Promise<PendingSession> {
    if (!this.signer.isConfigured) {
      // Own tokens are not configured (development only; production requires the keys).
      throw new Error('own access tokens are not configured (AUTH_JWT_KEYS)');
    }
    const issued = await this.sessions.open(
      tx,
      userId,
      method,
      device,
      client,
      this.lifetimes,
      exchangedFrom,
    );
    const user = await this.users.userJson(tx, userId);
    if (!user) throw new Error('user not found after sign-in');
    return { ...issued, userId, user };
  }

  /** The `Session` response: signs the access token (after the commit). */
  async finish(pending: PendingSession): Promise<SessionJson> {
    const access = await this.signer.issue(pending.userId, pending.sessionId);
    return {
      access_token: access.token,
      access_token_expires_at: access.expiresAt,
      refresh_token: pending.refreshToken,
      refresh_token_expires_at: pending.refreshExpiresAt,
      session_id: pending.sessionId,
      user: pending.user,
    };
  }

  /**
   * A11 `POST /v1/auth/refresh`. Unknown, expired or revoked token, revoked or idle session, or a
   * disabled user → 401 `auth:session_expired` (an idle or expired session is revoked). A token
   * that was already used → the session and all its tokens are revoked, 401
   * `auth:refresh_token_reused` (the revocation commits before the error is answered).
   */
  async refresh(token: string, client: ClientContext): Promise<SessionJson> {
    type Outcome =
      { error: 'auth:session_expired' | 'auth:refresh_token_reused' } | { pending: PendingSession };
    const outcome = await runAuthTransaction(this.database, async (tx): Promise<Outcome> => {
      const presented = await this.sessions.lockPresented(tx, token, this.lifetimes.idleDays);
      if (!presented) return { error: 'auth:session_expired' };
      if (presented.token_used) {
        if (await this.sessions.revoke(tx, presented.session_id, 'refresh_token_reused')) {
          await this.audit.record(
            {
              action: 'auth.refresh.reuse_detected',
              actor_user_id: presented.user_id,
              actor_session_id: presented.session_id,
              target_type: 'device_session',
              target_id: presented.session_id,
            },
            tx,
          );
        }
        return { error: 'auth:refresh_token_reused' };
      }
      if (presented.token_revoked || presented.session_revoked || presented.user_disabled) {
        return { error: 'auth:session_expired' };
      }
      if (presented.token_expired || presented.session_idle) {
        await this.sessions.revoke(tx, presented.session_id, 'idle');
        return { error: 'auth:session_expired' };
      }
      const issued = await this.sessions.rotate(tx, presented, client, this.lifetimes);
      const user = await this.users.userJson(tx, presented.user_id);
      return { pending: { ...issued, userId: presented.user_id, user: user! } };
    });
    if ('error' in outcome) {
      if (outcome.error === 'auth:refresh_token_reused') {
        this.logger.warn({ reason: 'refresh_token_reused' }, 'session revoked');
      }
      throw new DomainError(outcome.error);
    }
    return this.finish(outcome.pending);
  }

  /** A12: revokes the caller's own session and clears its device's push token. */
  async logout(user: AuthenticatedUser): Promise<void> {
    const sessionId = user.sessionId;
    await runAuthTransaction(this.database, async (tx) => {
      await this.sessions.clearPushTokenOfSession(tx, sessionId);
      if (await this.sessions.revoke(tx, sessionId, 'logout')) {
        await this.audit.record(
          {
            action: 'auth.logout',
            actor_user_id: user.id,
            actor_session_id: sessionId,
            target_type: 'device_session',
            target_id: sessionId,
          },
          tx,
        );
      }
    });
  }

  /** A13: revokes every session of the caller and clears the push tokens of all their devices. */
  async logoutAll(user: AuthenticatedUser): Promise<void> {
    await runAuthTransaction(this.database, async (tx) => {
      const revoked = await this.sessions.revokeAllOf(tx, user.id, 'logout_all');
      await this.sessions.clearPushTokensOfUser(tx, user.id);
      await this.audit.record(
        {
          action: 'auth.logout_all',
          actor_user_id: user.id,
          actor_session_id: user.sessionId,
          target_type: 'user',
          target_id: user.id,
          detail: { sessions_revoked: revoked },
        },
        tx,
      );
    });
  }

  /** A19: the caller's live sessions; `current` marks the one of this access token. */
  list(user: AuthenticatedUser): Promise<SessionListEntry[]> {
    const current = user.sessionId;
    return runAuthTransaction(this.database, (tx) =>
      this.sessions.listLive(tx, user.id, current, this.lifetimes.idleDays),
    );
  }

  /** A20: ends one of the caller's sessions (404 `auth:session_not_found` for anything else). */
  async remove(user: AuthenticatedUser, sessionId: string): Promise<void> {
    await runAuthTransaction(this.database, async (tx) => {
      if (!(await this.sessions.lockLive(tx, sessionId, user.id))) {
        throw new DomainError('auth:session_not_found', { details: { field: 'session_id' } });
      }
      await this.sessions.clearPushTokenOfSession(tx, sessionId);
      await this.sessions.revoke(tx, sessionId, 'deleted');
      await this.audit.record(
        {
          action: 'auth.session.revoked',
          actor_user_id: user.id,
          actor_session_id: user.sessionId,
          target_type: 'device_session',
          target_id: sessionId,
        },
        tx,
      );
    });
  }
}
