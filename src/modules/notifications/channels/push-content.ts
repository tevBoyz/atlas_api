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

/**
 * The visible title and body (English; the app may show its own text from the data keys). Built
 * from the allowed values only.
 */
export function pushText(message: PushMessage): { title: string; body: string } {
  const title = message.resident_name ?? 'Atlas';
  const type = message.emergency_type
    ? (TYPE_LABELS[message.emergency_type] ?? 'Emergency')
    : 'Emergency';
  switch (message.topic) {
    case 'incident.resolved':
      return { title, body: 'Marked safe. The alert is closed.' };
    case 'incident.renotified':
      return { title, body: `Alert sent again: ${type}` };
    default:
      return { title, body: `Emergency alert: ${type}` };
  }
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
