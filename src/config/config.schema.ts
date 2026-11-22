import { isIP } from 'node:net';

import { z } from 'zod';

import { dataStoreProblems } from './data-store-guard';
import { JWT_KID_PATTERN, JwtKeysError, parseJwtKeys } from './jwt-keys';

/**
 * Typed environment configuration (story API-100-02).
 *
 * Only infrastructure settings and secrets live here. Runtime business settings stay in the
 * `app_config` table (spec §4.8) and are read per request by the config feature module.
 *
 * Rules:
 * - Empty (or whitespace-only) values count as unset, so `KEY=` in `.env` falls back to the default.
 * - Validation errors name the offending key(s) and the rule they break, never the value.
 */

export const NODE_ENVS = ['development', 'test', 'production'] as const;
export const AVATAR_STORAGE_DRIVERS = ['supabase', 'memory'] as const;
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
/** Push adapter (API-100-46): the in-process fake, or FCM (Android) + APNs (iOS). */
export const PUSH_ADAPTERS = ['fake', 'real'] as const;
/** SMS adapter (API-100-46): the in-process fake, or Twilio (on hold: CHANNEL_SMS_TWILIO_HOLD_LIFTED). */
export const SMS_ADAPTERS = ['fake', 'twilio'] as const;
/** Email adapter (D43): the in-process fake, or SendGrid (v3 Mail Send). */
export const EMAIL_ADAPTERS = ['fake', 'sendgrid'] as const;
/** The real SendGrid API; tests point SENDGRID_API_BASE_URL at a local fake server. */
export const SENDGRID_DEFAULT_BASE_URL = 'https://api.sendgrid.com';
export const APNS_ENVIRONMENTS = ['production', 'sandbox'] as const;
/** Every notification retry must happen within this time (spec §11.6: 3 retries within 60 s). */
export const NOTIFICATION_RETRY_WINDOW_MS = 60_000;

export type NodeEnv = (typeof NODE_ENVS)[number];
export type LogLevel = (typeof LOG_LEVELS)[number];
/** Shape Fastify accepts for `trustProxy`: off/on, a hop count, or a list of IPs/CIDRs. */
export type TrustProxy = boolean | number | string[];

const urlWithProtocol = (protocols: readonly string[]) =>
  z.string().refine((value) => {
    try {
      const parsed = new URL(value);
      return protocols.length === 0 || protocols.includes(parsed.protocol);
    } catch {
      return false;
    }
  });

const integerInRange = (min: number, max: number) =>
  z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(min).max(max));

const flag = () => z.stringbool({ truthy: ['true'], falsy: ['false'] }).default(false);
const nonEmpty = () => z.string().min(1).optional();

/** `a, b ,c` → `['a', 'b', 'c']`: a comma-separated list of OAuth client ids (no blanks). */
const clientIdList = () =>
  z
    .string()
    .transform((value) =>
      value
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0),
    )
    .pipe(z.array(z.string().regex(/^[A-Za-z0-9._:-]{1,255}$/)).min(1))
    .optional();

/** An ISO-8601 date-time with a time zone (e.g. `2027-01-31T00:00:00Z`). */
const isoDateTime = () =>
  z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/)
    .refine((value) => !Number.isNaN(Date.parse(value)))
    .optional();

function isIpOrCidr(entry: string): boolean {
  const [address, prefix, ...rest] = entry.split('/');
  if (rest.length > 0 || !address) return false;
  const version = isIP(address);
  if (version === 0) return false;
  if (prefix === undefined) return true;
  if (!/^\d+$/.test(prefix)) return false;
  return Number(prefix) <= (version === 4 ? 32 : 128);
}

const trustProxy = z.string().transform((value, ctx): TrustProxy => {
  const lower = value.toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (entries.length === 0 || !entries.every(isIpOrCidr)) {
    ctx.issues.push({ code: 'custom', message: 'invalid', input: value });
    return z.NEVER;
  }
  return entries;
});

export const configSchema = z.object({
  NODE_ENV: z.enum(NODE_ENVS).default('development'),
  PORT: integerInRange(1, 65535).default(3000),

  DATABASE_URL: urlWithProtocol(['postgres:', 'postgresql:']).optional(),
  DATABASE_POOL_MAX: integerInRange(1, 1000).default(10),
  REDIS_URL: urlWithProtocol(['redis:', 'rediss:']).optional(),
  // Outside production, DATABASE_URL / REDIS_URL must be local unless this is true (API-100-07).
  ALLOW_REMOTE_DATA_STORES: flag(),

  SUPABASE_URL: urlWithProtocol(['http:', 'https:']).optional(),
  SUPABASE_JWT_JWKS_URL: urlWithProtocol(['http:', 'https:']).optional(),
  SUPABASE_JWT_SECRET: z.string().min(32).optional(),
  SUPABASE_JWT_ISSUER: urlWithProtocol(['http:', 'https:']).optional(),
  SUPABASE_JWT_AUDIENCE: z.string().default('authenticated'),
  // Allowed clock difference when checking `exp` / `nbf` of Supabase JWTs (API-100-08 AC2: <= 30 s).
  SUPABASE_JWT_CLOCK_SKEW_SECONDS: integerInRange(0, 30).default(30),
  SUPABASE_STORAGE_SERVICE_KEY: z.string().optional(),
  // Where profile photos go (API-100-37): Supabase Storage, or the in-memory fake (tests, local
  // manual testing; refused when NODE_ENV=production).
  AVATAR_STORAGE: z.enum(AVATAR_STORAGE_DRIVERS).default('supabase'),
  AVATARS_BUCKET: z
    .string()
    .regex(/^[a-z0-9][a-z0-9._-]*$/)
    .default('avatars'),
  INVITE_URL_BASE: urlWithProtocol([]).default('io.supabase.atlasmobile://invite/'),

  TRUST_PROXY: trustProxy.default(false),
  // Serves GET /v1/openapi.json. Never served in production, whatever this says (API-100-12).
  OPENAPI_ENABLED: z.stringbool({ truthy: ['true'], falsy: ['false'] }).default(true),

  // Rate limits (API-100-11 AC2): requests allowed per sliding window, per key.
  RATE_LIMIT_AUTHENTICATED_MAX: integerInRange(1, 1_000_000).default(300),
  RATE_LIMIT_AUTHENTICATED_WINDOW_SECONDS: integerInRange(1, 86_400).default(60),
  RATE_LIMIT_PUBLIC_MAX: integerInRange(1, 1_000_000).default(60),
  RATE_LIMIT_PUBLIC_WINDOW_SECONDS: integerInRange(1, 86_400).default(300),
  RATE_LIMIT_LOCATION_PING_MAX: integerInRange(1, 1_000_000).default(30),
  RATE_LIMIT_LOCATION_PING_WINDOW_SECONDS: integerInRange(1, 86_400).default(60),
  RATE_LIMIT_EMERGENCY_WRITE_MAX: integerInRange(1, 1_000_000).default(30),
  RATE_LIMIT_EMERGENCY_WRITE_WINDOW_SECONDS: integerInRange(1, 86_400).default(60),
  RATE_LIMIT_AUTH_FAILURE_MAX: integerInRange(1, 1_000_000).default(120),
  RATE_LIMIT_AUTH_FAILURE_WINDOW_SECONDS: integerInRange(1, 86_400).default(60),
  RATE_LIMIT_AVATAR_UPLOAD_MAX: integerInRange(1, 1_000_000).default(20),
  RATE_LIMIT_AVATAR_UPLOAD_WINDOW_SECONDS: integerInRange(1, 86_400).default(3600),
  // Longest wait for Redis before the limiter lets the request through (fail open).
  RATE_LIMIT_REDIS_TIMEOUT_MS: integerInRange(1, 5_000).default(100),

  // Channel prefix of the Socket.IO Redis adapter (API-100-39). Instances that share it share rooms.
  REALTIME_ADAPTER_KEY: z
    .string()
    .regex(/^[A-Za-z0-9:._-]{1,64}$/)
    .default('atlas:realtime'),

  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  SENTRY_DSN: urlWithProtocol(['http:', 'https:']).optional(),
  OTEL_EXPORTER_OTLP_ENDPOINT: urlWithProtocol(['http:', 'https:']).optional(),
  GIT_COMMIT: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/i)
    .optional(),

  // Jobs (API-100-45): `WORKER=1` runs the BullMQ workers instead of the HTTP server (same image).
  WORKER: z.stringbool({ truthy: ['1', 'true'], falsy: ['0', 'false'] }).default(false),
  // Key prefix of the BullMQ queues in Redis. Every API and worker process of one environment uses
  // the same value.
  JOBS_QUEUE_PREFIX: z
    .string()
    .regex(/^[A-Za-z0-9:._-]{1,64}$/)
    .default('atlas:jobs'),
  JOBS_WORKER_CONCURRENCY: integerInRange(1, 100).default(10),
  // The outbox relay sweeps unpublished rows this often (and right after each committed write).
  OUTBOX_RELAY_INTERVAL_MS: integerInRange(50, 60_000).default(1000),
  OUTBOX_RELAY_BATCH_SIZE: integerInRange(1, 1000).default(100),

  // Delivery retries (API-100-47): exponential backoff, base * 2^(n-1) before retry n.
  NOTIFICATIONS_RETRY_ATTEMPTS: integerInRange(0, 10).default(3),
  NOTIFICATIONS_RETRY_BASE_DELAY_MS: integerInRange(10, 60_000).default(2000),
  // Longest wait for one provider call.
  NOTIFICATIONS_SEND_TIMEOUT_MS: integerInRange(100, 30_000).default(10_000),

  // Channels (API-100-46). Disabled channels record `skipped` deliveries and call no adapter.
  CHANNEL_PUSH_ENABLED: flag(),
  CHANNEL_SMS_ENABLED: flag(),
  CHANNEL_EMAIL_ENABLED: flag(),
  CHANNEL_PUSH_ADAPTER: z.enum(PUSH_ADAPTERS).default('fake'),
  CHANNEL_SMS_ADAPTER: z.enum(SMS_ADAPTERS).default('fake'),
  // Twilio hold: the Twilio adapter is refused unless this is true (Dawit lifts the hold).
  CHANNEL_SMS_TWILIO_HOLD_LIFTED: flag(),
  FCM_PROJECT_ID: nonEmpty(),
  FCM_CLIENT_EMAIL: nonEmpty(),
  FCM_PRIVATE_KEY: nonEmpty(),
  APNS_KEY_ID: nonEmpty(),
  APNS_TEAM_ID: nonEmpty(),
  APNS_PRIVATE_KEY: nonEmpty(),
  APNS_BUNDLE_ID: nonEmpty(),
  APNS_ENVIRONMENT: z.enum(APNS_ENVIRONMENTS).default('production'),
  // Email through SendGrid (D43, stage 7.7a): off by default; `sendgrid` needs the key and sender.
  CHANNEL_EMAIL_ADAPTER: z.enum(EMAIL_ADAPTERS).default('fake'),
  SENDGRID_API_KEY: nonEmpty(),
  SENDGRID_API_BASE_URL: urlWithProtocol(['http:', 'https:']).default(SENDGRID_DEFAULT_BASE_URL),
  EMAIL_FROM_ADDRESS: z
    .string()
    .max(254)
    .regex(/^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/)
    .optional(),
  EMAIL_FROM_NAME: z
    .string()
    .max(100)
    .regex(/^[^\r\n<>"]+$/)
    .optional(),
  TWILIO_ACCOUNT_SID: nonEmpty(),
  TWILIO_AUTH_TOKEN: nonEmpty(),
  TWILIO_FROM_NUMBER: z
    .string()
    .regex(/^\+[1-9][0-9]{7,14}$/)
    .optional(),
  // Twilio Verify service for phone OTP (API-100-53); only used by the Twilio adapter (hold).
  TWILIO_VERIFY_SERVICE_SID: z
    .string()
    .regex(/^VA[0-9a-fA-F]{32}$/)
    .optional(),

  // Own authentication (Phase 6, API-100-51 to 59).
  // Signing keys of the access tokens: a JSON array of JWKs (SECRET) and the kid that signs.
  AUTH_JWT_KEYS: nonEmpty(),
  AUTH_JWT_ACTIVE_KID: z.string().regex(JWT_KID_PATTERN).optional(),
  AUTH_JWT_ISSUER: z
    .string()
    .regex(/^[A-Za-z0-9:/._-]{1,200}$/)
    .default('atlas-api'),
  AUTH_JWT_AUDIENCE: z
    .string()
    .regex(/^[A-Za-z0-9:/._-]{1,200}$/)
    .default('atlas-app'),
  AUTH_ACCESS_TOKEN_TTL_SECONDS: integerInRange(60, 3600).default(900),
  AUTH_JWT_CLOCK_SKEW_SECONDS: integerInRange(0, 30).default(30),
  AUTH_REFRESH_TOKEN_TTL_DAYS: integerInRange(1, 90).default(30),
  AUTH_SESSION_IDLE_DAYS: integerInRange(1, 90).default(7),
  AUTH_EMAIL_LINK_TTL_SECONDS: integerInRange(60, 86_400).default(300),
  AUTH_LINK_BASE: urlWithProtocol([]).default('io.supabase.atlasmobile://login-callback/'),
  // Test-only seam: GET /__test/auth-messages reads what the FAKE email/SMS adapters "sent"
  // (verification links, OTP codes). Refused when NODE_ENV=production.
  AUTH_TEST_MAILBOX_ENABLED: flag(),
  // Dual-token window (API-100-59): accept Supabase access tokens at all, and until when. Off by
  // default since stage 7.1d (D40): the app has no Supabase sessions any more; the exchange route
  // (D35) and the verifier stay, for an explicit SUPABASE_JWT_ACCEPT=true.
  SUPABASE_JWT_ACCEPT: z.stringbool({ truthy: ['true'], falsy: ['false'] }).default(false),
  SUPABASE_JWT_ACCEPT_UNTIL: isoDateTime(),
  // Google / Apple ID-token sign-in (API-100-55). Without client ids the provider is disabled.
  GOOGLE_CLIENT_IDS: clientIdList(),
  GOOGLE_JWKS_URL: urlWithProtocol(['http:', 'https:']).default(
    'https://www.googleapis.com/oauth2/v3/certs',
  ),
  APPLE_SIGN_IN_ENABLED: flag(),
  APPLE_CLIENT_IDS: clientIdList(),
  APPLE_JWKS_URL: urlWithProtocol(['http:', 'https:']).default(
    'https://appleid.apple.com/auth/keys',
  ),
});

export type Config = z.output<typeof configSchema>;
export type ConfigKey = keyof Config;

/** What each key must look like. Used in error messages instead of the (possibly secret) value. */
const RULES: Record<ConfigKey, string> = {
  NODE_ENV: `must be one of ${NODE_ENVS.join(', ')}`,
  PORT: 'must be an integer from 1 to 65535',
  DATABASE_URL: 'must be a postgres:// or postgresql:// URL',
  DATABASE_POOL_MAX: 'must be an integer from 1 to 1000',
  REDIS_URL: 'must be a redis:// or rediss:// URL',
  ALLOW_REMOTE_DATA_STORES: 'must be true or false',
  SUPABASE_URL: 'must be an http(s) URL',
  SUPABASE_JWT_JWKS_URL: 'must be an http(s) URL',
  SUPABASE_JWT_SECRET: 'must be at least 32 characters',
  SUPABASE_JWT_ISSUER: 'must be an http(s) URL',
  SUPABASE_JWT_AUDIENCE: 'must be a string',
  SUPABASE_JWT_CLOCK_SKEW_SECONDS: 'must be an integer from 0 to 30',
  SUPABASE_STORAGE_SERVICE_KEY: 'must be a string',
  AVATAR_STORAGE: `must be one of ${AVATAR_STORAGE_DRIVERS.join(', ')}`,
  AVATARS_BUCKET: 'must be a bucket name (lowercase letters, digits, ".", "_", "-")',
  INVITE_URL_BASE: 'must be a URL (any scheme)',
  TRUST_PROXY: 'must be true, false, a hop count, or a comma-separated list of IPs/CIDRs',
  OPENAPI_ENABLED: 'must be true or false',
  RATE_LIMIT_AUTHENTICATED_MAX: 'must be an integer from 1 to 1000000',
  RATE_LIMIT_AUTHENTICATED_WINDOW_SECONDS: 'must be an integer from 1 to 86400',
  RATE_LIMIT_PUBLIC_MAX: 'must be an integer from 1 to 1000000',
  RATE_LIMIT_PUBLIC_WINDOW_SECONDS: 'must be an integer from 1 to 86400',
  RATE_LIMIT_LOCATION_PING_MAX: 'must be an integer from 1 to 1000000',
  RATE_LIMIT_LOCATION_PING_WINDOW_SECONDS: 'must be an integer from 1 to 86400',
  RATE_LIMIT_EMERGENCY_WRITE_MAX: 'must be an integer from 1 to 1000000',
  RATE_LIMIT_EMERGENCY_WRITE_WINDOW_SECONDS: 'must be an integer from 1 to 86400',
  RATE_LIMIT_AUTH_FAILURE_MAX: 'must be an integer from 1 to 1000000',
  RATE_LIMIT_AUTH_FAILURE_WINDOW_SECONDS: 'must be an integer from 1 to 86400',
  RATE_LIMIT_AVATAR_UPLOAD_MAX: 'must be an integer from 1 to 1000000',
  RATE_LIMIT_AVATAR_UPLOAD_WINDOW_SECONDS: 'must be an integer from 1 to 86400',
  RATE_LIMIT_REDIS_TIMEOUT_MS: 'must be an integer from 1 to 5000',
  REALTIME_ADAPTER_KEY: 'must be 1-64 letters, digits, ":", ".", "_" or "-"',
  LOG_LEVEL: `must be one of ${LOG_LEVELS.join(', ')}`,
  SENTRY_DSN: 'must be an http(s) URL',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'must be an http(s) URL',
  GIT_COMMIT: 'must be a git commit hash (7-40 hex characters)',
  WORKER: 'must be 1, 0, true or false',
  JOBS_QUEUE_PREFIX: 'must be 1-64 letters, digits, ":", ".", "_" or "-"',
  JOBS_WORKER_CONCURRENCY: 'must be an integer from 1 to 100',
  OUTBOX_RELAY_INTERVAL_MS: 'must be an integer from 50 to 60000',
  OUTBOX_RELAY_BATCH_SIZE: 'must be an integer from 1 to 1000',
  NOTIFICATIONS_RETRY_ATTEMPTS: 'must be an integer from 0 to 10',
  NOTIFICATIONS_RETRY_BASE_DELAY_MS: 'must be an integer from 10 to 60000',
  NOTIFICATIONS_SEND_TIMEOUT_MS: 'must be an integer from 100 to 30000',
  CHANNEL_PUSH_ENABLED: 'must be true or false',
  CHANNEL_SMS_ENABLED: 'must be true or false',
  CHANNEL_EMAIL_ENABLED: 'must be true or false',
  CHANNEL_PUSH_ADAPTER: `must be one of ${PUSH_ADAPTERS.join(', ')}`,
  CHANNEL_SMS_ADAPTER: `must be one of ${SMS_ADAPTERS.join(', ')}`,
  CHANNEL_SMS_TWILIO_HOLD_LIFTED: 'must be true or false',
  FCM_PROJECT_ID: 'must be a string',
  FCM_CLIENT_EMAIL: 'must be a string',
  FCM_PRIVATE_KEY: 'must be a string',
  APNS_KEY_ID: 'must be a string',
  APNS_TEAM_ID: 'must be a string',
  APNS_PRIVATE_KEY: 'must be a string',
  APNS_BUNDLE_ID: 'must be a string',
  APNS_ENVIRONMENT: `must be one of ${APNS_ENVIRONMENTS.join(', ')}`,
  CHANNEL_EMAIL_ADAPTER: `must be one of ${EMAIL_ADAPTERS.join(', ')}`,
  SENDGRID_API_KEY: 'must be a string',
  SENDGRID_API_BASE_URL: 'must be an http(s) URL',
  EMAIL_FROM_ADDRESS: 'must be an email address (name@domain.tld, at most 254 characters)',
  EMAIL_FROM_NAME: 'must be 1-100 characters without line breaks, "<", ">" or quotes',
  TWILIO_ACCOUNT_SID: 'must be a string',
  TWILIO_AUTH_TOKEN: 'must be a string',
  TWILIO_FROM_NUMBER: 'must be an E.164 phone number (+ and 8-15 digits)',
  TWILIO_VERIFY_SERVICE_SID: 'must be a Twilio Verify service SID (VA and 32 hex characters)',
  AUTH_JWT_KEYS: 'must be a JSON array of JWKs',
  AUTH_JWT_ACTIVE_KID: 'must be 1-64 letters, digits, ".", "_" or "-"',
  AUTH_JWT_ISSUER: 'must be 1-200 letters, digits, ":", "/", ".", "_" or "-"',
  AUTH_JWT_AUDIENCE: 'must be 1-200 letters, digits, ":", "/", ".", "_" or "-"',
  AUTH_ACCESS_TOKEN_TTL_SECONDS: 'must be an integer from 60 to 3600',
  AUTH_JWT_CLOCK_SKEW_SECONDS: 'must be an integer from 0 to 30',
  AUTH_REFRESH_TOKEN_TTL_DAYS: 'must be an integer from 1 to 90',
  AUTH_SESSION_IDLE_DAYS: 'must be an integer from 1 to 90',
  AUTH_EMAIL_LINK_TTL_SECONDS: 'must be an integer from 60 to 86400',
  AUTH_LINK_BASE: 'must be a URL (any scheme)',
  AUTH_TEST_MAILBOX_ENABLED: 'must be true or false',
  SUPABASE_JWT_ACCEPT: 'must be true or false',
  SUPABASE_JWT_ACCEPT_UNTIL: 'must be an ISO-8601 date-time with a time zone',
  GOOGLE_CLIENT_IDS: 'must be a comma-separated list of client ids',
  GOOGLE_JWKS_URL: 'must be an http(s) URL',
  APPLE_SIGN_IN_ENABLED: 'must be true or false',
  APPLE_CLIENT_IDS: 'must be a comma-separated list of client ids',
  APPLE_JWKS_URL: 'must be an http(s) URL',
};

/** FCM service-account keys (API-100-46). All or none. */
export const FCM_KEYS = [
  'FCM_PROJECT_ID',
  'FCM_CLIENT_EMAIL',
  'FCM_PRIVATE_KEY',
] as const satisfies readonly ConfigKey[];
/** APNs token-auth keys (API-100-46). All or none. */
export const APNS_KEYS = [
  'APNS_KEY_ID',
  'APNS_TEAM_ID',
  'APNS_PRIVATE_KEY',
  'APNS_BUNDLE_ID',
] as const satisfies readonly ConfigKey[];
/** Twilio keys (API-100-46). All required by the Twilio adapter. */
export const TWILIO_KEYS = [
  'TWILIO_ACCOUNT_SID',
  'TWILIO_AUTH_TOKEN',
  'TWILIO_FROM_NUMBER',
] as const satisfies readonly ConfigKey[];

/** SendGrid keys (D43). All required by the SendGrid email adapter. */
export const SENDGRID_KEYS = [
  'SENDGRID_API_KEY',
  'EMAIL_FROM_ADDRESS',
] as const satisfies readonly ConfigKey[];

/** Keys that must be set when NODE_ENV=production (optional in development/test for now). */
export const REQUIRED_IN_PRODUCTION = [
  'DATABASE_URL',
  'REDIS_URL',
  'SUPABASE_URL',
  'SUPABASE_JWT_ISSUER',
  // Signed avatar upload URLs (API-100-37); optional in development / tests.
  'SUPABASE_STORAGE_SERVICE_KEY',
  // Own access tokens (API-100-51).
  'AUTH_JWT_KEYS',
  'AUTH_JWT_ACTIVE_KID',
] as const satisfies readonly ConfigKey[];

/** At least one of these verifies Supabase JWTs; one is required when NODE_ENV=production. */
export const SUPABASE_JWT_VERIFIERS = [
  'SUPABASE_JWT_JWKS_URL',
  'SUPABASE_JWT_SECRET',
] as const satisfies readonly ConfigKey[];

export interface ConfigProblem {
  /** Offending key name(s). */
  keys: string[];
  /** Why it is wrong. Never contains the value. */
  reason: string;
}

/** Raised when the environment does not pass validation. Its message names keys only, never values. */
export class ConfigValidationError extends Error {
  readonly problems: readonly ConfigProblem[];

  constructor(problems: ConfigProblem[]) {
    const lines = problems.map((p) => `  - ${p.keys.join(' or ')}: ${p.reason}`);
    super(`Invalid configuration:\n${lines.join('\n')}`);
    this.name = 'ConfigValidationError';
    this.problems = problems;
  }

  /** Every key named in the problems. */
  get keys(): string[] {
    return [...new Set(this.problems.flatMap((p) => p.keys))];
  }
}

/** Copies known keys, trimming values and dropping empty ones (empty counts as unset). */
function normalize(env: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(configSchema.shape)) {
    const raw = env[key];
    if (typeof raw !== 'string') continue;
    const value = raw.trim();
    if (value.length > 0) out[key] = value;
  }
  return out;
}

function isConfigKey(key: unknown): key is ConfigKey {
  return typeof key === 'string' && key in RULES;
}

/**
 * Validates an environment object (normally `process.env`) and returns the typed config.
 * Throws {@link ConfigValidationError} listing every offending key.
 */
export function parseConfig(env: Record<string, unknown>): Config {
  const input = normalize(env);
  const problems: ConfigProblem[] = [];

  const result = configSchema.safeParse(input);
  if (!result.success) {
    const seen = new Set<string>();
    for (const issue of result.error.issues) {
      const key = issue.path[0];
      const name = isConfigKey(key) ? key : String(key);
      if (seen.has(name)) continue;
      seen.add(name);
      problems.push({ keys: [name], reason: isConfigKey(key) ? RULES[key] : 'is invalid' });
    }
  }

  if (input.NODE_ENV === 'production') {
    for (const key of REQUIRED_IN_PRODUCTION) {
      if (input[key] === undefined) {
        problems.push({ keys: [key], reason: 'is required when NODE_ENV=production' });
      }
    }
    if (input.AVATAR_STORAGE === 'memory') {
      problems.push({
        keys: ['AVATAR_STORAGE'],
        reason: 'must be supabase when NODE_ENV=production (memory is for tests only)',
      });
    }
    if (SUPABASE_JWT_VERIFIERS.every((key) => input[key] === undefined)) {
      problems.push({
        keys: [...SUPABASE_JWT_VERIFIERS],
        reason: 'at least one is required when NODE_ENV=production',
      });
    }
  }

  // Production-safety guard (API-100-07): names key and host only, never credentials.
  if (result.success) {
    for (const problem of dataStoreProblems(result.data)) {
      problems.push({ keys: [problem.key], reason: problem.reason });
    }
    problems.push(...channelProblems(result.data));
    problems.push(...authProblems(result.data));
  }

  if (problems.length > 0 || !result.success) {
    throw new ConfigValidationError(problems);
  }
  return result.data;
}

/**
 * Own-auth rules across keys (Phase 6). Names keys only, never values (the keys are secret).
 * - AUTH_JWT_KEYS and AUTH_JWT_ACTIVE_KID come together, and must parse (jwt-keys.ts).
 * - The test mailbox (verification links and OTP codes of the fake adapters) never in production.
 * - Apple sign-in needs its client ids when enabled.
 */
function authProblems(config: Config): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  const keys = config.AUTH_JWT_KEYS;
  const kid = config.AUTH_JWT_ACTIVE_KID;
  if ((keys === undefined) !== (kid === undefined)) {
    problems.push({
      keys: [keys === undefined ? 'AUTH_JWT_KEYS' : 'AUTH_JWT_ACTIVE_KID'],
      reason: 'required together with AUTH_JWT_KEYS, AUTH_JWT_ACTIVE_KID',
    });
  } else if (keys !== undefined && kid !== undefined) {
    try {
      parseJwtKeys(keys, kid);
    } catch (error) {
      const reason = error instanceof JwtKeysError ? error.message : 'is invalid';
      problems.push({ keys: ['AUTH_JWT_KEYS'], reason });
    }
  }
  if (config.NODE_ENV === 'production' && config.AUTH_TEST_MAILBOX_ENABLED) {
    problems.push({
      keys: ['AUTH_TEST_MAILBOX_ENABLED'],
      reason: 'must be false when NODE_ENV=production (test-only seam)',
    });
  }
  if (config.APPLE_SIGN_IN_ENABLED && config.APPLE_CLIENT_IDS === undefined) {
    problems.push({
      keys: ['APPLE_CLIENT_IDS'],
      reason: 'required when APPLE_SIGN_IN_ENABLED=true',
    });
  }
  return problems;
}

/**
 * Channel and retry rules across keys (API-100-46/47, D24, D25). Names keys only.
 * - A key set is all-or-none; the real push adapter needs at least one complete set (FCM or APNs).
 * - The Twilio adapter needs its keys AND CHANNEL_SMS_TWILIO_HOLD_LIFTED=true (Twilio hold).
 * - The SendGrid email adapter needs SENDGRID_API_KEY and EMAIL_FROM_ADDRESS (D43).
 * - Production never runs an enabled channel on a fake adapter (it would record `sent` for nothing):
 *   email can only be enabled there with CHANNEL_EMAIL_ADAPTER=sendgrid and its keys, over https.
 * - All retries fit in {@link NOTIFICATION_RETRY_WINDOW_MS}.
 */
function channelProblems(config: Config): ConfigProblem[] {
  const problems: ConfigProblem[] = [];
  const missing = (keys: readonly ConfigKey[]) => keys.filter((key) => config[key] === undefined);
  for (const keys of [FCM_KEYS, APNS_KEYS]) {
    const absent = missing(keys);
    if (absent.length > 0 && absent.length < keys.length) {
      problems.push({ keys: absent, reason: `required together with ${keys.join(', ')}` });
    }
  }
  if (
    config.CHANNEL_PUSH_ADAPTER === 'real' &&
    missing(FCM_KEYS).length > 0 &&
    missing(APNS_KEYS).length > 0
  ) {
    problems.push({
      keys: [...FCM_KEYS, ...APNS_KEYS],
      reason: 'CHANNEL_PUSH_ADAPTER=real needs the FCM keys, the APNs keys, or both',
    });
  }
  if (config.CHANNEL_SMS_ADAPTER === 'twilio') {
    if (!config.CHANNEL_SMS_TWILIO_HOLD_LIFTED) {
      problems.push({
        keys: ['CHANNEL_SMS_ADAPTER'],
        reason:
          'twilio is refused while the Twilio hold is on (CHANNEL_SMS_TWILIO_HOLD_LIFTED is not true)',
      });
    }
    const absent = missing(TWILIO_KEYS);
    if (absent.length > 0) {
      problems.push({ keys: absent, reason: 'required when CHANNEL_SMS_ADAPTER=twilio' });
    }
  }
  if (config.CHANNEL_EMAIL_ADAPTER === 'sendgrid') {
    const absent = missing(SENDGRID_KEYS);
    if (absent.length > 0) {
      problems.push({ keys: absent, reason: 'required when CHANNEL_EMAIL_ADAPTER=sendgrid' });
    }
  }
  if (config.NODE_ENV === 'production') {
    if (config.CHANNEL_PUSH_ENABLED && config.CHANNEL_PUSH_ADAPTER === 'fake') {
      problems.push({
        keys: ['CHANNEL_PUSH_ENABLED'],
        reason: 'must be false when NODE_ENV=production and CHANNEL_PUSH_ADAPTER=fake',
      });
    }
    if (config.CHANNEL_SMS_ENABLED && config.CHANNEL_SMS_ADAPTER === 'fake') {
      problems.push({
        keys: ['CHANNEL_SMS_ENABLED'],
        reason: 'must be false when NODE_ENV=production and CHANNEL_SMS_ADAPTER=fake',
      });
    }
    if (config.CHANNEL_EMAIL_ENABLED && config.CHANNEL_EMAIL_ADAPTER === 'fake') {
      problems.push({
        keys: ['CHANNEL_EMAIL_ENABLED'],
        reason: 'must be false when NODE_ENV=production and CHANNEL_EMAIL_ADAPTER=fake',
      });
    }
    if (
      config.CHANNEL_EMAIL_ADAPTER === 'sendgrid' &&
      !config.SENDGRID_API_BASE_URL.startsWith('https:')
    ) {
      problems.push({
        keys: ['SENDGRID_API_BASE_URL'],
        reason: 'must be an https URL when NODE_ENV=production',
      });
    }
  }
  const totalBackoff =
    config.NOTIFICATIONS_RETRY_BASE_DELAY_MS * (2 ** config.NOTIFICATIONS_RETRY_ATTEMPTS - 1);
  if (totalBackoff > NOTIFICATION_RETRY_WINDOW_MS) {
    problems.push({
      keys: ['NOTIFICATIONS_RETRY_ATTEMPTS', 'NOTIFICATIONS_RETRY_BASE_DELAY_MS'],
      reason: `all retries must fit in ${NOTIFICATION_RETRY_WINDOW_MS / 1000} s (base * (2^attempts - 1))`,
    });
  }
  return problems;
}
