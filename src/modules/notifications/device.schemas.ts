import { z } from 'zod';

import { componentSchema } from '../../openapi/component-schema';
import {
  APP_VERSION_MAX,
  PLATFORMS,
  PUSH_PROVIDERS,
  PUSH_TOKEN_MAX,
  PUSH_TOKEN_STATUSES,
  TIME_ZONE_MAX,
} from './device-input';

/**
 * Contract schemas of the device routes (API-100-44, spec §11.3 U1/U2). They document the body; the
 * route parses it itself (`device-input.ts`) so each field keeps its own `user_devices:*` code.
 */

export const devicePlatformSchema = componentSchema('DevicePlatform', z.enum(PLATFORMS));
export const pushProviderSchema = componentSchema('PushProvider', z.enum(PUSH_PROVIDERS));

export const registerDeviceRequestSchema = z.object({
  platform: devicePlatformSchema,
  app_version: z.string().min(1).max(APP_VERSION_MAX).describe('Trimmed; 1-64 characters.'),
  push_provider: pushProviderSchema
    .nullable()
    .optional()
    .describe('Who issued `push_token`: `fcm` or `apns`. Sent together with `push_token`.'),
  push_token: z
    .string()
    .min(1)
    .max(PUSH_TOKEN_MAX)
    .nullable()
    .optional()
    .describe(
      'The device push token. Left out (with `push_provider`): the stored token is kept. `null`: the stored token is cleared. A token is on one device only: registering it here clears it from any other device.',
    ),
  time_zone: z
    .string()
    .max(TIME_ZONE_MAX)
    .nullable()
    .optional()
    .describe(
      "The phone's current IANA time zone, e.g. `Africa/Addis_Ababa` (Stage 2 [TZ]); sent on every registration. Push times for this installation are shown in it (else the profile time zone, else Africa/Banjul). Left out: the stored zone is kept. A value that is not a known IANA zone is stored as null (never an error).",
    ),
});

export const pushTokenStatusSchema = componentSchema(
  'PushTokenStatus',
  z
    .enum(PUSH_TOKEN_STATUSES)
    .describe(
      '`ok`: a push token is stored for this installation. `none`: no token is stored. `invalid`: the token sent is the one the push provider last rejected as unregistered for this installation; it was not stored, and the app must get a brand-new token and register again (D69).',
    ),
);

export const deviceRegisteredSchema = componentSchema(
  'DeviceRegistered',
  z.object({ device_id: z.uuid(), push_token_status: pushTokenStatusSchema }),
);

export const INSTALLATION_ID_HEADER_CONTRACT = {
  name: 'X-Atlas-Installation-Id',
  required: true,
  description:
    'UUID the app generates once per install and keeps in its own storage (not the push token). Identifies this installation of the app for the signed-in user.',
  format: 'uuid',
} as const;
