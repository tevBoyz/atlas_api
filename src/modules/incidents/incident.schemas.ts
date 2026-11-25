import { z } from 'zod';

import { componentSchema } from '../../openapi/component-schema';
import { emergencyServicesSchema } from '../config/emergency-numbers.schemas';
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

/**
 * A share payload (spec §6.5): what the resident chose to share, by field. Every value is a string,
 * except `allergies` and `medical_conditions`, which are arrays of strings in payloads written since
 * SCRUM-21 (D52) and a single string in older incidents: clients accept both.
 */
const sharePayloadSchema = () =>
  z
    .record(z.string(), z.unknown())
    .describe(
      "Shared fields by key. Values are strings, except `allergies` / `medical_conditions`: arrays of strings since SCRUM-21 (D52), a single string in older incidents. `resident_phone` (SCRUM-52, D59): the resident's confirmed phone (E.164) when they share it; absent otherwise (show Call only when present). Keys not shared are left out.",
    );

export const SUBMIT_OUTCOMES = ['created', 'promoted', 'renotified'] as const;

export type SubmitOutcome = (typeof SUBMIT_OUTCOMES)[number];

/**
 * SCRUM-68 (D74): since when live location is reported unavailable. An `unavailable` report keeps the
 * last fix in the five location keys.
 */
const locationUnavailableSinceSchema = z
  .string()
  .nullable()
  .describe(
    'SCRUM-68 (D74): since when the phone of the resident reports live location unavailable; null = live location is not reported unavailable. The location keys keep the last known fix (location_captured_at = when it was taken), so show it labelled "Last known · N min ago" with "Location unavailable". With no fix ever stored, location_source is unavailable and the position keys are null. The next fix clears it.',
  );

/**
 * IncidentShared (spec §7.0, `_incident_activation_json`): 22 keys plus `location_unavailable_since`
 * (SCRUM-68, D74). The body of attach location and set notes. A float stored from a PostgREST-style text value (`"NaN"`, `"Infinity"`)
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
    location_unavailable_since: locationUnavailableSinceSchema,
    cancelled_at: z.string().nullable(),
    sent_at: z.string().nullable(),
    share_payload: sharePayloadSchema().nullable(),
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

/** `closed_at` of the resident's live bodies (SCRUM-63, D61). */
const liveClosedAtSchema = z
  .string()
  .nullable()
  .describe(
    'SCRUM-63 (D61): when the incident became Closed; always null on the live bodies (only an active incident is open, re-notified or submitted; resolved and closed incidents never block a new SOS).',
  );

/**
 * IncidentLive: IncidentSend plus `emergency_services` (SCRUM-54, D60) and `closed_at` (SCRUM-63,
 * D61), what the resident's live alert screen reads: the open read and re-notify. Mark safe keeps
 * IncidentSend.
 */
export const incidentLiveSchema = componentSchema(
  'IncidentLive',
  incidentSendSchema.extend({
    emergency_services: emergencyServicesSchema,
    closed_at: liveClosedAtSchema,
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

/**
 * The body of `POST /v1/incidents`: IncidentSend plus `submit_outcome`, `emergency_services`
 * (SCRUM-54, D60) and `closed_at` (SCRUM-63, D61).
 */
export const incidentSubmitResultSchema = incidentSendSchema.extend({
  submit_outcome: z.enum(SUBMIT_OUTCOMES),
  emergency_services: emergencyServicesSchema,
  closed_at: liveClosedAtSchema,
});

/**
 * The body of `GET /v1/me/incidents/open` (epic §18 D2): always this wrapper, `null` when the caller
 * has no active incident. `get_my_open_incident` itself returned IncidentSend or bare JSON `null`.
 */
export const openIncidentResultSchema = z.object({
  open_incident: incidentLiveSchema.nullable(),
});

/**
 * One entry of `list_my_recent_incidents`: its 7 keys plus `auto_closed` and `closed_at` (SCRUM-63,
 * D61). Since SCRUM-63 the list also holds closed incidents.
 */
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
    auto_closed: z.boolean(),
    closed_at: z
      .string()
      .nullable()
      .describe(
        'SCRUM-63 (D61): when the incident became Closed (final, read-only); null until then. With status closed: resolved_reason safe = closed after the wrap-up following mark safe; ended with auto_closed true = closed automatically after inactivity.',
      ),
  }),
);

export const recentIncidentListSchema = z.array(recentIncidentSchema);

/**
 * DeliveryCounts (spec §7.4, `_incident_delivery_counts_json`): exactly 4 keys. The body of
 * `GET /v1/incidents/{id}/delivery-counts` and `POST /v1/incidents/{id}/acknowledge`.
 */
export const deliveryCountsSchema = componentSchema(
  'DeliveryCounts',
  z.object({
    incident_id: z.uuid(),
    delivered_count: z.number().int(),
    acknowledged_count: z.number().int(),
    status: incidentStatusSchema,
  }),
);

/**
 * One entry of `list_responder_incidents` (spec §7.4): its 10 keys plus `closed_at` (SCRUM-63, D61;
 * closed incidents stay listed). Never `resident_id`,
 * `circle_id` or profile data beyond `resident_name` (API-100-21 AC3).
 */
export const responderIncidentSchema = componentSchema(
  'ResponderIncident',
  z.object({
    id: z.uuid(),
    resident_name: z.string().describe("The resident's full name; empty string when unknown."),
    emergency_type: emergencyTypeSchema,
    activated_at: z.string(),
    status: incidentStatusSchema,
    sent_at: z.string().nullable(),
    renotified_at: z.string().nullable(),
    resolved_at: z.string().nullable(),
    resolved_reason: z.string().nullable(),
    auto_closed: z.boolean(),
    closed_at: z
      .string()
      .nullable()
      .describe(
        'SCRUM-63 (D61): when the incident became Closed (final, read-only); null until then. With status closed: resolved_reason safe = closed after the wrap-up following mark safe; ended with auto_closed true = closed automatically after inactivity.',
      ),
  }),
);

export const responderIncidentListSchema = z.array(responderIncidentSchema);

/**
 * IncidentDetails (spec §7.4, `get_incident_details`): the 19 keys of the SQL function plus
 * `share_payload_at_activation` and `share_payload_updated_at` (SCRUM-21, D53) and
 * `emergency_services` (SCRUM-54, D60), `location_unavailable_since` (SCRUM-68, D74). `share_payload` is the
 * live shared info (else the activation snapshot), `{}` when none. Never `resident_id` or `circle_id` (API-100-21 AC3).
 */
export const incidentDetailsSchema = componentSchema(
  'IncidentDetails',
  responderIncidentSchema.extend({
    location_lat: z.number().nullable(),
    location_lng: z.number().nullable(),
    location_accuracy_m: z.number().nullable(),
    location_captured_at: z.string().nullable(),
    location_source: locationSourceSchema.nullable(),
    location_unavailable_since: locationUnavailableSinceSchema,
    location_sharing_ended_at: z.string().nullable(),
    incident_notes: z.string().nullable(),
    incident_notes_updated_at: z.string().nullable(),
    share_payload: sharePayloadSchema().describe(
      'The LIVE shared info (SCRUM-21, D53): the latest shared fields when they changed them during the incident, else the activation snapshot; `{}` when none. Allergies / conditions: arrays of strings (a single string in older incidents).',
    ),
    share_payload_at_activation: sharePayloadSchema().describe(
      'What was shared at activation (what the alerts carried); never changes. `{}` when none.',
    ),
    share_payload_updated_at: z
      .string()
      .nullable()
      .describe(
        'When the resident last changed the shared info during the incident; null = unchanged since activation.',
      ),
    emergency_services: emergencyServicesSchema,
  }),
);

/**
 * One entry of `GET /v1/incidents/{id}/events` (spec §4.7, §11.3 E11). `detail` per spec §5.6; for a
 * caller who is not the resident, `recipient_ids` is left out (epic §18 D3) and `actor_id` is
 * obscured (epic §18 D11, `maskActorId`).
 */
export const incidentEventSchema = componentSchema(
  'IncidentEvent',
  z.object({
    id: z.uuid(),
    event_type: z
      .string()
      .describe(
        'See spec §5.6: alert_sent, renotified, location_sharing_started, location_sharing_ended, ' +
          'safe_recorded, incident_closed, closure_notified, status_update (D70: detail {preset} or ' +
          '{text}), responder_acknowledged (D71: a member acknowledged, detail {}) and ' +
          'responder_status (D71: a member changed their response, detail {status: "responding" | ' +
          '"unable"}).',
      ),
    occurred_at: z.string(),
    actor_id: z
      .string()
      .nullable()
      .describe(
        'Who caused the event (null when no user did). The resident of the incident gets the full ' +
          'UUID. Any other caller gets it obscured: the first 4 and the last 4 hex characters are ' +
          'kept, every other hex character is replaced by "*", and the hyphens and 36-character ' +
          'shape stay (e.g. "4f3a****-****-****-****-********9c2d"), unless the actor is the ' +
          'caller, whose own id is always shown in full. Not a usable UUID when obscured.',
      ),
    actor_name: z
      .string()
      .nullable()
      .describe(
        'D71: the display name of the actor, the same for every caller (show it instead of any ' +
          'id); null when actor_id is null. A member: their profile name (trimmed), else the name ' +
          'on their membership, as the responder list. The resident: their profile name (trimmed). ' +
          'Empty when no name is known.',
      ),
    detail: z.record(z.string(), z.unknown()),
  }),
);

export const incidentEventListSchema = z.array(incidentEventSchema);

/**
 * `POST /v1/incidents/{id}/response` (SCRUM-50/51, D56; documentation: the route validates as
 * `responseStatusFromBody` describes).
 */
export const incidentResponseRequestSchema = z.object({
  status: z
    .enum(['responding', 'unable'])
    .describe(
      '"responding" (I am responding) or "unable" (unable to respond). Anything else is 422 incident_response:invalid_status.',
    ),
});

/**
 * One notified member on the responder list (SCRUM-49/50/51/55, D56), and the body of
 * `POST /v1/incidents/{id}/response` (the caller's own row). A member gets exactly the 7 keys; the
 * resident also gets the 3 delivery keys (SCRUM-65, D73). Never a phone, email or other profile
 * field.
 */
export const responderSchema = componentSchema(
  'Responder',
  z.object({
    user_id: z
      .string()
      .describe(
        'The member. The resident gets the full UUID. A member gets the ids of other members obscured as ' +
          'incident event actor ids (D11): the first 4 and the last 4 hex characters kept, every ' +
          'other hex character "*", hyphens kept (e.g. "4f3a****-****-****-****-********9c2d"); ' +
          'their own id in full. Not a usable UUID when obscured.',
      ),
    display_name: z
      .string()
      .describe("The member's profile name (trimmed), else the name stored on their membership."),
    avatar_url: z
      .string()
      .nullable()
      .describe(
        "Public URL of the member's profile photo, as in the circle member list; null without one.",
      ),
    status: z
      .enum(['responding', 'acknowledged', 'unable', 'no_response'])
      .describe(
        "responding / unable: the member's response; acknowledged: seen, no response yet; no_response: not acknowledged.",
      ),
    acknowledged_at: z
      .string()
      .nullable()
      .describe('When the member acknowledged (also set by their first response); null if not.'),
    status_at: z
      .string()
      .nullable()
      .describe(
        'When the current status was set: the response time for responding / unable, the acknowledge time for acknowledged, null for no_response.',
      ),
    is_me: z.boolean().describe("True on the caller's own row."),
    delivery_status: z
      .enum(['sent', 'delivered', 'failed'])
      .optional()
      .describe(
        "RESIDENT ONLY (SCRUM-65, D73; absent on a member's rows): the alert's delivery to this member. " +
          'delivered = the push service accepted the alert (or a re-notify) for at least one of their ' +
          'devices; sent = still being sent or retried; failed = every attempt failed after its retries, ' +
          'or nothing could be sent (no device with notifications, push switched off). A re-notify ' +
          'recomputes it (failed can become delivered).',
      ),
    delivery_at: z
      .string()
      .nullable()
      .optional()
      .describe(
        'RESIDENT ONLY (D73): delivered = the first acceptance; failed = when the last attempt became final (null when nothing was ever sent); sent = null.',
      ),
    delivery_failed_reason: z
      .enum(['no_device', 'failed'])
      .nullable()
      .optional()
      .describe(
        'RESIDENT ONLY (D73): failed = the push service did not accept it after the retries; no_device = nothing could be sent (no device with notifications or push switched off); null unless delivery_status is failed.',
      ),
  }),
);

/**
 * `GET /v1/incidents/{id}/responders`: every notified member who is still a member inside the window,
 * responding first, then acknowledged, then unable, then no response, each oldest first.
 */
export const responderListSchema = z.array(responderSchema);

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

/**
 * `POST /v1/incidents/{id}/updates` (SCRUM-44/59, D70; documentation: the route validates as
 * `statusUpdateFromBody` describes). Exactly one of `preset` or `text`.
 */
export const sendIncidentUpdateRequestSchema = z.object({
  preset: z
    .enum(['situation_worsening', 'help_is_here'])
    .nullable()
    .optional()
    .describe(
      'A quick update: "situation_worsening" (Situation worsening) or "help_is_here" (Help is here). Give exactly one of preset or text (null counts as not given); else 422 incident_updates:invalid_update.',
    ),
  text: z
    .string()
    .nullable()
    .optional()
    .describe(
      'A free-text update: trimmed of white space, then 1 to 250 characters. Give exactly one of preset or text; else 422 incident_updates:invalid_update.',
    ),
});

/**
 * One resident status update (SCRUM-44/59, D70): the body of `POST /v1/incidents/{id}/updates`, one
 * entry of `GET /v1/incidents/{id}/updates` and of the realtime `incident.update`. Exactly these 4
 * keys: never an id of a person.
 */
export const incidentUpdateSchema = componentSchema(
  'IncidentUpdate',
  z.object({
    id: z.uuid().describe('The update (its incident event id).'),
    preset: z
      .enum(['situation_worsening', 'help_is_here'])
      .nullable()
      .describe('The quick update, or null for a free-text update.'),
    text: z.string().nullable().describe('The free text (trimmed), or null for a quick update.'),
    created_at: z.string().describe('When the server stored the update.'),
  }),
);

export const incidentUpdateListSchema = z.array(incidentUpdateSchema);
