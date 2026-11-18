import { isIP } from 'node:net';

import { z } from 'zod';

import { dataStoreProblems } from './data-store-guard';

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
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

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
  // Longest wait for Redis before the limiter lets the request through (fail open).
  RATE_LIMIT_REDIS_TIMEOUT_MS: integerInRange(1, 5_000).default(100),

  LOG_LEVEL: z.enum(LOG_LEVELS).default('info'),
  SENTRY_DSN: urlWithProtocol(['http:', 'https:']).optional(),
  OTEL_EXPORTER_OTLP_ENDPOINT: urlWithProtocol(['http:', 'https:']).optional(),
  GIT_COMMIT: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/i)
    .optional(),

  CHANNEL_PUSH_ENABLED: flag(),
  CHANNEL_SMS_ENABLED: flag(),
  CHANNEL_EMAIL_ENABLED: flag(),
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
  RATE_LIMIT_REDIS_TIMEOUT_MS: 'must be an integer from 1 to 5000',
  LOG_LEVEL: `must be one of ${LOG_LEVELS.join(', ')}`,
  SENTRY_DSN: 'must be an http(s) URL',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'must be an http(s) URL',
  GIT_COMMIT: 'must be a git commit hash (7-40 hex characters)',
  CHANNEL_PUSH_ENABLED: 'must be true or false',
  CHANNEL_SMS_ENABLED: 'must be true or false',
  CHANNEL_EMAIL_ENABLED: 'must be true or false',
};

/** Keys that must be set when NODE_ENV=production (optional in development/test for now). */
export const REQUIRED_IN_PRODUCTION = [
  'DATABASE_URL',
  'REDIS_URL',
  'SUPABASE_URL',
  'SUPABASE_JWT_ISSUER',
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
  }

  if (problems.length > 0 || !result.success) {
    throw new ConfigValidationError(problems);
  }
  return result.data;
}
