/**
 * Channel adapters (API-100-46, spec §11.6, decision D24): push (FCM for Android, APNs for iOS), SMS
 * (Twilio) and email, each behind one interface so providers can be swapped and stay switched off
 * until Dawit lifts each hold. Every adapter answers with a {@link SendResult} and never throws for
 * a provider answer; a network failure or timeout is a `failed` result too.
 */

export const CHANNELS = ['push', 'sms', 'email'] as const;
export type Channel = (typeof CHANNELS)[number];

/** What one send attempt achieved (AC1). `delivered` only when the provider confirms receipt. */
export type SendStatus = 'sent' | 'delivered' | 'failed';

export interface SendResult {
  provider_message_id: string | null;
  status: SendStatus;
  /** Set when `status` is `failed`: one of {@link SEND_ERROR_CODES}. */
  error_code?: SendErrorCode;
}

/**
 * Failure codes. `unregistered` (the provider says the push token is no longer valid: it is cleared
 * from `user_devices`, API-100-47 AC4), `invalid_recipient`, `invalid_request` and `not_configured`
 * are permanent: retrying cannot help. The others are retried.
 */
export const SEND_ERROR_CODES = [
  'unregistered',
  'invalid_recipient',
  'invalid_request',
  'not_configured',
  'auth_failed',
  'rate_limited',
  'provider_unavailable',
  'timeout',
  'transport_error',
  'fake_unavailable',
] as const;
export type SendErrorCode = (typeof SEND_ERROR_CODES)[number];

const PERMANENT: ReadonlySet<SendErrorCode> = new Set([
  'unregistered',
  'invalid_recipient',
  'invalid_request',
  'not_configured',
]);

/** True when retrying the same send can never succeed. */
export function isPermanentFailure(code: SendErrorCode | undefined): boolean {
  return code !== undefined && PERMANENT.has(code);
}

export function failed(error_code: SendErrorCode): SendResult {
  return { provider_message_id: null, status: 'failed', error_code };
}

/**
 * The content of a push notification (AC3): the incident id, the emergency type, the resident's
 * display name and the time, plus the topic so the app knows which notice it is. Nothing else:
 * no share or medical data, notes, coordinates or member data.
 */
export interface PushMessage {
  topic: string;
  incident_id: string;
  emergency_type: string | null;
  resident_name: string | null;
  occurred_at: string | null;
}

export type PushProviderName = 'fcm' | 'apns';

export interface PushTarget {
  provider: PushProviderName;
  token: string;
}

export interface PushSender {
  send(target: PushTarget, message: PushMessage): Promise<SendResult>;
}

/** SMS text to one E.164 number. */
export interface SmsSender {
  send(to: string, text: string): Promise<SendResult>;
}

export interface EmailSender {
  send(to: string, subject: string, text: string): Promise<SendResult>;
}
