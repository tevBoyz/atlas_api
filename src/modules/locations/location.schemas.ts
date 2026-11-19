import { z } from 'zod';

import { locationSourceSchema } from '../../openapi/schemas';

/**
 * `POST /v1/incidents/{id}/locations` (spec §11.3 L1), for the documentation and the Dart client. The
 * route reads the body as PostgREST read the RPC arguments (see `location-input.ts`); this schema
 * describes what the app sends. Shapes by source (spec §5.5): `unavailable` sends no other field;
 * `current` sends lat, lng, accuracy and captured_at; `last_known` the same, accuracy optional.
 */
export const attachIncidentLocationRequestSchema = z.object({
  location_source: locationSourceSchema,
  location_lat: z.number().min(-90).max(90).nullable().optional(),
  location_lng: z.number().min(-180).max(180).nullable().optional(),
  location_accuracy_m: z
    .number()
    .min(0)
    .nullable()
    .optional()
    .describe('Metres. Required for `current`.'),
  location_captured_at: z
    .string()
    .nullable()
    .optional()
    .describe(
      'Device fix time, ISO-8601 with an offset (a time without one is read as UTC). A fix older than the stored one is ignored.',
    ),
});
