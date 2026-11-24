import { z } from 'zod';

import { componentSchema } from '../../openapi/component-schema';

/**
 * SCRUM-54 (D60): the local emergency services, in this FIXED order (no ordering by emergency type:
 * the person picks the one that fits).
 */
export const EMERGENCY_SERVICE_KINDS = ['ambulance', 'police', 'fire_rescue'] as const;

export type EmergencyServiceKind = (typeof EMERGENCY_SERVICE_KINDS)[number];

/** V1 region rule (D60): every incident is in The Gambia (ISO 3166-1 alpha-2). */
export const INCIDENT_REGION = 'GM';

/** The `app_config` key that holds the numbers by country. */
export const EMERGENCY_NUMBERS_CONFIG_KEY = 'emergency_numbers';

export const emergencyServiceSchema = componentSchema(
  'EmergencyService',
  z.object({
    service: z
      .enum(EMERGENCY_SERVICE_KINDS)
      .describe('Which service. Clients show unknown future values as a plain number.'),
    label: z.string().describe('What to show, e.g. `Ambulance`, `Fire and Rescue`.'),
    number: z
      .string()
      .describe(
        'The number to dial, digits only (an optional leading `+`), e.g. `116`. Confirm before dialing.',
      ),
  }),
);

export type EmergencyService = z.output<typeof emergencyServiceSchema>;

export const emergencyServicesSchema = z
  .array(emergencyServiceSchema)
  .describe(
    "The local emergency numbers of the incident's region (SCRUM-54, D60), always in the order ambulance, police, fire_rescue; a service without a number is left out; `[]` when the region has none configured.",
  );

/** `GET /v1/config/emergency-numbers`. */
export const emergencyNumbersSchema = componentSchema(
  'EmergencyNumbers',
  z.object({
    country: z.string().describe('ISO 3166-1 alpha-2 region the numbers are for (V1: `GM`).'),
    emergency_services: emergencyServicesSchema,
  }),
);

export type EmergencyNumbers = z.output<typeof emergencyNumbersSchema>;
