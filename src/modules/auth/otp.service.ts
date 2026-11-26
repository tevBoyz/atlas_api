import { Inject, Injectable } from '@nestjs/common';

import type { AuthenticatedUser } from '../../common/auth';
import { DomainError } from '../../common/errors';
import { DatabaseService } from '../../db/database.service';
import { AuditService } from '../audit/audit.service';
import { type DeviceInput, fail, type OtpPurpose } from './auth-input';
import { AuthMessenger } from './auth-messenger';
import { type AuthTx, runAuthTransaction } from './auth-transaction';
import { OTP_MAX_ATTEMPTS, OtpCounters, OtpCountersUnavailableError } from './otp-counters';
import { OTP_TTL_SECONDS, PHONE_VERIFIER, type PhoneVerifier } from './phone-verification';
import type { ClientContext } from './sessions.repository';
import { type SessionJson, SessionsService } from './sessions.service';
import { type UserJson, UsersRepository } from './users.repository';

export interface OtpSent {
  expires_in_seconds: number;
  resends_remaining: number;
}

const unavailable = () => new DomainError('auth:sms_unavailable');

/**
 * Phone OTP (API-100-53, spec §11.3 A4-A6, §6.9 now server-enforced, §8.3).
 *
 * - `sign_in` (no access token): a code is sent only to a number that belongs to an account; an
 *   unknown number gets the same 202 and counts the same, and its "code" never verifies (no
 *   enumeration). Verified → a session (`auth_method` otp); the phone is confirmed.
 * - `verify_phone` (access token of the account): the number must be the caller's own; verified →
 *   `phone_confirmed_at` is set; answers `{user}`.
 * - Limits per number (Redis, fail closed): 4 codes per sliding 15 minutes (429
 *   `auth:otp_resend_limit`), 5 failed attempts invalidate the code until a resend (423
 *   `auth:otp_invalidated`), a resend resets the count, a code lives 600 s (410 `auth:otp_expired`).
 * - Codes go through the provider (Twilio Verify, or the fake that texts through the SMS adapter);
 *   with the SMS channel off every send answers 503 `auth:sms_unavailable`. Never logged or stored.
 */
@Injectable()
export class OtpService {
  constructor(
    private readonly database: DatabaseService,
    private readonly users: UsersRepository,
    private readonly sessions: SessionsService,
    private readonly counters: OtpCounters,
    private readonly messenger: AuthMessenger,
    private readonly audit: AuditService,
    @Inject(PHONE_VERIFIER) private readonly verifier: PhoneVerifier,
  ) {}

  /** A4 / A5 (the same, a resend resets the failure count). */
  async send(
    phone: string,
    purpose: OtpPurpose,
    caller: AuthenticatedUser | null,
  ): Promise<OtpSent> {
    if (!this.messenger.smsEnabled) throw unavailable();
    const owner = await this.recipientOf(phone, purpose, caller);
    const decision = await this.withCounters(() => this.counters.takeSend(phone));
    if (!decision.allowed) {
      throw new DomainError('auth:otp_resend_limit', {
        retryAfterSeconds: Math.max(1, Math.ceil(decision.retryAfterMs / 1000)),
        details: { resends_remaining: 0 },
      });
    }
    if (owner) {
      if ((await this.verifier.start(phone)) !== 'sent') throw unavailable();
    }
    await this.withCounters(() => this.counters.markPending(phone));
    return { expires_in_seconds: OTP_TTL_SECONDS, resends_remaining: decision.resendsRemaining };
  }

  /** A6 `sign_in`: a session. */
  async verifySignIn(
    phone: string,
    code: string | null,
    device: DeviceInput,
    client: ClientContext,
  ): Promise<SessionJson> {
    const owner = await this.recipientOf(phone, 'sign_in', null);
    await this.check(phone, code, owner);
    const pending = await runAuthTransaction(this.database, async (tx) => {
      const user = await this.users.byId(tx, owner!, true);
      if (!user || user.phone !== phone) throw this.wrong(OTP_MAX_ATTEMPTS - 1);
      if (user.disabled) throw new DomainError('auth:user_disabled');
      await this.confirm(tx, user.id, user.phone_confirmed);
      await this.audit.record(
        {
          action: 'auth.login.success',
          actor_user_id: user.id,
          target_type: 'user',
          target_id: user.id,
          detail: { method: 'otp' },
        },
        tx,
      );
      return this.sessions.open(tx, user.id, 'otp', device, client);
    });
    return this.sessions.finish(pending);
  }

  /** A6 `verify_phone`: the caller's own number. */
  async verifyPhone(
    phone: string,
    code: string | null,
    caller: AuthenticatedUser,
  ): Promise<{ user: UserJson }> {
    const owner = await this.recipientOf(phone, 'verify_phone', caller);
    await this.check(phone, code, owner);
    return runAuthTransaction(this.database, async (tx) => {
      const user = await this.users.byId(tx, caller.id, true);
      if (!user || user.phone !== phone) throw fail('auth:invalid_phone', 'phone');
      await this.confirm(tx, user.id, user.phone_confirmed);
      return { user: (await this.users.userJson(tx, user.id))! };
    });
  }

  /**
   * A18 `PUT /v1/me/phone` (stage 7.1c, D39): a code to the NEW number; the account keeps its
   * current phone until the code is verified. The limits of the number are A4's (4 codes per 15
   * minutes, a new request resets the failed attempts, 600 s). A number another account holds gets
   * the same 202 and counts the same, but no code (no enumeration, as D28 / D29); its "code" never
   * verifies. Calling it again is the resend.
   */
  async startPhoneChange(phone: string, caller: AuthenticatedUser): Promise<OtpSent> {
    if (!this.messenger.smsEnabled) throw unavailable();
    const free = await this.phoneFreeFor(phone, caller);
    const decision = await this.withCounters(() => this.counters.takeSend(phone));
    if (!decision.allowed) {
      throw new DomainError('auth:otp_resend_limit', {
        retryAfterSeconds: Math.max(1, Math.ceil(decision.retryAfterMs / 1000)),
        details: { resends_remaining: 0 },
      });
    }
    if (free) {
      if ((await this.verifier.start(phone)) !== 'sent') throw unavailable();
    }
    await this.withCounters(() => this.counters.setPhoneChange(caller.id, phone));
    await this.withCounters(() => this.counters.markPending(phone));
    return { expires_in_seconds: OTP_TTL_SECONDS, resends_remaining: decision.resendsRemaining };
  }

  /**
   * A18 `POST /v1/me/phone/verify` (D39): the code of the pending change. `phone` must be the
   * caller's pending number (else 422 `auth:invalid_phone`); attempts and expiry as A6. Verified →
   * the number is the account's phone, confirmed, with a `phone` identity; audit
   * `auth.phone.changed` (no number in it). Answers `{user}`.
   */
  async verifyPhoneChange(
    phone: string,
    code: string | null,
    caller: AuthenticatedUser,
  ): Promise<{ user: UserJson }> {
    if (!(await this.withCounters(() => this.counters.isPhoneChange(caller.id, phone)))) {
      throw fail('auth:invalid_phone', 'phone');
    }
    const free = await this.phoneFreeFor(phone, caller);
    await this.check(phone, code, free ? caller.id : null);
    const result = await runAuthTransaction(this.database, async (tx) => {
      const user = await this.users.byId(tx, caller.id, true);
      if (!user) throw new DomainError('auth:not_authenticated');
      if (user.disabled) throw new DomainError('auth:user_disabled');
      if (!(await this.users.setConfirmedPhone(tx, user.id, phone))) {
        throw fail('auth:invalid_phone', 'phone');
      }
      await this.users.addIdentity(tx, user.id, 'phone', user.id, null);
      await this.audit.record(
        {
          action: 'auth.phone.changed',
          actor_user_id: user.id,
          target_type: 'user',
          target_id: user.id,
          detail: { had_number: user.phone !== null, same_number: user.phone === phone },
        },
        tx,
      );
      return { user: (await this.users.userJson(tx, user.id))! };
    });
    await this.withCounters(() => this.counters.clearPhoneChange(caller.id));
    return result;
  }

  /** The caller may take `phone`: no other account holds it. 401 / 403 for a missing / disabled caller. */
  private async phoneFreeFor(phone: string, caller: AuthenticatedUser): Promise<boolean> {
    return runAuthTransaction(this.database, async (tx) => {
      const user = await this.users.byId(tx, caller.id);
      if (!user) throw new DomainError('auth:not_authenticated');
      if (user.disabled) throw new DomainError('auth:user_disabled');
      const holder = await this.users.byPhone(tx, phone);
      return !holder || holder.id === user.id;
    });
  }

  private async confirm(tx: AuthTx, userId: string, already: boolean): Promise<void> {
    await this.users.confirmPhone(tx, userId);
    const user = (await this.users.byId(tx, userId))!;
    await this.users.addIdentity(tx, userId, 'phone', userId, null);
    if (!already && user.phone_confirmed) {
      await this.audit.record(
        {
          action: 'auth.phone_verified',
          actor_user_id: userId,
          target_type: 'user',
          target_id: userId,
        },
        tx,
      );
    }
  }

  /**
   * The account the code is for. `sign_in`: the account of that number (null when none; the caller
   * is not told). `verify_phone`: the caller, whose own number it must be (else 422
   * `auth:invalid_phone`).
   */
  private async recipientOf(
    phone: string,
    purpose: OtpPurpose,
    caller: AuthenticatedUser | null,
  ): Promise<string | null> {
    if (purpose === 'verify_phone') {
      if (!caller) throw new DomainError('auth:not_authenticated');
      const user = await runAuthTransaction(this.database, (tx) => this.users.byId(tx, caller.id));
      if (!user) throw new DomainError('auth:not_authenticated');
      if (user.phone !== phone) throw fail('auth:invalid_phone', 'phone');
      return user.id;
    }
    const user = await runAuthTransaction(this.database, (tx) => this.users.byPhone(tx, phone));
    return user && !user.disabled ? user.id : null;
  }

  /** Counts the attempt and checks the code; returns only when it is right. */
  private async check(phone: string, code: string | null, owner: string | null): Promise<void> {
    const attempt = await this.withCounters(() => this.counters.takeAttempt(phone));
    if (attempt < 0) throw new DomainError('auth:otp_expired', { details: { field: 'code' } });
    if (attempt > OTP_MAX_ATTEMPTS) {
      throw new DomainError('auth:otp_invalidated', { details: { attempts_remaining: 0 } });
    }
    const remaining = OTP_MAX_ATTEMPTS - attempt;
    if (!owner || code === null) throw this.wrong(remaining);
    const result = await this.verifier.check(phone, code);
    if (result === 'unavailable') throw unavailable();
    if (result === 'expired') {
      await this.withCounters(() => this.counters.clear(phone));
      throw new DomainError('auth:otp_expired', { details: { field: 'code' } });
    }
    if (result === 'wrong') throw this.wrong(remaining);
    await this.withCounters(() => this.counters.clear(phone));
  }

  private wrong(remaining: number): DomainError {
    if (remaining <= 0) {
      return new DomainError('auth:otp_invalidated', { details: { attempts_remaining: 0 } });
    }
    return new DomainError('auth:otp_invalid', {
      details: { field: 'code', attempts_remaining: remaining },
    });
  }

  private async withCounters<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof OtpCountersUnavailableError) throw unavailable();
      throw error;
    }
  }
}
