import { Inject, Injectable } from '@nestjs/common';

import { DomainError } from '../../common/errors';
import { currentRequestContext } from '../../common/http/request-context';
import { ApiConfigService } from '../../config';
import { DatabaseService } from '../../db/database.service';
import { AuditService } from '../audit/audit.service';
import { type DeviceInput, fail, meetsPasswordPolicy } from './auth-input';
import { AuthLimits, LOGIN_CLEAR_LIMIT } from './auth-limits';
import { AuthLinksRepository } from './auth-links.repository';
import { AuthMessenger } from './auth-messenger';
import { runAuthTransaction } from './auth-transaction';
import { LockoutRepository } from './lockout.repository';
import { PASSWORD_HASHER, type PasswordHasher } from './password-hasher';
import type { ClientContext } from './sessions.repository';
import { SessionsRepository } from './sessions.repository';
import { type SessionJson, SessionsService } from './sessions.service';
import { UsersRepository } from './users.repository';

/**
 * Password reset (API-100-57, spec §8.6, §11.3 A14/A15).
 *
 * - A14: always 202 (no enumeration; 4 emails per address per 15 minutes); an account gets a
 *   single-use `io.supabase.atlasmobile://login-callback/?type=recovery&token=...` link valid
 *   AUTH_EMAIL_LINK_TTL_SECONDS (300 s, like the other email links).
 * - A15: the link token first (400 `auth:link_invalid`, 410 `auth:link_expired`), then the new
 *   password (422 `auth:weak_password`, D5a; 422 `auth:same_password`); a refused password leaves the
 *   link usable. Then argon2id, the email counts as confirmed (the link proved it), the lockout
 *   rows are cleared (rule 47), EVERY existing session of the user is revoked (proposed decision
 *   D30) and a new session opens (`auth_method` recovery).
 */
@Injectable()
export class PasswordResetService {
  constructor(
    private readonly database: DatabaseService,
    private readonly users: UsersRepository,
    private readonly links: AuthLinksRepository,
    private readonly sessions: SessionsService,
    private readonly sessionRows: SessionsRepository,
    private readonly lockouts: LockoutRepository,
    private readonly messenger: AuthMessenger,
    private readonly limits: AuthLimits,
    private readonly audit: AuditService,
    private readonly config: ApiConfigService,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
  ) {}

  /** A14. */
  async forgot(email: string): Promise<void> {
    await this.limits.takeSend('email', email, 'auth:over_email_send_rate_limit');
    const token = await runAuthTransaction(this.database, async (tx) => {
      const user = await this.users.byEmail(tx, email);
      if (!user || user.disabled) return undefined;
      return this.links.create(
        tx,
        user.id,
        'password_reset',
        this.config.get('AUTH_EMAIL_LINK_TTL_SECONDS'),
      );
    });
    if (token) this.messenger.emailLink(email, 'recovery', token);
  }

  /** A15. */
  async reset(
    token: string,
    newPassword: unknown,
    device: DeviceInput,
    client: ClientContext,
  ): Promise<SessionJson> {
    const clears = await this.limits.take(
      LOGIN_CLEAR_LIMIT.name,
      `ip:${currentRequestContext()?.ip ?? 'unknown'}`,
      LOGIN_CLEAR_LIMIT.max,
      LOGIN_CLEAR_LIMIT.windowSeconds,
    );
    const pending = await runAuthTransaction(this.database, async (tx) => {
      const link = await this.links.lockUsable(tx, token, ['password_reset']);
      if (typeof newPassword !== 'string' || !meetsPasswordPolicy(newPassword)) {
        throw fail('auth:weak_password', 'new_password');
      }
      const user = await this.users.byId(tx, link.user_id, true);
      if (!user) throw new DomainError('auth:link_invalid', { details: { field: 'token' } });
      if (user.disabled) throw new DomainError('auth:user_disabled');
      const current = await this.users.credentialOf(tx, user.id);
      if (current && (await this.hasher.verify(newPassword, current))) {
        throw fail('auth:same_password', 'new_password');
      }
      await this.users.setCredential(tx, user.id, await this.hasher.hash(newPassword));
      await this.links.markUsed(tx, link.id);
      await this.users.confirmEmail(tx, user.id);
      const revoked = await this.sessionRows.revokeAllOf(tx, user.id, 'password_reset');
      if (clears) await this.lockouts.clear(tx, await this.lockouts.keysOfUser(tx, user.id));
      await this.audit.record(
        {
          action: 'auth.password.reset',
          actor_user_id: user.id,
          target_type: 'user',
          target_id: user.id,
          detail: { sessions_revoked: revoked },
        },
        tx,
      );
      return this.sessions.open(tx, user.id, 'recovery', device, client);
    });
    return this.sessions.finish(pending);
  }
}
