import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';

import { DomainError } from '../../common/errors';
import { currentRequestContext } from '../../common/http/request-context';
import { DatabaseService } from '../../db/database.service';
import { ROOT_LOGGER } from '../../observability/logger';
import { AuditService } from '../audit/audit.service';
import type { Identifier, LoginInput } from './auth-input';
import { AuthLimits, LOGIN_CLEAR_LIMIT, LOGIN_FAILURE_LIMIT } from './auth-limits';
import { type AuthTx, runAuthTransaction } from './auth-transaction';
import { LegacyUsers } from './legacy-users';
import { LockoutRepository, type LockoutStatus } from './lockout.repository';
import { PASSWORD_HASHER, type PasswordHasher, type StoredHash } from './password-hasher';
import type { ClientContext } from './sessions.repository';
import { type PendingSession, type SessionJson, SessionsService } from './sessions.service';
import { type UserRow, UsersRepository } from './users.repository';

const locked = (status: LockoutStatus) =>
  new DomainError('login_lockout:locked', { details: { ...status } });

/** The client IP the per-IP lockout budgets count (as the rate limiter sees it). */
function ipSubject(): string {
  return `ip:${currentRequestContext()?.ip ?? 'unknown'}`;
}

/**
 * Password sign-in with the lockout (API-100-54, spec §6.8 rules 42-48, §7.5, §7.6, §8.4).
 *
 * One request does what the app did in four calls (status, sign in, record failure, clear):
 * 1. the lock key of the identifier (rule 44) is loaded and reset if due; a locked key → 423
 *    `login_lockout:locked` with the LockoutStatus, before any password is tried;
 * 2. the password is checked through the `PasswordHasher` (an unknown account or one without a
 *    password spends the same time; uniform answers, rule 45);
 * 3. wrong → the failure counts (rule 42: only wrong passwords count, rule 43), unless this IP is past
 *    15 failures in 5 minutes (429 `login_lockout:rate_limited`, nothing counted, as the SQL); the
 *    5th → 423 with the status, else 401 `auth:invalid_credentials` with the status;
 * 4. right → the key is checked again under its row lock (the access-token hook, rule 46: a lock
 *    taken meanwhile wins); unconfirmed → 403 `auth:email_not_confirmed` / `auth:phone_not_confirmed`
 *    (not counted); else the user's lock rows are cleared (rule 47; skipped past 30 clears per IP in
 *    5 minutes, as the SQL's throttled clear), a bcrypt hash becomes argon2id (API-100-58) and a
 *    session opens.
 */
@Injectable()
export class LoginService {
  constructor(
    private readonly database: DatabaseService,
    private readonly users: UsersRepository,
    private readonly lockouts: LockoutRepository,
    private readonly sessions: SessionsService,
    private readonly limits: AuthLimits,
    private readonly audit: AuditService,
    private readonly legacy: LegacyUsers,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
  ) {}

  /** A8 `GET /v1/auth/lockout-status` (`login_lockout_status`). */
  async status(identifier: Identifier): Promise<LockoutStatus> {
    await this.migrate(identifier);
    return runAuthTransaction(this.database, async (tx) =>
      this.lockouts.status(tx, await this.lockouts.keyOf(tx, identifier)),
    );
  }

  private migrate(identifier: Identifier): Promise<void> {
    return identifier.kind === 'email'
      ? this.legacy.migrateByEmail(identifier.email)
      : this.legacy.migrateByPhone(identifier.phone);
  }

  private findUser(tx: AuthTx, identifier: Identifier): Promise<UserRow | undefined> {
    return identifier.kind === 'email'
      ? this.users.byEmail(tx, identifier.email)
      : this.users.byPhone(tx, identifier.phone);
  }

  /** A7 `POST /v1/auth/login`. */
  async login(input: LoginInput, client: ClientContext): Promise<SessionJson> {
    await this.migrate(input.identifier);

    // 1. Lock key, resets, and the lock check (commits the resets, as login_lockout_status).
    const before = await runAuthTransaction(this.database, async (tx) => {
      const key = await this.lockouts.keyOf(tx, input.identifier);
      const status = await this.lockouts.status(tx, key);
      const user = await this.findUser(tx, input.identifier);
      const credential = user ? await this.users.credentialOf(tx, user.id) : undefined;
      return { key, status, user, credential };
    });
    if (before.status.locked) {
      await this.recordFailureAudit(before.user?.id ?? null, 'locked', input.identifier);
      throw locked(before.status);
    }

    // 2. The password (outside any transaction: argon2 takes tens of milliseconds).
    const ok = await this.check(input.password, before.credential);

    if (!ok) {
      // 3. A wrong password counts, within this IP's failure budget.
      const counted = await this.limits.take(
        LOGIN_FAILURE_LIMIT.name,
        ipSubject(),
        LOGIN_FAILURE_LIMIT.max,
        LOGIN_FAILURE_LIMIT.windowSeconds,
      );
      if (!counted) throw new DomainError('login_lockout:rate_limited', { retryAfterSeconds: 60 });
      const result = await runAuthTransaction(this.database, async (tx) => {
        const failure = await this.lockouts.recordFailure(tx, before.key);
        await this.audit.record(
          {
            action: 'auth.login.failure',
            actor_user_id: null,
            target_type: before.user ? 'user' : null,
            target_id: before.user?.id ?? null,
            detail: {
              method: 'password',
              identifier: input.identifier.kind,
              reason: failure.alreadyLocked ? 'locked' : 'invalid_credentials',
              failed_attempts: failure.status.failed_attempts,
            },
          },
          tx,
        );
        return failure;
      });
      if (result.status.locked) throw locked(result.status);
      throw new DomainError('auth:invalid_credentials', { details: { ...result.status } });
    }

    // 4. Right password (an account with a credential exists).
    const user = before.user!;
    const rehash = this.hasher.needsRehash(before.credential!)
      ? await this.hasher.hash(input.password)
      : undefined;
    const clears = await this.limits.take(
      LOGIN_CLEAR_LIMIT.name,
      ipSubject(),
      LOGIN_CLEAR_LIMIT.max,
      LOGIN_CLEAR_LIMIT.windowSeconds,
    );
    type Refusal =
      'invalid_credentials' | 'email_not_confirmed' | 'phone_not_confirmed' | 'user_disabled';
    type Outcome =
      | { kind: 'locked'; status: LockoutStatus }
      | { kind: 'refused'; reason: Refusal }
      | { kind: 'session'; session: PendingSession };
    const outcome = await runAuthTransaction(this.database, async (tx): Promise<Outcome> => {
      const lock = await this.lockouts.isLocked(tx, before.key);
      if (lock) return { kind: 'locked', status: lock };
      const row = await this.users.byId(tx, user.id, true);
      if (!row) return { kind: 'refused', reason: 'invalid_credentials' };
      if (input.identifier.kind === 'email' && !row.email_confirmed) {
        return { kind: 'refused', reason: 'email_not_confirmed' };
      }
      if (input.identifier.kind === 'phone' && !row.phone_confirmed) {
        return { kind: 'refused', reason: 'phone_not_confirmed' };
      }
      if (row.disabled) return { kind: 'refused', reason: 'user_disabled' };
      if (clears) await this.lockouts.clear(tx, await this.lockouts.keysOfUser(tx, user.id));
      const rehashed = rehash
        ? await this.users.rehashCredential(tx, user.id, before.credential!, rehash)
        : false;
      await this.audit.record(
        {
          action: 'auth.login.success',
          actor_user_id: user.id,
          target_type: 'user',
          target_id: user.id,
          detail: { method: 'password', identifier: input.identifier.kind, rehashed },
        },
        tx,
      );
      const session = await this.sessions.open(tx, user.id, 'password', input.device, client);
      return { kind: 'session', session };
    });
    if (outcome.kind === 'locked') throw locked(outcome.status);
    if (outcome.kind === 'refused') {
      await this.recordFailureAudit(user.id, outcome.reason, input.identifier);
      throw new DomainError(`auth:${outcome.reason}`);
    }
    if (!clears) this.logger.info({ reason: 'clear_rate_limited' }, 'lockout not cleared');
    return this.sessions.finish(outcome.session);
  }

  private async check(password: string, credential: StoredHash | undefined): Promise<boolean> {
    if (!credential) {
      await this.hasher.burn(password);
      return false;
    }
    return this.hasher.verify(password, credential);
  }

  private async recordFailureAudit(
    userId: string | null,
    reason: string,
    identifier: Identifier,
  ): Promise<void> {
    await runAuthTransaction(this.database, (tx) =>
      this.audit.record(
        {
          action: 'auth.login.failure',
          actor_user_id: null,
          target_type: userId ? 'user' : null,
          target_id: userId,
          detail: { method: 'password', identifier: identifier.kind, reason },
        },
        tx,
      ),
    );
  }
}
