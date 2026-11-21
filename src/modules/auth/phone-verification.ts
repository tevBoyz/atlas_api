import { randomInt, timingSafeEqual } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import type { Logger } from 'pino';

import { ApiConfigService } from '../../config';
import { ROOT_LOGGER } from '../../observability/logger';
import {
  FetchTransport,
  type HttpResponse,
  type HttpTransport,
} from '../notifications/channels/http-transport';
import { AuthMessenger } from './auth-messenger';

/** Code length and lifetime (spec §6.9 rule 50: 6 digits, 600 s). */
export const OTP_LENGTH = 6;
export const OTP_TTL_SECONDS = 600;

export type StartResult = 'sent' | 'unavailable';
export type CheckResult = 'approved' | 'wrong' | 'expired' | 'unavailable';

/**
 * Phone verification codes (API-100-53): the provider makes, sends and checks the code; the API
 * never stores or logs it (AC4). Twilio Verify in production (behind the Twilio hold); a fake in
 * development and tests that texts its code through the SMS channel adapter (the fake SMS sender).
 */
export interface PhoneVerifier {
  start(phone: string): Promise<StartResult>;
  check(phone: string, code: string): Promise<CheckResult>;
}

/** DI token of the {@link PhoneVerifier}. */
export const PHONE_VERIFIER = Symbol('PHONE_VERIFIER');

/**
 * The fake: a random 6-digit code per number, valid 600 s, kept in this process's memory only (as
 * Twilio Verify keeps it), texted through the SMS adapter (fake unless the Twilio hold is lifted).
 * A new start replaces the code. Approved codes are single use.
 */
export class FakePhoneVerifier implements PhoneVerifier {
  private readonly codes = new Map<string, { code: string; expiresAt: number }>();

  constructor(
    private readonly messenger: AuthMessenger,
    private readonly now: () => number = Date.now,
  ) {}

  async start(phone: string): Promise<StartResult> {
    const code = String(randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, '0');
    this.codes.set(phone, { code, expiresAt: this.now() + OTP_TTL_SECONDS * 1000 });
    const sent = await this.messenger.sms(
      phone,
      `Your Atlas code is ${code}. It expires in ${OTP_TTL_SECONDS / 60} minutes.`,
    );
    if (!sent) {
      this.codes.delete(phone);
      return 'unavailable';
    }
    return 'sent';
  }

  check(phone: string, code: string): Promise<CheckResult> {
    const entry = this.codes.get(phone);
    if (!entry || entry.expiresAt <= this.now()) {
      this.codes.delete(phone);
      return Promise.resolve('expired');
    }
    const a = Buffer.from(entry.code);
    const b = Buffer.from(code);
    if (a.length === b.length && timingSafeEqual(a, b)) {
      this.codes.delete(phone);
      return Promise.resolve('approved');
    }
    return Promise.resolve('wrong');
  }
}

export interface TwilioVerifyCredentials {
  accountSid: string;
  authToken: string;
  serviceSid: string;
}

function parse(response: HttpResponse): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(response.body);
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Twilio Verify (`/v2/Services/{sid}/Verifications` and `/VerificationCheck`). Only built when the
 * SMS adapter is `twilio`, the Twilio hold is lifted and every Twilio key is set (D24). Unit-tested
 * against a fake transport only; tests never reach Twilio.
 */
export class TwilioVerifyPhoneVerifier implements PhoneVerifier {
  constructor(
    private readonly credentials: TwilioVerifyCredentials,
    private readonly transport: HttpTransport,
  ) {}

  private post(path: string, form: Record<string, string>): Promise<HttpResponse> {
    const basic = Buffer.from(`${this.credentials.accountSid}:${this.credentials.authToken}`);
    return this.transport.request({
      method: 'POST',
      url: `https://verify.twilio.com/v2/Services/${encodeURIComponent(this.credentials.serviceSid)}/${path}`,
      headers: {
        authorization: `Basic ${basic.toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(form).toString(),
    });
  }

  async start(phone: string): Promise<StartResult> {
    try {
      const response = await this.post('Verifications', { To: phone, Channel: 'sms' });
      return response.status === 200 || response.status === 201 ? 'sent' : 'unavailable';
    } catch {
      return 'unavailable';
    }
  }

  async check(phone: string, code: string): Promise<CheckResult> {
    let response: HttpResponse;
    try {
      response = await this.post('VerificationCheck', { To: phone, Code: code });
    } catch {
      return 'unavailable';
    }
    // 404: no pending verification (expired, approved already, or too many checks).
    if (response.status === 404) return 'expired';
    if (response.status !== 200) return 'unavailable';
    const status = parse(response).status;
    if (status === 'approved') return 'approved';
    if (status === 'pending') return 'wrong';
    return 'expired';
  }
}

/** Twilio as the SMS adapter but no Verify service configured: no codes at all (503). */
export class UnavailablePhoneVerifier implements PhoneVerifier {
  start(): Promise<StartResult> {
    return Promise.resolve('unavailable');
  }
  check(): Promise<CheckResult> {
    return Promise.resolve('unavailable');
  }
}

/**
 * Picks the verifier at startup, like the channel adapters (D24): Twilio Verify when the SMS adapter
 * is `twilio` (hold lifted) with TWILIO_VERIFY_SERVICE_SID; none when `twilio` lacks that SID (the
 * fake must never text real numbers); otherwise the fake.
 */
@Injectable()
export class PhoneVerifierFactory {
  constructor(
    private readonly config: ApiConfigService,
    private readonly messenger: AuthMessenger,
    @Inject(ROOT_LOGGER) private readonly logger: Logger,
  ) {}

  create(): PhoneVerifier {
    const c = this.config;
    const sid = c.get('TWILIO_ACCOUNT_SID');
    const token = c.get('TWILIO_AUTH_TOKEN');
    const service = c.get('TWILIO_VERIFY_SERVICE_SID');
    if (
      c.get('CHANNEL_SMS_ADAPTER') === 'twilio' &&
      c.get('CHANNEL_SMS_TWILIO_HOLD_LIFTED') &&
      sid &&
      token &&
      service
    ) {
      this.logger.info({ verifier: 'twilio_verify' }, 'phone verification');
      return new TwilioVerifyPhoneVerifier(
        { accountSid: sid, authToken: token, serviceSid: service },
        new FetchTransport(c.get('NOTIFICATIONS_SEND_TIMEOUT_MS')),
      );
    }
    if (c.get('CHANNEL_SMS_ADAPTER') === 'twilio') {
      this.logger.warn('phone verification unavailable: TWILIO_VERIFY_SERVICE_SID is not set');
      return new UnavailablePhoneVerifier();
    }
    return new FakePhoneVerifier(this.messenger);
  }
}
