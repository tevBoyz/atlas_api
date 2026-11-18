import { z } from 'zod';

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

/** IncidentShared (spec §7.0, `_incident_activation_json`): exactly 22 keys. */
export const incidentSharedSchema = z.object({
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
});

/** IncidentSend (spec §7.0): IncidentShared plus the delivery counts. */
export const incidentSendSchema = incidentSharedSchema.extend({
  delivered_count: z.number().int(),
  acknowledged_count: z.number().int(),
});

/** The body of `POST /v1/incidents`: IncidentSend plus `submit_outcome`. */
export const incidentSubmitResultSchema = incidentSendSchema.extend({
  submit_outcome: z.enum(SUBMIT_OUTCOMES),
});
