import { Inject, Injectable } from '@nestjs/common';

import { DomainError } from '../../common/errors';
import { ApiConfigService } from '../../config';
import { DatabaseService } from '../../db/database.service';
import { AuditService } from '../audit/audit.service';
import type { DeviceInput, EmailPurpose, SignupInput } from './auth-input';
import { AuthLimits } from './auth-limits';
import { AuthLinksRepository } from './auth-links.repository';
import { AuthMessenger, type LinkKind } from './auth-messenger';
import { type AuthTx, runAuthTransaction } from './auth-transaction';
import { PASSWORD_HASHER, type PasswordHasher } from './password-hasher';
import type { ClientContext } from './sessions.repository';
import { type SessionJson, SessionsService } from './sessions.service';
import { UsersRepository } from './users.repository';

/** A1's answer: the same for a new and an existing address (D5b). */
export interface SignupAccepted {
  verification: { channel: 'email'; expires_in_seconds: number };
}

interface QueuedLink {
  to: string;
  kind: LinkKind;
  token: string;
}

/**
 * Sign-up and email verification (API-100-52, spec §8.1/§8.2, D5a, D5b).
 *
 * - A1: the password is hashed (argon2id) whatever happens, so every answer takes the same time.
 *   A new address gets a user (phone stored unverified; a phone already held by another user is kept
 *   in metadata only), its credential, an `email` identity and a verification link. An existing
 *   address gets nothing new: an unconfirmed one a fresh link, a confirmed one no email. The answer
 *   is always 202 "check your email" (no enumeration of emails or phones).
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
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
  ) {}

  private get linkTtl(): number {
    return this.config.get('AUTH_EMAIL_LINK_TTL_SECONDS');
  }

  private accepted(): SignupAccepted {
    return { verification: { channel: 'email', expires_in_seconds: this.linkTtl } };
  }

  async signup(input: SignupInput): Promise<SignupAccepted> {
    await this.limits.takeSend('email', input.email, 'auth:over_email_send_rate_limit');
    const credential = await this.hasher.hash(input.password);
    const queued = await runAuthTransaction(this.database, async (tx) => {
      const existing = await this.users.byEmail(tx, input.email);
      if (existing) {
        if (existing.email_confirmed || existing.disabled) return undefined;
        const token = await this.links.create(tx, existing.id, 'email_verify', this.linkTtl);
        return { to: input.email, kind: 'signup', token } satisfies QueuedLink;
      }
      const metadata = { full_name: input.full_name, signup_phone: input.phone };
      const phoneFree = !(await this.users.phoneTaken(tx, input.phone));
      let id = await this.users.insert(tx, {
        email: input.email,
        phone: phoneFree ? input.phone : null,
        metadata,
      });
      if (!id) {
        // A concurrent sign-up took the email (neutral answer) or the phone (store it in metadata).
        if (await this.users.byEmail(tx, input.email)) return undefined;
        id = await this.users.insert(tx, { email: input.email, phone: null, metadata });
        if (!id) return undefined;
      }
      await this.users.setCredential(tx, id, credential);
      await this.users.addIdentity(tx, id, 'email', id, input.email);
      const token = await this.links.create(tx, id, 'email_verify', this.linkTtl);
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
      return { to: input.email, kind: 'signup', token } satisfies QueuedLink;
    });
    if (queued) this.messenger.emailLink(queued.to, queued.kind, queued.token);
    return this.accepted();
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
