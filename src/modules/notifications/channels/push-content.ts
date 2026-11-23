import type { PushMessage } from './channel.types';

/**
 * The push message of an outbox payload (API-100-46 AC3). Only the five allowed values are copied,
 * whatever else the payload holds, and only when they have the expected type.
 */
export function pushMessageOf(
  topic: string,
  payload: Record<string, unknown>,
): PushMessage | undefined {
  const text = (value: unknown): string | null =>
    typeof value === 'string' && value.length > 0 ? value : null;
  const incidentId = text(payload.incident_id);
  if (!incidentId) return undefined;
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
  message: PushMessage,
  timeZone?: string | null,
): { title: string; body: string } {
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

/** An emergency alert (created or sent again), as opposed to the closing notice (D55). */
export function isAlertTopic(topic: string): boolean {
  return topic !== 'incident.resolved';
}

/** D55: Android notification channel the app creates for every incident notice. */
export const ANDROID_CHANNEL_ID = 'atlas_emergency';
/** D55: an alert older than this is stale on the device (the app still lists it in Activity). */
export const ALERT_TTL_SECONDS = 60;
/** D55: the closing notice ("marked safe") may arrive later; it is not urgent. */
export const RESOLVED_TTL_SECONDS = 3600;

/** Seconds a notice of this topic stays deliverable (FCM `ttl`, APNs `apns-expiration`). */
export function pushTtlSeconds(topic: string): number {
  return isAlertTopic(topic) ? ALERT_TTL_SECONDS : RESOLVED_TTL_SECONDS;
}

/** Provider data keys (FCM data and APNs custom keys are strings). */
export function pushData(message: PushMessage): Record<string, string> {
  return {
    topic: message.topic,
    incident_id: message.incident_id,
    emergency_type: message.emergency_type ?? '',
    resident_name: message.resident_name ?? '',
    occurred_at: message.occurred_at ?? '',
  };
}
