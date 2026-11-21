import { z } from 'zod';

import { componentSchema } from '../../openapi/component-schema';
import { devicePlatformSchema } from '../notifications/device.schemas';

/**
 * Contract schemas of the auth routes (spec §11.3 A1-A20, Phase 6). They document the bodies; each
 * route parses its body itself (`auth-input.ts`) so every field keeps its own `auth:*` /
 * `login_lockout:*` code in `details.field`.
 */

/** ISO-8601 timestamps are plain strings in the contract, as on every other route. */
const timestamp = z.string();

export const deviceInfoSchema = componentSchema(
  'DeviceInfo',
  z.object({
    platform: devicePlatformSchema,
    app_version: z.string().min(1).max(64).describe('Trimmed; 1-64 characters.'),
    device_name: z
      .string()
      .min(1)
      .max(100)
      .nullable()
      .optional()
      .describe('Shown in the session list, e.g. "Pixel 8". Optional.'),
  }),
);

export const identityProviderSchema = componentSchema(
  'IdentityProvider',
  z.enum(['email', 'phone', 'google', 'apple']),
);

export const userSchema = componentSchema(
  'User',
  z.object({
    id: z.uuid(),
    email: z.string().nullable(),
    phone: z.string().nullable().describe('`+E.164`.'),
    email_confirmed_at: timestamp.nullable(),
    phone_confirmed_at: timestamp.nullable(),
    created_at: timestamp,
    identities: z.array(
      componentSchema(
        'UserIdentity',
        z.object({ provider: identityProviderSchema, created_at: timestamp }),
      ),
    ),
  }),
);

const sessionShape = {
  access_token: z.string().describe('JWT, 15 minutes. Send as `Authorization: Bearer ...`.'),
  access_token_expires_at: timestamp,
  refresh_token: z
    .string()
    .describe('Opaque, single use: every refresh returns a new one. Keep it in secure storage.'),
  refresh_token_expires_at: timestamp.describe(
    'Refresh before this: a session not refreshed for 7 days ends (sign in again).',
  ),
  session_id: z.uuid(),
  user: userSchema,
};

export const sessionSchema = componentSchema('Session', z.object(sessionShape));

export const oauthSessionSchema = componentSchema(
  'OAuthSession',
  z.object({
    ...sessionShape,
    is_new_user: z.boolean().describe('True when this sign-in created the account.'),
  }),
);

export const lockoutStatusSchema = componentSchema(
  'LockoutStatus',
  z.object({
    locked: z.boolean(),
    locked_until: timestamp.nullable().describe('Only when locked.'),
    failed_attempts: z.number().int(),
  }),
);

export const lockoutStatusQuerySchema = z.object({
  email: z.string().optional().describe('Exactly one of `email` / `phone`.'),
  phone: z.string().optional().describe('`+E.164` (digits only are accepted and get a `+`).'),
});

export const loginRequestSchema = z.object({
  email: z.string().nullable().optional().describe('Exactly one of `email` / `phone`.'),
  phone: z.string().nullable().optional(),
  password: z.string().min(1),
  device: deviceInfoSchema,
});

export const signupRequestSchema = z.object({
  email: z.string().max(254),
  password: z.string().min(8).max(128).describe('8-128 characters: lowercase, uppercase, digit.'),
  phone: z.string().describe('`+E.164`; stored unverified (verify it with the OTP routes).'),
  full_name: z.string().min(1).max(100),
  device: deviceInfoSchema,
});

export const signupAcceptedSchema = componentSchema(
  'SignupAccepted',
  z.object({
    verification: z.object({
      channel: z.literal('email'),
      expires_in_seconds: z.number().int().describe('Lifetime of the emailed link.'),
    }),
  }),
);

export const emailVerifyRequestSchema = z.object({
  token: z.string().describe('The `token` query value of the emailed link.'),
  device: deviceInfoSchema,
});

export const emailResendRequestSchema = z.object({
  email: z.string().max(254),
  purpose: z
    .enum(['signup', 'magic_link'])
    .optional()
    .describe('`signup` (default): a new confirmation link; `magic_link`: a sign-in link.'),
});

export const otpPurposeSchema = componentSchema('OtpPurpose', z.enum(['verify_phone', 'sign_in']));

export const otpSendRequestSchema = z.object({
  phone: z.string().describe('`+E.164`.'),
  purpose: otpPurposeSchema.describe(
    "`sign_in` (no access token) or `verify_phone` (the signed-in user's own number; send the access token).",
  ),
});

export const otpSentSchema = componentSchema(
  'OtpSent',
  z.object({
    expires_in_seconds: z.number().int(),
    resends_remaining: z.number().int(),
  }),
);

export const otpVerifyRequestSchema = z.object({
  phone: z.string(),
  code: z.string().describe('6 digits.'),
  purpose: otpPurposeSchema,
  device: deviceInfoSchema.optional().describe('Required for `sign_in`.'),
});

/**
 * A6's answer: `sign_in` → every key (a `Session`); `verify_phone` → `user` only. One object shape
 * (not a union), so the generated client has one class.
 */
export const otpVerifiedSchema = componentSchema(
  'OtpVerified',
  z.object({
    access_token: sessionShape.access_token.optional(),
    access_token_expires_at: sessionShape.access_token_expires_at.optional(),
    refresh_token: sessionShape.refresh_token.optional(),
    refresh_token_expires_at: sessionShape.refresh_token_expires_at.optional(),
    session_id: sessionShape.session_id.optional(),
    user: userSchema,
  }),
);

export const googleSignInRequestSchema = z.object({
  id_token: z.string(),
  access_token: z.string().nullable().optional(),
  device: deviceInfoSchema,
});

export const appleSignInRequestSchema = z.object({
  id_token: z.string(),
  nonce: z
    .string()
    .nullable()
    .optional()
    .describe('The raw nonce whose SHA-256 (hex) the app gave Apple.'),
  full_name: z.string().max(100).nullable().optional(),
  device: deviceInfoSchema,
});

export const refreshRequestSchema = z.object({ refresh_token: z.string() });

export const passwordForgotRequestSchema = z.object({ email: z.string().max(254) });

export const passwordResetRequestSchema = z.object({
  token: z.string().describe('The `token` query value of the emailed recovery link.'),
  new_password: z.string().min(8).max(128),
  device: deviceInfoSchema,
});

export const exchangeRequestSchema = z.object({ device: deviceInfoSchema });

export const sessionInfoSchema = componentSchema(
  'DeviceSession',
  z.object({
    id: z.uuid(),
    platform: devicePlatformSchema.nullable(),
    device_name: z.string().nullable(),
    created_at: timestamp,
    last_seen_at: timestamp,
    current: z.boolean(),
  }),
);

export const sessionIdParamsSchema = z.object({ session_id: z.uuid() });

export const jwksSchema = componentSchema(
  'Jwks',
  z.object({
    keys: z.array(
      componentSchema(
        'Jwk',
        z.object({
          kid: z.string(),
          kty: z.string(),
          crv: z.string(),
          x: z.string(),
          y: z.string().optional(),
          alg: z.enum(['EdDSA', 'ES256']),
          use: z.literal('sig'),
        }),
      ),
    ),
  }),
);

export const INSTALLATION_ID_HEADER_OPTIONAL = {
  name: 'X-Atlas-Installation-Id',
  required: false,
  description:
    'The app installation id (the same UUID as for `PUT /v1/me/devices/current`). Links the new session to that device, so signing out clears its push token.',
  format: 'uuid',
} as const;
