import { type SQL, sql } from 'drizzle-orm';

/**
 * The share payload of the profile aliased `p` (spec rules 31-32, `_incident_share_payload`), with
 * SCRUM-21 (D52): `allergies` and `medical_conditions` are ARRAYS of strings, the item texts of
 * `profile_allergies` / `profile_medical_conditions` oldest first (`created_at`, then `id`), present
 * only when the list's share flag is on and the list is not empty. A profile with no item but a
 * non-blank old text column (written outside the API, e.g. by a test fixture or the retired SQL
 * paths) counts as ONE item, the trimmed text, as the 0014 back-fill does. Every other key is the
 * trimmed text as before; blank and unshared values are left out (`jsonb_strip_nulls`); `{}` when
 * nothing is shared.
 *
 * Built in SQL on purpose: `btrim` removes spaces only (a tab-only value is kept), which
 * `String.prototype.trim` would not match. Used for the activation snapshot (`share_payload`, at
 * submit) and for the live view (`live_share_payload`, D53).
 */
function sharedList(flag: string, table: string, column: string): SQL {
  return sql.raw(`case when p.${flag} then coalesce(
          (select jsonb_agg(item.text order by item.created_at, item.id)
             from public.${table} item
            where item.user_id = p.id),
          case when nullif(btrim(p.${column}), '') is not null
               then jsonb_build_array(btrim(p.${column})) end
        ) end`);
}

export const SHARE_PAYLOAD_SQL = sql`coalesce(
  jsonb_strip_nulls(
    jsonb_build_object(
      'emergency_contact_full_name',
        to_jsonb(case when p.share_emergency_contact_full_name
             then nullif(btrim(p.emergency_contact_full_name), '') end),
      'emergency_contact_relationship',
        to_jsonb(case when p.share_emergency_contact_relationship
             then nullif(btrim(p.emergency_contact_relationship), '') end),
      'emergency_contact_phone',
        to_jsonb(case when p.share_emergency_contact_phone
             then nullif(btrim(p.emergency_contact_phone), '') end),
      'emergency_contact_email',
        to_jsonb(case when p.share_emergency_contact_email
             then nullif(btrim(p.emergency_contact_email), '') end),
      'blood_type',
        to_jsonb(case when p.share_blood_type then nullif(btrim(p.blood_type), '') end),
      'allergies',
        ${sharedList('share_allergies', 'profile_allergies', 'allergies')},
      'medical_conditions',
        ${sharedList('share_medical_conditions', 'profile_medical_conditions', 'medical_conditions')},
      'emergency_preferred_language',
        to_jsonb(case when p.share_emergency_preferred_language
             then nullif(btrim(p.emergency_preferred_language), '') end),
      'emergency_notes',
        to_jsonb(case when p.emergency_notes_shareable then nullif(btrim(p.emergency_notes), '') end)
    )
  ),
  '{}'::jsonb
)`;
