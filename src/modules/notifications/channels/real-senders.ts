import { importPKCS8, SignJWT } from 'jose';

import type {
  EmailSender,
  PushMessage,
  PushSender,
  PushTarget,
  SendErrorCode,
  SendResult,
  SmsSender,
} from './channel.types';
import { failed } from './channel.types';
import type { HttpResponse, HttpTransport } from './http-transport';
import { pushData, pushText } from './push-content';

/**
 * The real providers (API-100-46 AC2, D43): built only when CHANNEL_PUSH_ADAPTER=real /
 * CHANNEL_SMS_ADAPTER=twilio / CHANNEL_EMAIL_ADAPTER=sendgrid with their keys (config.schema.ts), and only used when the channel is
 * enabled. Keys and tokens never appear in a result, an error or a log: a result carries a provider
 * message id or a {@link SendErrorCode} only.
 */

/** PEM keys from the environment often arrive with literal `\n`. */
export function pemFromEnv(value: string): string {
  return value.includes('\\n') ? value.replace(/\\n/g, '\n') : value;
}

function transportFailure(error: unknown): SendResult {
  // By name, not `instanceof Error`: fetch's timeout is a DOMException, which may come from another
  // realm (it does under the test runner's VM), so `instanceof` would miss it.
  const name =
    error !== null && typeof error === 'object' && 'name' in error && typeof error.name === 'string'
      ? error.name
      : '';
  return failed(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'transport_error');
}

function parseJson(body: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(body);
    return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Common HTTP status mapping; `undefined` = the caller decides. */
function byStatus(status: number): SendErrorCode | undefined {
  if (status === 401 || status === 403) return 'auth_failed';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'provider_unavailable';
  return undefined;
}

export interface FcmCredentials {
  projectId: string;
  clientEmail: string;
  privateKey: string;
}

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

/**
 * FCM HTTP v1 (Android; also iOS tokens issued by FCM). Service-account OAuth: a signed JWT is
 * exchanged for an access token, cached until a minute before it expires.
 */
export class FcmPushSender implements PushSender {
  private accessToken?: { value: string; expiresAt: number };

  constructor(
    private readonly credentials: FcmCredentials,
    private readonly transport: HttpTransport,
    private readonly now: () => number = Date.now,
  ) {}

  async send(target: PushTarget, message: PushMessage): Promise<SendResult> {
    let token: string;
    try {
      token = await this.token();
    } catch {
      return failed('auth_failed');
    }
    const text = pushText(message);
    let response: HttpResponse;
    try {
      response = await this.transport.request({
        method: 'POST',
        url: `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.credentials.projectId)}/messages:send`,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          message: {
            token: target.token,
            notification: text,
            data: pushData(message),
            android: { priority: 'high' },
            apns: { headers: { 'apns-priority': '10' } },
          },
        }),
      });
    } catch (error) {
      return transportFailure(error);
    }
    if (response.status === 200) {
      const name = parseJson(response.body).name;
      return { provider_message_id: typeof name === 'string' ? name : null, status: 'sent' };
    }
    if (response.status === 401) this.accessToken = undefined;
    return failed(fcmErrorCode(response));
  }

  private async token(): Promise<string> {
    if (this.accessToken && this.accessToken.expiresAt > this.now() + 60_000) {
      return this.accessToken.value;
    }
    const key = await importPKCS8(pemFromEnv(this.credentials.privateKey), 'RS256');
    const assertion = await new SignJWT({ scope: FCM_SCOPE })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(this.credentials.clientEmail)
      .setAudience(GOOGLE_TOKEN_URL)
      .setIssuedAt(Math.floor(this.now() / 1000))
      .setExpirationTime(Math.floor(this.now() / 1000) + 3600)
      .sign(key);
    const response = await this.transport.request({
      method: 'POST',
      url: GOOGLE_TOKEN_URL,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
    });
    const body = parseJson(response.body);
    if (response.status !== 200 || typeof body.access_token !== 'string') {
      throw new Error('fcm oauth refused');
    }
    const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 3600;
    this.accessToken = { value: body.access_token, expiresAt: this.now() + expiresIn * 1000 };
    return body.access_token;
  }
}

/** FCM v1 error → code. `UNREGISTERED` and `SENDER_ID_MISMATCH` mean the token is no longer ours. */
function fcmErrorCode(response: HttpResponse): SendErrorCode {
  const error = parseJson(response.body).error as Record<string, unknown> | undefined;
  const details = Array.isArray(error?.details) ? (error.details as Record<string, unknown>[]) : [];
  const fcmCode = details.find((d) => typeof d.errorCode === 'string')?.errorCode;
  if (fcmCode === 'UNREGISTERED' || fcmCode === 'SENDER_ID_MISMATCH') return 'unregistered';
  if (response.status === 404) return 'unregistered';
  if (fcmCode === 'QUOTA_EXCEEDED') return 'rate_limited';
  if (fcmCode === 'UNAVAILABLE' || fcmCode === 'INTERNAL') return 'provider_unavailable';
  return byStatus(response.status) ?? 'invalid_request';
}

export interface ApnsCredentials {
  keyId: string;
  teamId: string;
  privateKey: string;
  bundleId: string;
  environment: 'production' | 'sandbox';
}

/** APNs provider tokens must be refreshed at most every 60 minutes; this refreshes after 50. */
const APNS_TOKEN_LIFETIME_MS = 50 * 60_000;

/** APNs reasons that mean the device token is no longer valid for this app. */
const APNS_UNREGISTERED = new Set(['Unregistered', 'BadDeviceToken', 'DeviceTokenNotForTopic']);

/** APNs over HTTP/2 with token (ES256 `.p8`) authentication (iOS). */
export class ApnsPushSender implements PushSender {
  private providerToken?: { value: string; issuedAt: number };

  constructor(
    private readonly credentials: ApnsCredentials,
    private readonly transport: HttpTransport,
    private readonly now: () => number = Date.now,
  ) {}

  async send(target: PushTarget, message: PushMessage): Promise<SendResult> {
    let token: string;
    try {
      token = await this.token();
    } catch {
      return failed('auth_failed');
    }
    const host =
      this.credentials.environment === 'sandbox'
        ? 'https://api.sandbox.push.apple.com'
        : 'https://api.push.apple.com';
    let response: HttpResponse;
    try {
      response = await this.transport.request({
        method: 'POST',
        url: `${host}/3/device/${encodeURIComponent(target.token)}`,
        headers: {
          authorization: `bearer ${token}`,
          'apns-topic': this.credentials.bundleId,
          'apns-push-type': 'alert',
          'apns-priority': '10',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          aps: { alert: pushText(message), sound: 'default' },
          ...pushData(message),
        }),
      });
    } catch (error) {
      return transportFailure(error);
    }
    if (response.status === 200) {
      return { provider_message_id: response.headers['apns-id'] ?? null, status: 'sent' };
    }
    const reason = parseJson(response.body).reason;
    if (response.status === 410 || (typeof reason === 'string' && APNS_UNREGISTERED.has(reason))) {
      return failed('unregistered');
    }
    if (reason === 'ExpiredProviderToken' || reason === 'InvalidProviderToken') {
      this.providerToken = undefined;
    }
    return failed(byStatus(response.status) ?? 'invalid_request');
  }

  private async token(): Promise<string> {
    if (this.providerToken && this.now() - this.providerToken.issuedAt < APNS_TOKEN_LIFETIME_MS) {
      return this.providerToken.value;
    }
    const key = await importPKCS8(pemFromEnv(this.credentials.privateKey), 'ES256');
    const issuedAt = this.now();
    const value = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: this.credentials.keyId })
      .setIssuer(this.credentials.teamId)
      .setIssuedAt(Math.floor(issuedAt / 1000))
      .sign(key);
    this.providerToken = { value, issuedAt };
    return value;
  }
}

/** Routes a push to the adapter of the token's provider; a provider without keys is `not_configured`. */
export class RoutingPushSender implements PushSender {
  constructor(private readonly senders: Partial<Record<PushTarget['provider'], PushSender>>) {}

  send(target: PushTarget, message: PushMessage): Promise<SendResult> {
    const sender = this.senders[target.provider];
    return sender ? sender.send(target, message) : Promise.resolve(failed('not_configured'));
  }
}

export interface TwilioCredentials {
  accountSid: string;
  authToken: string;
  from: string;
}

/** Twilio error codes for a number that cannot receive this SMS (invalid, not mobile, opted out). */
const TWILIO_BAD_RECIPIENT = new Set([21211, 21214, 21217, 21408, 21610, 21612, 21614]);

/**
 * Twilio Programmable Messaging. Only constructed when CHANNEL_SMS_ADAPTER=twilio, which the config
 * refuses while the Twilio hold is on (CHANNEL_SMS_TWILIO_HOLD_LIFTED, AC4).
 */
export class TwilioSmsSender implements SmsSender {
  constructor(
    private readonly credentials: TwilioCredentials,
    private readonly transport: HttpTransport,
  ) {}

  async send(to: string, text: string): Promise<SendResult> {
    const basic = Buffer.from(`${this.credentials.accountSid}:${this.credentials.authToken}`);
    let response: HttpResponse;
    try {
      response = await this.transport.request({
        method: 'POST',
        url: `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(this.credentials.accountSid)}/Messages.json`,
        headers: {
          authorization: `Basic ${basic.toString('base64')}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ To: to, From: this.credentials.from, Body: text }).toString(),
      });
    } catch (error) {
      return transportFailure(error);
    }
    const body = parseJson(response.body);
    if (response.status === 200 || response.status === 201) {
      return {
        provider_message_id: typeof body.sid === 'string' ? body.sid : null,
        status: 'sent',
      };
    }
    if (typeof body.code === 'number' && TWILIO_BAD_RECIPIENT.has(body.code)) {
      return failed('invalid_recipient');
    }
    return failed(byStatus(response.status) ?? 'invalid_request');
  }
}

export interface SendGridSettings {
  apiKey: string;
  /** e.g. `https://api.sendgrid.com` (tests: a local fake server). No trailing path. */
  baseUrl: string;
  fromAddress: string;
  fromName?: string;
}

/**
 * SendGrid v3 Mail Send (D43): `POST {base}/v3/mail/send`, Bearer API key, JSON body, plain text
 * only. Click and open tracking are switched off for every message: the auth links carry a
 * single-use token and must reach the app unchanged (no tracking redirect, no pixel).
 *
 * Answers: 2xx (SendGrid answers 202) → `sent` with the `X-Message-Id` header; 400 about the
 * recipient → `invalid_recipient`; any other 4xx → `invalid_request` (both permanent); 401 / 403
 * → `auth_failed`, 429 → `rate_limited`, 5xx → `provider_unavailable`, network failure →
 * `transport_error`, no answer in time → `timeout` (retried, as for the other adapters, D24).
 * The key, the address and the text never appear in a result.
 */
export class SendGridEmailSender implements EmailSender {
  private readonly url: string;

  constructor(
    private readonly settings: SendGridSettings,
    private readonly transport: HttpTransport,
  ) {
    this.url = `${settings.baseUrl.replace(/\/+$/, '')}/v3/mail/send`;
  }

  async send(to: string, subject: string, text: string): Promise<SendResult> {
    let response: HttpResponse;
    try {
      response = await this.transport.request({
        method: 'POST',
        url: this.url,
        headers: {
          authorization: `Bearer ${this.settings.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(sendGridBody(this.settings, to, subject, text)),
      });
    } catch (error) {
      return transportFailure(error);
    }
    if (response.status >= 200 && response.status < 300) {
      const id = response.headers['x-message-id'];
      return { provider_message_id: id && id.length > 0 ? id : null, status: 'sent' };
    }
    return failed(sendGridErrorCode(response));
  }
}

/** The v3 Mail Send body of one plain-text message to one recipient. */
export function sendGridBody(
  settings: Pick<SendGridSettings, 'fromAddress' | 'fromName'>,
  to: string,
  subject: string,
  text: string,
): Record<string, unknown> {
  return {
    personalizations: [{ to: [{ email: to }] }],
    from: settings.fromName
      ? { email: settings.fromAddress, name: settings.fromName }
      : { email: settings.fromAddress },
    subject,
    content: [{ type: 'text/plain', value: text }],
    tracking_settings: {
      click_tracking: { enable: false, enable_text: false },
      open_tracking: { enable: false },
    },
  };
}

/** SendGrid error → code. A 400 naming the recipient field means that address cannot be used. */
function sendGridErrorCode(response: HttpResponse): SendErrorCode {
  const byHttp = byStatus(response.status);
  if (byHttp) return byHttp;
  if (response.status === 400) {
    const errors = parseJson(response.body).errors;
    const list = Array.isArray(errors) ? (errors as Record<string, unknown>[]) : [];
    const aboutRecipient = list.some(
      (e) => typeof e.field === 'string' && /^personalizations\.\d+\.to/.test(e.field),
    );
    if (aboutRecipient) return 'invalid_recipient';
  }
  return 'invalid_request';
}
