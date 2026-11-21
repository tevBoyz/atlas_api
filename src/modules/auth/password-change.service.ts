import { Inject, Injectable } from '@nestjs/common';

import type { AuthenticatedUser } from '../../common/auth';
import { DomainError } from '../../common/errors';
import { DatabaseService } from '../../db/database.service';
import { AuditService } from '../audit/audit.service';
import { fail, meetsPasswordPolicy } from './auth-input';
import { runAuthTransaction } from './auth-transaction';
import { LegacyUsers } from './legacy-users';
import { PASSWORD_HASHER, type PasswordHasher } from './password-hasher';
import { SessionsRepository } from './sessions.repository';
import { UsersRepository } from './users.repository';

/**
 * A16 `PUT /v1/auth/password` (stage 7.1b, D38): change the password while signed in.
 *
 * Order (as the reset, D33): the current password first (401 `auth:invalid_credentials`, field
 * `current_password`; an account without a password spends the same argon2 time and answers the
 * same), then the policy (422 `auth:weak_password`, D5a, field `new_password`), then a change (422
 * `auth:same_password`). Then argon2id, every OTHER session of the user revoked
 * (`password_change`; with a Supabase token there is no API session to keep, so all are revoked),
 * audit `auth.password.changed {sessions_revoked}`. The lockout rows are not touched (no sign-in).
 * The route limit (10 per user per 15 minutes) is the guard's.
 */
@Injectable()
export class PasswordChangeService {
  constructor(
    private readonly database: DatabaseService,
    private readonly users: UsersRepository,
    private readonly sessionRows: SessionsRepository,
    private readonly audit: AuditService,
    private readonly legacy: LegacyUsers,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
  ) {}

  async change(
    caller: AuthenticatedUser,
    currentPassword: string,
    newPassword: unknown,
  ): Promise<void> {
    await this.legacy.migrateById(caller.id);
    const keep = caller.issuer === 'atlas' ? caller.sessionId : null;
    await runAuthTransaction(this.database, async (tx) => {
      const user = await this.users.byId(tx, caller.id, true);
      if (!user) throw new DomainError('auth:not_authenticated');
      if (user.disabled) throw new DomainError('auth:user_disabled');
      const stored = await this.users.credentialOf(tx, user.id);
      const matches = stored
        ? await this.hasher.verify(currentPassword, stored)
        : (await this.hasher.burn(currentPassword), false);
      if (!matches) throw fail('auth:invalid_credentials', 'current_password');
      if (typeof newPassword !== 'string' || !meetsPasswordPolicy(newPassword)) {
        throw fail('auth:weak_password', 'new_password');
      }
      if (newPassword === currentPassword) throw fail('auth:same_password', 'new_password');
      await this.users.setCredential(tx, user.id, await this.hasher.hash(newPassword));
      const revoked = await this.sessionRows.revokeAllOf(tx, user.id, 'password_change', keep);
      await this.audit.record(
        {
          action: 'auth.password.changed',
          actor_user_id: user.id,
          target_type: 'user',
          target_id: user.id,
          detail: { sessions_revoked: revoked },
        },
        tx,
      );
    });
  }
}
