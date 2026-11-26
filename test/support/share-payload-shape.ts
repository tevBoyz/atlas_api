/**
 * Helpers that set aside keys a test does not compare (all API answers):
 * - SCRUM-54 (D60): the member read and the resident's live reads carry `emergency_services`
 *   (removed here after checking it is the seeded list).
 * - SCRUM-63 (D61): the open read, the recent list and the member reads carry `closed_at` (removed
 *   here when present, after checking it is null).
 * - SCRUM-68 (D74): every incident body with the location keys carries `location_unavailable_since`
 *   (removed here when present, after checking it is null).
 */

/**
 * SCRUM-54 (D60): the resident's submit, open read and re-notify, and the member read, add
 * `emergency_services` (the seeded Gambia numbers, fixed order) last.
 */
export const GM_EMERGENCY_SERVICES = [
  { service: 'ambulance', label: 'Ambulance', number: '116' },
  { service: 'police', label: 'Police', number: '117' },
  { service: 'fire_rescue', label: 'Fire and Rescue', number: '119' },
];

const EMERGENCY_SERVICES_SUFFIX = `,"emergency_services":${JSON.stringify(GM_EMERGENCY_SERVICES)}`;

/**
 * A response body text without the `emergency_services` key the API appends last (D60), , so the rest
 * can be compared byte for byte with another body. Throws when the key is not there.
 */
export function withoutEmergencyServicesText(text: string): string {
  if (!text.includes(EMERGENCY_SERVICES_SUFFIX)) {
    throw new Error('emergency_services (D60, the seeded numbers) is missing from the body');
  }
  return withoutClosedAtText(text.replace(EMERGENCY_SERVICES_SUFFIX, ''));
}

/**
 * SCRUM-63 (D61) deliberate divergence: the open read (`GET /v1/me/incidents/open`) carries
 * `closed_at` (always null there: only an active incident is open), and so do the recent list and
 * the member reads; the SQL shapes do not have it. The body text without every `"closed_at":null`
 * (and, D74, every `"location_unavailable_since":null`), so the rest compares byte for byte. A body without the key is returned unchanged; a set value
 * throws.
 */
export function withoutClosedAtText(text: string): string {
  if (/"closed_at":(?!null)/.test(text)) {
    throw new Error('closed_at (D61) is set on a compared body');
  }
  return withoutUnavailableSinceText(text.replace(/"closed_at":null,|,"closed_at":null/g, ''));
}

/**
 * SCRUM-68 (D74) deliberate divergence: every incident body with the location keys carries
 * `location_unavailable_since`; the SQL shapes do not (an unavailable report wipes the fix there).
 * The body text without every `"location_unavailable_since":null`, so the rest compares byte for
 * byte. A body without the key is returned unchanged; a set value throws.
 */
export function withoutUnavailableSinceText(text: string): string {
  if (/"location_unavailable_since":(?!null)/.test(text)) {
    throw new Error('location_unavailable_since (D74) is set on a compared body');
  }
  return text.replace(/"location_unavailable_since":null,|,"location_unavailable_since":null/g, '');
}

/** A body without `location_unavailable_since` (D74) when it has it, after checking it is null. */
export function withoutUnavailableSince<T extends Record<string, unknown>>(body: T): T {
  if (!('location_unavailable_since' in body)) return body;
  if (body.location_unavailable_since !== null) {
    throw new Error('location_unavailable_since (D74) is set on a compared body');
  }
  const rest: Record<string, unknown> = { ...body };
  delete rest.location_unavailable_since;
  return rest as T;
}

/**
 * A body without `closed_at` (D61) and `location_unavailable_since` (D74) when it has them, after
 * checking they are null.
 */
export function withoutClosedAt<T extends Record<string, unknown>>(body: T): T {
  if (!('closed_at' in body)) return withoutUnavailableSince(body);
  if (body.closed_at !== null) throw new Error('closed_at (D61) is set on a compared body');
  const rest: Record<string, unknown> = { ...body };
  delete rest.closed_at;
  return withoutUnavailableSince(rest) as T;
}

/** A body without `emergency_services`, after checking it holds the seeded numbers (D60). */
export function withoutEmergencyServices<T extends Record<string, unknown>>(body: T): T {
  if (JSON.stringify(body.emergency_services) !== JSON.stringify(GM_EMERGENCY_SERVICES)) {
    throw new Error('emergency_services (D60) is not the seeded list');
  }
  const rest: Record<string, unknown> = { ...body };
  delete rest.emergency_services;
  return withoutClosedAt(rest) as T;
}
