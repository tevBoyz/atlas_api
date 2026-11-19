import { z } from 'zod';

import { componentSchema } from '../../openapi/component-schema';
import {
  emergencyTypeSchema,
  incidentStatusSchema,
  locationSourceSchema,
} from '../../openapi/schemas';

/** The types a resident can submit (spec §5.2). `unspecified` exists on legacy rows only. */
export const SUBMITTABLE_EMERGENCY_TYPES = [
  'medical',
  'domestic_violence',
  'fire',
  'burglary',
  'other',
] as const;

export type SubmittableEmergencyType = (typeof SUBMITTABLE_EMERGENCY_TYPES)[number];

/** Exact match only, like the SQL `not in (...)`: no trimming and no case folding. */
export const submitEmergencyAlertRequestSchema = z.object({
  emergency_type: z.enum(SUBMITTABLE_EMERGENCY_TYPES),
});

export const SUBMIT_OUTCOMES = ['created', 'promoted', 'renotified'] as const;

export type SubmitOutcome = (typeof SUBMIT_OUTCOMES)[number];

/**
 * IncidentShared (spec §7.0, `_incident_activation_json`): exactly 22 keys. The body of attach
 * location and set notes. A float stored from a PostgREST-style text value (`"NaN"`, `"Infinity"`)
 * comes back as that JSON string, as the SQL function returns it.
 */
export const incidentSharedSchema = componentSchema(
  'IncidentShared',
  z.object({
    id: z.uuid(),
    resident_id: z.uuid(),
    circle_id: z.uuid().nullable(),
    status: incidentStatusSchema,
    activated_at: z.string(),
    emergency_type: emergencyTypeSchema,
    location_lat: z.number().nullable(),
    location_lng: z.number().nullable(),
    location_accuracy_m: z.number().nullable(),
    location_captured_at: z.string().nullable(),
    location_source: locationSourceSchema.nullable(),
    cancelled_at: z.string().nullable(),
    sent_at: z.string().nullable(),
    share_payload: z.record(z.string(), z.string()).nullable(),
    incident_notes: z.string().nullable(),
    incident_notes_updated_at: z.string().nullable(),
    renotified_at: z.string().nullable(),
    resolved_at: z.string().nullable(),
    resolved_reason: z.string().nullable(),
    auto_closed: z.boolean(),
    activity_confirmed_at: z.string().nullable(),
    location_sharing_ended_at: z.string().nullable(),
  }),
);

/** IncidentSend (spec §7.0): IncidentShared plus the delivery counts. Submit and the open read. */
export const incidentSendSchema = componentSchema(
  'IncidentSend',
  incidentSharedSchema.extend({
    delivered_count: z.number().int(),
    acknowledged_count: z.number().int(),
  }),
);

/**
 * `{id}` of the incident routes (documentation). The route accepts what Postgres accepts as uuid input
 * (any case, with or without hyphens, optionally in braces); anything else is 422
 * `validation:invalid_request` on field `id`.
 */
export const incidentIdParamsSchema = z.object({
  id: z.guid().describe('The incident id.'),
});

/** Spec rule 37: at most 250 characters (Unicode code points) after trimming spaces. */
export const INCIDENT_NOTES_MAX_LENGTH = 250;

/**
 * `PUT /v1/incidents/{id}/notes` (documentation; the route validates as described in
 * `IncidentsController.setNotes`). `incident_notes`: a string or null; missing means null (clear).
 */
export const setIncidentNotesRequestSchema = z.object({
  incident_notes: z
    .string()
    .nullable()
    .optional()
    .describe(
      `Trimmed of spaces; empty or only spaces clears the note (null). At most ${INCIDENT_NOTES_MAX_LENGTH} characters after trimming, else 422 set_incident_notes:too_long.`,
    ),
});

/** The body of `POST /v1/incidents`: IncidentSend plus `submit_outcome`. */
export const incidentSubmitResultSchema = incidentSendSchema.extend({
  submit_outcome: z.enum(SUBMIT_OUTCOMES),
});

/**
 * The body of `GET /v1/me/incidents/open` (epic §18 D2): always this wrapper, `null` when the caller
 * has no active incident. `get_my_open_incident` itself returned IncidentSend or bare JSON `null`.
 */
export const openIncidentResultSchema = z.object({
  open_incident: incidentSendSchema.nullable(),
});

/** One entry of `list_my_recent_incidents`: exactly these 7 keys. */
export const recentIncidentSchema = componentSchema(
  'RecentIncident',
  z.object({
    id: z.uuid(),
    emergency_type: emergencyTypeSchema,
    status: incidentStatusSchema,
    activated_at: z.string(),
    sent_at: z.string().nullable(),
    resolved_at: z.string().nullable(),
    resolved_reason: z.string().nullable(),
  }),
);

export const recentIncidentListSchema = z.array(recentIncidentSchema);

/** `list_my_recent_incidents(p_limit integer default 5)`: null → 5, then clamped to 1–20. */
export const RECENT_INCIDENTS_DEFAULT_LIMIT = 5;
export const RECENT_INCIDENTS_MIN_LIMIT = 1;
export const RECENT_INCIDENTS_MAX_LIMIT = 20;

/** `least(greatest(coalesce(p_limit, 5), 1), 20)`. */
export function clampRecentIncidentsLimit(limit: number | undefined): number {
  return Math.min(
    Math.max(limit ?? RECENT_INCIDENTS_DEFAULT_LIMIT, RECENT_INCIDENTS_MIN_LIMIT),
    RECENT_INCIDENTS_MAX_LIMIT,
  );
}

const INT4_MIN = -2_147_483_648;
const INT4_MAX = 2_147_483_647;
/** A base-10 integer with an optional sign: what a client sends for an `integer` parameter. */
const DECIMAL_INTEGER = /^[+-]?\d+$/;

/**
 * `?limit=`. The SQL parameter is a Postgres `integer`, so any value Postgres would refuse as one
 * (letters, decimals, empty, out of int4 range) is 422 `validation:invalid_request` with
 * `details.field = "limit"`, never silently defaulted. Any integer, including 0 and negatives, is
 * accepted and clamped like the SQL. Missing → 5 (a query string cannot carry JSON `null`).
 */
export const recentIncidentsQuerySchema = z.object({
  limit: z
    .preprocess(
      (value) => (typeof value === 'string' && DECIMAL_INTEGER.test(value) ? Number(value) : value),
      z.int().min(INT4_MIN).max(INT4_MAX),
    )
    .optional()
    .describe(
      `How many incidents to return. Default ${RECENT_INCIDENTS_DEFAULT_LIMIT}; any integer is clamped to ${RECENT_INCIDENTS_MIN_LIMIT}-${RECENT_INCIDENTS_MAX_LIMIT}.`,
    ),
});
