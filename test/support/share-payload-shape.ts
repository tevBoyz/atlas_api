/**
 * SCRUM-21 deliberate divergence from the SQL functions (D52, D53), for the tests that compare an API
 * answer or row with what the SQL functions produce:
 * - in a share payload written by the API, `allergies` / `medical_conditions` are arrays of strings
 *   (the SQL functions write one string);
 * - member incident details (`GET /v1/incidents/{id}`) carry `share_payload_at_activation` and
 *   `share_payload_updated_at` besides the SQL keys.
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
