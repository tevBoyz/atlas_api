import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';

import { ApiConfigService } from '../../config';
import { ROOT_LOGGER } from '../../observability/logger';
import { ChannelSenders } from '../notifications/channels/channel-senders';

/** `type` of an emailed auth link (the app routes on it, spec §8.9). */
export type LinkKind = 'signup' | 'magiclink' | 'recovery';

const SUBJECTS: Record<LinkKind, string> = {
  signup: 'Confirm your Atlas account',
  magiclink: 'Your Atlas sign-in link',
  recovery: 'Reset your Atlas password',
};

const BODIES: Record<LinkKind, string> = {
  signup: 'Open this link on your phone to confirm your email address',
  magiclink: 'Open this link on your phone to sign in to Atlas',
  recovery: 'Open this link on your phone to choose a new Atlas password',
};

/**
 * Sends the auth emails and texts through the Phase 5 channel adapters (API-100-46, D24): email
 * links (verification, magic link, password reset) and, for the fake phone verification, the SMS
 * code. Sends happen after the commit and never block or fail the request (no timing difference
 * between existing and unknown accounts). A disabled channel sends nothing. Emails go through the
 * selected email adapter: the fake by default, SendGrid with CHANNEL_EMAIL_ADAPTER=sendgrid (D43).
 * Addresses, links and codes are never logged.
 */
@Injectable()
export class AuthMessenger {
  constructor(
    private readonly channels: ChannelSenders,
    private readonly config: ApiConfigService,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
  ) {}

  /** The app link of a token: `io.supabase.atlasmobile://login-callback/?type=<kind>&token=<token>`. */
  linkFor(kind: LinkKind, token: string): string {
    const base = this.config.get('AUTH_LINK_BASE');
    return `${base}${base.includes('?') ? '&' : '?'}type=${kind}&token=${token}`;
  }

  /** Emails a link. Fire and forget: the outcome is logged by kind only. */
  emailLink(to: string, kind: LinkKind, token: string): void {
    const ttlMinutes = Math.round(this.config.get('AUTH_EMAIL_LINK_TTL_SECONDS') / 60);
    const text = `${BODIES[kind]} (valid for ${ttlMinutes} minutes):\n\n${this.linkFor(kind, token)}\n\nIf you did not ask for this, ignore this email.`;
    this.dispatch('email', kind, () => this.channels.email.send(to, SUBJECTS[kind], text));
  }

  /** True when SMS can be sent at all (CHANNEL_SMS_ENABLED). */
  get smsEnabled(): boolean {
    return this.channels.isEnabled('sms');
  }

  /** Sends a text (the fake phone verification's code). Awaited: the caller needs the outcome. */
  async sms(to: string, text: string): Promise<boolean> {
    if (!this.smsEnabled) return false;
    const result = await this.channels.sms.send(to, text);
    if (result.status === 'failed') {
      this.logger.warn({ channel: 'sms', error_code: result.error_code }, 'auth sms not sent');
      return false;
    }
    return true;
  }

  private dispatch(
    channel: 'email',
    kind: LinkKind,
    send: () => Promise<{ status: string; error_code?: string }>,
  ): void {
    if (!this.channels.isEnabled(channel)) {
      this.logger.info({ channel, kind }, 'auth email not sent: channel disabled');
      return;
    }
    void send().then(
      (result) => {
        if (result.status === 'failed') {
          this.logger.warn({ channel, kind, error_code: result.error_code }, 'auth email not sent');
        }
      },
      () =>
        this.logger.warn({ channel, kind, error_code: 'transport_error' }, 'auth email not sent'),
    );
  }
}
