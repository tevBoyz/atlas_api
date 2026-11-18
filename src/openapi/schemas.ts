import { z } from 'zod';

/**
 * Shared contract schemas (API-100-12). Zod is the source of truth: routes and the generated OpenAPI
 * document read these. Property names are snake_case exactly as spec §7; enum values are the stored
 * values of spec §5.
 */

/** The `error` object of the envelope. */
export const errorBodySchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()),
});

/** Spec §5.2. `unspecified` appears on legacy rows only and can never be submitted. */
export const emergencyTypeSchema = z.enum([
  'medical',
  'domestic_violence',
  'fire',
  'burglary',
  'other',
  'unspecified',
]);

/** Spec §5.1 and §5.5. */
export const locationSourceSchema = z.enum(['current', 'last_known', 'unavailable']);

/** Spec §5.4. `activating` and `cancelled` appear on legacy rows only. */
export const incidentStatusSchema = z.enum(['active', 'resolved', 'activating', 'cancelled']);

/** Spec §5.3: statuses of the owner's member list (`expired` is derived, never stored). */
export const memberStatusSchema = z.enum(['active', 'pending', 'expired', 'declined']);

/** Spec §5.3: derived invite lookup status. */
export const inviteLookupStatusSchema = z.enum([
  'pending',
  'consumed',
  'canceled',
  'expired',
  'not_found',
]);

/** Enums every client needs, published in `components.schemas` before their routes exist. */
export const SHARED_ENUM_SCHEMAS = {
  EmergencyType: emergencyTypeSchema,
  LocationSource: locationSourceSchema,
  IncidentStatus: incidentStatusSchema,
  MemberStatus: memberStatusSchema,
  InviteLookupStatus: inviteLookupStatusSchema,
} as const;
