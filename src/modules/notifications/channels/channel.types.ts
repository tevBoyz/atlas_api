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
  /**
   * Stage 2 [B6]: alert notices only (`incident.created` / `incident.renotified`): the incident's
   * reverse-geocoded place at send time (null = not known: the text says "Location unavailable").
   * Only in the visible text, never a data key. Undefined for every other notice.
   */
  place_name?: string | null;
}

/** SCRUM-35 (D67): the outbox / push topic of a test alert. */
export const TEST_ALERT_TOPIC = 'circle.test_alert';

/**
 * The content of a test-alert push (SCRUM-35, D67): the test alert id, the owner's display name and
 * the time it was sent, plus the topic. Never an incident id: a test is not an incident.
 */
export interface TestAlertPushMessage {
  topic: typeof TEST_ALERT_TOPIC;
  test_alert_id: string;
  owner_name: string | null;
  occurred_at: string | null;
}

/** SCRUM-44/59 (D70): the outbox / push topic of a resident's status update. */
export const STATUS_UPDATE_TOPIC = 'incident.status_update';

/** SCRUM-44/59 (D70): the quick presets of a status update. */
export const STATUS_UPDATE_PRESETS = ['situation_worsening', 'help_is_here'] as const;
export type StatusUpdatePreset = (typeof STATUS_UPDATE_PRESETS)[number];

/**
 * The content of a status-update push (SCRUM-44/59, D70): the incident id, the resident's display
 * name, the time of the update, and either the preset or the free text (only for the visible body;
 * the text is never a data key).
 */
export interface StatusUpdatePushMessage {
  topic: typeof STATUS_UPDATE_TOPIC;
  incident_id: string;
  resident_name: string | null;
  occurred_at: string | null;
  preset: StatusUpdatePreset | null;
  text: string | null;
}

/** SCRUM-71 (D73): the outbox / push topic of the resident's "alert not delivered" notice. */
export const DELIVERY_FAILED_TOPIC = 'incident.delivery_failed';

/**
 * The content of the resident's "alert not delivered" push (SCRUM-71, D73): the incident id and the
 * display name of the member who did not receive the alert, plus the topic. Nothing else.
 */
export interface DeliveryFailedPushMessage {
  topic: typeof DELIVERY_FAILED_TOPIC;
  incident_id: string;
  member_name: string | null;
}

/** Any push the adapters send: an incident notice, a status update, a test alert or (D73) a notice. */
export type PushNotice =
  PushMessage | StatusUpdatePushMessage | TestAlertPushMessage | DeliveryFailedPushMessage;

/** True for the resident's "alert not delivered" notice (SCRUM-71, D73). */
export function isDeliveryFailedMessage(message: PushNotice): message is DeliveryFailedPushMessage {
  return message.topic === DELIVERY_FAILED_TOPIC && 'member_name' in message;
}

/** True for a resident's status update (SCRUM-44/59, D70). */
export function isStatusUpdateMessage(message: PushNotice): message is StatusUpdatePushMessage {
  return message.topic === STATUS_UPDATE_TOPIC && 'preset' in message;
}

/** True for a test alert (SCRUM-35). */
export function isTestAlertMessage(message: PushNotice): message is TestAlertPushMessage {
  return 'test_alert_id' in message;
}

export type PushProviderName = 'fcm' | 'apns';

export interface PushTarget {
  provider: PushProviderName;
  token: string;
  /**
   * The display time zone (D54, Stage 2 [TZ]: the receiving device's `time_zone`, else the
   * recipient's `profiles.timezone`): the time in the visible text is
   * shown in it. Never sent to the provider as a value of its own.
   */
  time_zone?: string | null;
  /**
   * Stage 2 [B7] (D77): the opaque signed token naming this push's delivery row; sent as the data key
   * `receipt_token` so the phone can confirm receipt. Never logged.
   */
  receipt_token?: string;
}

export interface PushSender {
  send(target: PushTarget, message: PushNotice): Promise<SendResult>;
}

/** SMS text to one E.164 number. */
export interface SmsSender {
  send(to: string, text: string): Promise<SendResult>;
}

export interface EmailSender {
  send(to: string, subject: string, text: string): Promise<SendResult>;
}
