/**
 * SCRUM-21 deliberate divergence from the SQL functions (D52, D53), for the tests that compare an API
 * answer or row with what the SQL functions produce:
 * - in a share payload written by the API, `allergies` / `medical_conditions` are arrays of strings
 *   (the SQL functions write one string);
 * - member incident details (`GET /v1/incidents/{id}`) carry `share_payload_at_activation` and
 *   `share_payload_updated_at` besides the SQL keys;
 * - SCRUM-54 (D60): the member read and the resident's live reads carry `emergency_services`
 *   (removed here after checking it is the seeded list).
 * - SCRUM-63 (D61): the open read, the recent list and the member reads carry `closed_at` (removed
 *   here when present, after checking it is null: the SQL functions know no closed incident).
 * - SCRUM-68 (D74): every incident body with the location keys (IncidentShared / IncidentSend and the
 *   reads built on them, the member details, realtime) carries `location_unavailable_since` (removed
 *   here when present, after checking it is null: the SQL functions wipe the fix instead).
 *
 * {@link asSqlSharePayloadShape} returns a deep copy with every such array joined with ", " (what the
 * old text column holds, and the one-item case equals the SQL string) and the two keys removed, after
 * checking that, with no live change, `share_payload_at_activation` equals `share_payload` and
 * `share_payload_updated_at` is null. Everything else must still match the SQL exactly.
 */
const LIST_KEYS = ['allergies', 'medical_conditions'];

function joinLists(payload: Record<string, unknown>): Record<string, unknown> {
  const out = { ...payload };
  for (const key of LIST_KEYS) {
    if (Array.isArray(out[key])) out[key] = (out[key] as unknown[]).join(', ');
  }
  return out;
}

export function asSqlSharePayloadShape<T>(value: T): T {
  if (Array.isArray(value)) {
    return (value as unknown[]).map((item) => asSqlSharePayloadShape(item)) as T;
  }
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  const input = value as Record<string, unknown>;
  if ('share_payload_at_activation' in input) {
    if (
      JSON.stringify(input.share_payload_at_activation) !== JSON.stringify(input.share_payload) ||
      input.share_payload_updated_at !== null
    ) {
      throw new Error('a live share payload (D53) differs from the activation snapshot');
    }
  }
  for (const [key, entry] of Object.entries(input)) {
    if (key === 'share_payload_at_activation' || key === 'share_payload_updated_at') continue;
    if (key === 'closed_at') {
      // SCRUM-63 (D61): not in the SQL shapes; null until the incident is closed.
      if (entry !== null) throw new Error('closed_at (D61) is set on a compared body');
      continue;
    }
    if (key === 'location_unavailable_since') {
      // SCRUM-68 (D74): not in the SQL shapes; null while no unavailable report is pending.
      if (entry !== null)
        throw new Error('location_unavailable_since (D74) is set on a compared body');
      continue;
    }
    if (key === 'emergency_services') {
      // SCRUM-54 (D60): not in the SQL shapes; must be the seeded numbers.
      if (JSON.stringify(entry) !== JSON.stringify(GM_EMERGENCY_SERVICES)) {
        throw new Error('emergency_services (D60) is not the seeded list');
      }
      continue;
    }
    if (
      (key === 'share_payload' || key === 'live_share_payload') &&
      entry &&
      typeof entry === 'object'
    ) {
      out[key] = joinLists(entry as Record<string, unknown>);
      continue;
    }
    out[key] = asSqlSharePayloadShape(entry);
  }
  return out as T;
}

/**
 * SCRUM-54 (D60) deliberate divergence: the resident's submit, open read and re-notify, and the
 * member read, add `emergency_services` (the seeded Gambia numbers, fixed order) after the SQL keys.
 */
export const GM_EMERGENCY_SERVICES = [
  { service: 'ambulance', label: 'Ambulance', number: '116' },
  { service: 'police', label: 'Police', number: '117' },
  { service: 'fire_rescue', label: 'Fire and Rescue', number: '119' },
];

const EMERGENCY_SERVICES_SUFFIX = `,"emergency_services":${JSON.stringify(GM_EMERGENCY_SERVICES)}`;

/**
 * A response body text without the `emergency_services` key the API appends last (D60), so the rest
 * can be compared byte for byte with the SQL function's JSON. Throws when the key is not there.
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
