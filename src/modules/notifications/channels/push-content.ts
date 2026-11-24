import {
  isStatusUpdateMessage,
  isTestAlertMessage,
  type PushMessage,
  type PushNotice,
  STATUS_UPDATE_PRESETS,
  STATUS_UPDATE_TOPIC,
  type StatusUpdatePreset,
  type StatusUpdatePushMessage,
  TEST_ALERT_TOPIC,
  type TestAlertPushMessage,
} from './channel.types';

/**
 * The push message of an outbox payload (API-100-46 AC3). Only the allowed values are copied,
 * whatever else the payload holds, and only when they have the expected type: for an incident the
 * five incident values; for a status update (SCRUM-44/59, D70) the incident id, the resident's name,
 * the time and the preset or the text; for a test alert (SCRUM-35, D67) the test alert id, the
 * owner's name and the time.
 */
export function pushMessageOf(
  topic: string,
  payload: Record<string, unknown>,
): PushNotice | undefined {
  const text = (value: unknown): string | null =>
    typeof value === 'string' && value.length > 0 ? value : null;
  if (topic === TEST_ALERT_TOPIC) {
    const testAlertId = text(payload.test_alert_id);
    if (!testAlertId) return undefined;
    return {
      topic: TEST_ALERT_TOPIC,
      test_alert_id: testAlertId,
      owner_name: text(payload.owner_name),
      occurred_at: text(payload.occurred_at),
    };
  }
  const incidentId = text(payload.incident_id);
  if (!incidentId) return undefined;
  if (topic === STATUS_UPDATE_TOPIC) {
    // D70: exactly one of a known preset or the free text.
    const preset = (STATUS_UPDATE_PRESETS as readonly unknown[]).includes(payload.preset)
      ? (payload.preset as StatusUpdatePreset)
      : null;
    const updateText = preset ? null : text(payload.text);
    if (!preset && !updateText) return undefined;
    return {
      topic: STATUS_UPDATE_TOPIC,
      incident_id: incidentId,
      resident_name: text(payload.resident_name),
      occurred_at: text(payload.occurred_at),
      preset,
      text: updateText,
    };
  }
  return {
    topic,
    incident_id: incidentId,
    emergency_type: text(payload.emergency_type),
    resident_name: text(payload.resident_name),
    occurred_at: text(payload.occurred_at),
  };
}

/** Spec §5.2 emergency types (`unspecified` on legacy rows only). */
const TYPE_LABELS: Readonly<Record<string, string>> = {
  medical: 'Medical',
  domestic_violence: 'Domestic violence',
  fire: 'Fire',
  burglary: 'Burglary',
  other: 'Other',
  unspecified: 'Emergency',
};

/** The display time zone when the recipient has none or it is not a valid IANA zone (spec §4.1). */
export const DEFAULT_TIME_ZONE = 'Africa/Banjul';

/**
 * D54: the time of the event (`occurred_at`: activation, re-notify or mark safe) as `HH:mm`,
 * 24-hour, in the recipient's time zone (`profiles.timezone`; {@link DEFAULT_TIME_ZONE} when
 * missing or unknown). `null` when the payload has no valid time.
 */
export function pushTime(occurredAt: string | null, timeZone?: string | null): string | null {
  if (!occurredAt) return null;
  const at = Date.parse(occurredAt);
  if (Number.isNaN(at)) return null;
  const format = (zone: string) =>
    new Intl.DateTimeFormat('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone: zone,
    }).format(at);
  try {
    return format(timeZone || DEFAULT_TIME_ZONE);
  } catch {
    return format(DEFAULT_TIME_ZONE);
  }
}

/**
 * The visible title and body (English; the app may show its own text from the data keys). Built
 * from the allowed values only; the body ends with the time of the event in the recipient's time
 * zone (D54), e.g. `Emergency alert: Medical · 16:48`.
 */
export function pushText(
  message: PushNotice,
  timeZone?: string | null,
): { title: string; body: string } {
  if (isTestAlertMessage(message)) return testAlertText(message, timeZone);
  if (isStatusUpdateMessage(message)) return statusUpdateText(message, timeZone);
  const title = message.resident_name ?? 'Atlas';
  const type = message.emergency_type
    ? (TYPE_LABELS[message.emergency_type] ?? 'Emergency')
    : 'Emergency';
  let body: string;
  switch (message.topic) {
    case 'incident.resolved':
      body = 'Marked safe. The alert is closed.';
      break;
    case 'incident.renotified':
      body = `Alert sent again: ${type}`;
      break;
    default:
      body = `Emergency alert: ${type}`;
  }
  const time = pushTime(message.occurred_at, timeZone);
  return { title, body: time ? `${body} · ${time}` : body };
}

/** SCRUM-44/59 (D70): the visible text of each preset. */
export const STATUS_UPDATE_PRESET_TEXT: Readonly<Record<StatusUpdatePreset, string>> = {
  situation_worsening: 'Situation worsening',
  help_is_here: 'Help is here',
};

/** SCRUM-44/59 (D70): the free text of a status update is shortened to this many characters. */
export const STATUS_UPDATE_PUSH_TEXT_MAX = 100;

/**
 * D70: the free text as one line (every run of white space becomes one space), at most
 * {@link STATUS_UPDATE_PUSH_TEXT_MAX} characters (Unicode code points): a longer text keeps its first
 * 99 characters (trailing space removed) and ends with `…`.
 */
export function shortenUpdateText(value: string): string {
  const line = value.replace(/\s+/g, ' ').trim();
  const chars = [...line];
  if (chars.length <= STATUS_UPDATE_PUSH_TEXT_MAX) return line;
  return `${chars
    .slice(0, STATUS_UPDATE_PUSH_TEXT_MAX - 1)
    .join('')
    .trimEnd()}…`;
}

/**
 * SCRUM-44/59 (D70): title = the resident's display name (`Atlas` when blank, as D54); body =
 * `Situation worsening · 16:48`, `Help is here · 16:48` or the free text shortened plus the time of
 * the update in the recipient's time zone (D54).
 */
function statusUpdateText(
  message: StatusUpdatePushMessage,
  timeZone?: string | null,
): { title: string; body: string } {
  const body = message.preset
    ? STATUS_UPDATE_PRESET_TEXT[message.preset]
    : shortenUpdateText(message.text ?? '');
  const time = pushTime(message.occurred_at, timeZone);
  return { title: message.resident_name ?? 'Atlas', body: time ? `${body} · ${time}` : body };
}

/** SCRUM-35 (D67): the title of every test-alert notice. */
export const TEST_ALERT_TITLE = 'TEST ALERT — NOT AN EMERGENCY';
/** SCRUM-35 (D67): the owner name in the body when the owner's profile name is blank. */
export const TEST_ALERT_FALLBACK_OWNER = 'Your Safety Circle owner';

/**
 * SCRUM-35 (D67): `TEST ALERT — NOT AN EMERGENCY` / `<Owner name> is testing their Safety Circle ·
 * HH:mm` (the send time in the recipient's time zone, as D54).
 */
function testAlertText(
  message: TestAlertPushMessage,
  timeZone?: string | null,
): { title: string; body: string } {
  const body = `${message.owner_name ?? TEST_ALERT_FALLBACK_OWNER} is testing their Safety Circle`;
  const time = pushTime(message.occurred_at, timeZone);
  return { title: TEST_ALERT_TITLE, body: time ? `${body} · ${time}` : body };
}

/**
 * An emergency alert (created or sent again) or a resident's status update during the alert (D70:
 * the same urgency, channel and TTL as an alert), as opposed to the closing notice (D55) and the
 * test alert (D67).
 */
export function isAlertTopic(topic: string): boolean {
  return topic !== 'incident.resolved' && topic !== TEST_ALERT_TOPIC;
}

/** D55: Android notification channel the app creates for every incident notice. */
export const ANDROID_CHANNEL_ID = 'atlas_emergency';
/**
 * D67: Android notification channel the app creates for test alerts: separate from
 * `atlas_emergency`, default importance, no Do Not Disturb bypass.
 */
export const ANDROID_TEST_CHANNEL_ID = 'atlas_test';

/** The Android channel of a notice of this topic. */
export function androidChannelId(topic: string): string {
  return topic === TEST_ALERT_TOPIC ? ANDROID_TEST_CHANNEL_ID : ANDROID_CHANNEL_ID;
}
/** D55: an alert older than this is stale on the device (the app still lists it in Activity). */
export const ALERT_TTL_SECONDS = 60;
/** D55: the closing notice ("marked safe") may arrive later; it is not urgent. */
export const RESOLVED_TTL_SECONDS = 3600;
/** D67: a test alert is not urgent either; it stays deliverable an hour. */
export const TEST_ALERT_TTL_SECONDS = 3600;

/** Seconds a notice of this topic stays deliverable (FCM `ttl`, APNs `apns-expiration`). */
export function pushTtlSeconds(topic: string): number {
  if (topic === TEST_ALERT_TOPIC) return TEST_ALERT_TTL_SECONDS;
  return isAlertTopic(topic) ? ALERT_TTL_SECONDS : RESOLVED_TTL_SECONDS;
}

/**
 * Provider data keys (FCM data and APNs custom keys are strings). Incident notices: the five keys
 * (D54). Status updates (D70): exactly `topic` and `incident_id`. Test alerts (D67): exactly
 * `topic`, `test_alert_id` and `owner_name`.
 */
export function pushData(message: PushNotice): Record<string, string> {
  if (isTestAlertMessage(message)) {
    return {
      topic: message.topic,
      test_alert_id: message.test_alert_id,
      owner_name: message.owner_name ?? '',
    };
  }
  // D70: exactly `topic` and `incident_id` (a tap opens the incident); never the text.
  if (isStatusUpdateMessage(message)) {
    return { topic: message.topic, incident_id: message.incident_id };
  }
  return incidentData(message);
}

function incidentData(message: PushMessage): Record<string, string> {
  return {
    topic: message.topic,
    incident_id: message.incident_id,
    emergency_type: message.emergency_type ?? '',
    resident_name: message.resident_name ?? '',
    occurred_at: message.occurred_at ?? '',
  };
}
