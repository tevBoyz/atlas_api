import { Inject, Injectable } from '@nestjs/common';

import { DomainError } from '../../common/errors';
import { ApiConfigService } from '../../config';
import { DatabaseService } from '../../db/database.service';
import { AuditService } from '../audit/audit.service';
import type { DeviceInput, EmailPurpose, SignupInput } from './auth-input';
import { AuthLimits } from './auth-limits';
import { AuthLinksRepository } from './auth-links.repository';
import { AuthMessenger, type LinkKind } from './auth-messenger';
import { OtpService } from './otp.service';
import { OTP_TTL_SECONDS } from './phone-verification';
import { type AuthTx, runAuthTransaction } from './auth-transaction';
import { PASSWORD_HASHER, type PasswordHasher } from './password-hasher';
import type { ClientContext } from './sessions.repository';
import { type SessionJson, SessionsService } from './sessions.service';
import { UsersRepository } from './users.repository';

/** One verification sent by A1 (D78): an emailed link or a texted code. */
export interface SignupVerification {
  channel: 'email' | 'phone';
  expires_in_seconds: number;
}

/**
 * A1's answer (D78): `verification` = the first of `verifications` (the email link when an email
 * was given, else the phone code); `verifications` = every verification sent, email first.
 */
export interface SignupAccepted {
  verification: SignupVerification;
  verifications: SignupVerification[];
}

interface QueuedLink {
  to: string;
  kind: LinkKind;
  token: string;
}

/**
 * Sign-up and email verification (API-100-52, spec §8.1/§8.2, D5a; D78 replaces D5b and D28's
 * "all three" for A1).
 *
 * - A1: email OR phone (at least one) + full name + password. A duplicate email / phone is 409
 *   `signup:already_registered` (`details.field`). Verification goes to the contacts given.
 * - A2: a single-use link (300 s) confirms the email and opens a session.
 * - A3: always 202; a new link for an unconfirmed account (signup) or a sign-in link for any
 *   account (magic_link); nothing for an unknown address. 4 sends per address per 15 minutes.
 */
@Injectable()
export class SignupService {
  constructor(
    private readonly database: DatabaseService,
    private readonly users: UsersRepository,
    private readonly links: AuthLinksRepository,
    private readonly sessions: SessionsService,
    private readonly messenger: AuthMessenger,
    private readonly limits: AuthLimits,
    private readonly audit: AuditService,
    private readonly config: ApiConfigService,
    private readonly otp: OtpService,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
  ) {}

  private get linkTtl(): number {
    return this.config.get('AUTH_EMAIL_LINK_TTL_SECONDS');
  }

  /**
   * A1 (D78, Stage 3 [B1]): email OR phone (at least one). A duplicate email or phone is 409
   * `signup:already_registered` with `details.field` "email" | "phone" (email checked first); this
   * replaces D5b's neutral answer, as SCRUM-14 asks. A new account gets its credential, an `email`
   * identity when an email was given, an emailed link (email) and a texted code (phone, through the
   * existing OTP channel: verify it with `POST /v1/auth/otp/verify` purpose `sign_in`, which opens a
   * session and confirms the phone). A phone-only sign-up while SMS is off is 503
   * `auth:sms_unavailable` before anything is written. A code that could not be sent (rate limit,
   * provider down) leaves the account in place; the app resends with `/v1/auth/otp/send`.
   */
  async signup(input: SignupInput): Promise<SignupAccepted> {
    if (input.email === null && !this.messenger.smsEnabled) {
      throw new DomainError('auth:sms_unavailable');
    }
    if (input.email !== null) {
      await this.limits.takeSend('email', input.email, 'auth:over_email_send_rate_limit');
    }
    const credential = await this.hasher.hash(input.password);
    const queued = await runAuthTransaction(this.database, async (tx) => {
      await this.refuseDuplicate(tx, input);
      const metadata = { full_name: input.full_name };
      const id = await this.users.insert(tx, { email: input.email, phone: input.phone, metadata });
      if (!id) {
        // A concurrent sign-up took the email or the phone meanwhile.
        await this.refuseDuplicate(tx, input);
        throw new DomainError('signup:already_registered', {
          details: { field: input.email !== null ? 'email' : 'phone' },
        });
      }
      await this.users.setCredential(tx, id, credential);
      if (input.email !== null) await this.users.addIdentity(tx, id, 'email', id, input.email);
      const token =
        input.email !== null
          ? await this.links.create(tx, id, 'email_verify', this.linkTtl)
          : undefined;
      await this.audit.record(
        {
          action: 'auth.signup',
          actor_user_id: id,
          target_type: 'user',
          target_id: id,
          detail: { method: 'password', platform: input.device.platform },
        },
        tx,
      );
      return input.email !== null && token
        ? ({ to: input.email, kind: 'signup', token } satisfies QueuedLink)
        : undefined;
    });
    const verifications: SignupVerification[] = [];
    if (queued) {
      this.messenger.emailLink(queued.to, queued.kind, queued.token);
      verifications.push({ channel: 'email', expires_in_seconds: this.linkTtl });
    }
    if (input.phone !== null && this.messenger.smsEnabled) {
      let expires = OTP_TTL_SECONDS;
      try {
        expires = (await this.otp.send(input.phone, 'sign_in', null)).expires_in_seconds;
      } catch {
        // The account exists; the app asks for a new code (A4/A5) when this one never arrives.
      }
      verifications.push({ channel: 'phone', expires_in_seconds: expires });
    }
    return { verification: verifications[0], verifications };
  }

  /** 409 `signup:already_registered` naming the field of an existing account (email first). */
  private async refuseDuplicate(tx: AuthTx, input: SignupInput): Promise<void> {
    if (input.email !== null && (await this.users.byEmail(tx, input.email))) {
      throw new DomainError('signup:already_registered', { details: { field: 'email' } });
    }
    if (input.phone !== null && (await this.users.phoneTaken(tx, input.phone))) {
      throw new DomainError('signup:already_registered', { details: { field: 'phone' } });
    }
  }

  /** A2: the token of a `type=signup` or `type=magiclink` link → a session. */
  async verifyEmail(
    token: string,
    device: DeviceInput,
    client: ClientContext,
  ): Promise<SessionJson> {
    const pending = await runAuthTransaction(this.database, async (tx) => {
      const link = await this.links.lockUsable(tx, token, ['email_verify', 'magic_link']);
      const user = await this.users.byId(tx, link.user_id, true);
      if (!user) throw new DomainError('auth:link_invalid', { details: { field: 'token' } });
      if (user.disabled) throw new DomainError('auth:user_disabled');
      await this.links.markUsed(tx, link.id);
      const newly = await this.users.confirmEmail(tx, user.id);
      await this.recordVerified(tx, user.id, link.purpose, newly);
      return this.sessions.open(tx, user.id, 'email_link', device, client);
    });
    return this.sessions.finish(pending);
  }

  private async recordVerified(
    tx: AuthTx,
    userId: string,
    purpose: string,
    newly: boolean,
  ): Promise<void> {
    if (newly) {
      await this.audit.record(
        {
          action: 'auth.email_verified',
          actor_user_id: userId,
          target_type: 'user',
          target_id: userId,
        },
        tx,
      );
    }
    if (purpose === 'magic_link') {
      await this.audit.record(
        {
          action: 'auth.login.success',
          actor_user_id: userId,
          target_type: 'user',
          target_id: userId,
          detail: { method: 'magic_link' },
        },
        tx,
      );
    }
  }

  /** A3: always 202 (429 past the per-address limit). */
  async resend(email: string, purpose: EmailPurpose): Promise<void> {
    await this.limits.takeSend('email', email, 'auth:over_email_send_rate_limit');
    const queued = await runAuthTransaction(this.database, async (tx) => {
      const user = await this.users.byEmail(tx, email);
      if (!user || user.disabled) return undefined;
      if (purpose === 'signup') {
        if (user.email_confirmed) return undefined;
        const token = await this.links.create(tx, user.id, 'email_verify', this.linkTtl);
        return { to: email, kind: 'signup', token } satisfies QueuedLink;
      }
      const token = await this.links.create(tx, user.id, 'magic_link', this.linkTtl);
      return { to: email, kind: 'magiclink', token } satisfies QueuedLink;
    });
    if (queued) this.messenger.emailLink(queued.to, queued.kind, queued.token);
  }
}
