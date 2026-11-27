import { generateKeyPairSync } from 'node:crypto';

import { ConfigValidationError, parseConfig } from './config.schema';

/** A throwaway Ed25519 signing key generated at runtime (never key material in the repo). */
function throwawayKey(kid: string, withPrivate = true): Record<string, string> {
  const { privateKey } = generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' }) as Record<string, string>;
  if (!withPrivate) delete jwk.d;
  return { ...jwk, kid };
}
const AUTH_KEYS = JSON.stringify([throwawayKey('k1')]);

/** Fake values only. The secret is long and distinctive so leaks are easy to detect. */
const SECRET = 'fake-storage-key-0123456789-abcdefghij-SHOULD-NEVER-APPEAR';
const DB_URL = 'postgresql://fake_user:fake-db-password-NEVER-PRINT@localhost:5432/atlas';

/** Defaults of the rate limit settings (API-100-11 AC2). */
const RATE_LIMIT_DEFAULTS = {
  OPENAPI_ENABLED: true,
  RATE_LIMIT_AUTHENTICATED_MAX: 300,
  RATE_LIMIT_AUTHENTICATED_WINDOW_SECONDS: 60,
  RATE_LIMIT_PUBLIC_MAX: 60,
  RATE_LIMIT_PUBLIC_WINDOW_SECONDS: 300,
  RATE_LIMIT_LOCATION_PING_MAX: 30,
  RATE_LIMIT_LOCATION_PING_WINDOW_SECONDS: 60,
  RATE_LIMIT_EMERGENCY_WRITE_MAX: 30,
  RATE_LIMIT_EMERGENCY_WRITE_WINDOW_SECONDS: 60,
  RATE_LIMIT_AUTH_FAILURE_MAX: 120,
  RATE_LIMIT_AUTH_FAILURE_WINDOW_SECONDS: 60,
  RATE_LIMIT_AVATAR_UPLOAD_MAX: 20,
  RATE_LIMIT_AVATAR_UPLOAD_WINDOW_SECONDS: 3600,
  RATE_LIMIT_REDIS_TIMEOUT_MS: 100,
  REALTIME_ADAPTER_KEY: 'atlas:realtime',
  // Jobs and channels (API-100-45 to 47).
  WORKER: false,
  RUN_WORKERS: false,
  JOBS_QUEUE_PREFIX: 'atlas:jobs',
  JOBS_WORKER_CONCURRENCY: 10,
  OUTBOX_RELAY_INTERVAL_MS: 1000,
  OUTBOX_RELAY_BATCH_SIZE: 100,
  NOTIFICATIONS_RETRY_ATTEMPTS: 3,
  NOTIFICATIONS_RETRY_BASE_DELAY_MS: 2000,
  NOTIFICATIONS_SEND_TIMEOUT_MS: 10000,
  CHANNEL_PUSH_ADAPTER: 'fake',
  CHANNEL_SMS_ADAPTER: 'fake',
  CHANNEL_SMS_TWILIO_HOLD_LIFTED: false,
  CHANNEL_EMAIL_ADAPTER: 'fake',
  SENDGRID_API_BASE_URL: 'https://api.sendgrid.com',
  APNS_ENVIRONMENT: 'production',
  // Own auth (Phase 6).
  AUTH_JWT_ISSUER: 'atlas-api',
  AUTH_JWT_AUDIENCE: 'atlas-app',
  AUTH_ACCESS_TOKEN_TTL_SECONDS: 900,
  AUTH_JWT_CLOCK_SKEW_SECONDS: 30,
  AUTH_REFRESH_TOKEN_TTL_DAYS: 30,
  AUTH_SESSION_IDLE_DAYS: 7,
  AUTH_EMAIL_LINK_TTL_SECONDS: 300,
  AUTH_LINK_BASE: 'io.supabase.atlasmobile://login-callback/',
  AUTH_TEST_MAILBOX_ENABLED: false,
  GOOGLE_JWKS_URL: 'https://www.googleapis.com/oauth2/v3/certs',
  APPLE_SIGN_IN_ENABLED: false,
  APPLE_JWKS_URL: 'https://appleid.apple.com/auth/keys',
};

const PRODUCTION_ENV = {
  NODE_ENV: 'production',
  PORT: '8080',
  DATABASE_URL: DB_URL,
  DATABASE_POOL_MAX: '20',
  REDIS_URL: 'redis://localhost:6379',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_STORAGE_SERVICE_KEY: SECRET,
  AVATARS_BUCKET: 'avatars',
  INVITE_URL_BASE: 'io.supabase.atlasmobile://invite/',
  TRUST_PROXY: 'true',
  LOG_LEVEL: 'warn',
  SENTRY_DSN: 'https://public@sentry.example.com/1',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
  // An enabled channel on the fake adapter is refused in production (D24): see channel-config.spec.ts.
  CHANNEL_PUSH_ENABLED: 'false',
  CHANNEL_SMS_ENABLED: 'false',
  CHANNEL_EMAIL_ENABLED: 'FALSE',
  AUTH_JWT_KEYS: AUTH_KEYS,
  AUTH_JWT_ACTIVE_KID: 'k1',
};

function validationError(env: Record<string, unknown>): ConfigValidationError {
  try {
    parseConfig(env);
  } catch (error) {
    if (error instanceof ConfigValidationError) return error;
    throw error;
  }
  throw new Error('expected parseConfig to throw');
}

describe('parseConfig (API-100-02)', () => {
  describe('valid config', () => {
    it('parses a complete production config into typed values', () => {
      const config = parseConfig(PRODUCTION_ENV);
      expect(config).toEqual({
        ...RATE_LIMIT_DEFAULTS,
        ...PRODUCTION_ENV,
        PORT: 8080,
        DATABASE_POOL_MAX: 20,
        ALLOW_REMOTE_DATA_STORES: false,
        AVATAR_STORAGE: 'supabase',
        TRUST_PROXY: true,
        CHANNEL_PUSH_ENABLED: false,
        CHANNEL_SMS_ENABLED: false,
        CHANNEL_EMAIL_ENABLED: false,
      });
    });

    it('ignores the retired Supabase JWT settings (D76): no key, no requirement', () => {
      const config = parseConfig({
        ...PRODUCTION_ENV,
        SUPABASE_JWT_SECRET: 'x'.repeat(40),
        SUPABASE_JWT_ISSUER: 'https://example.supabase.co/auth/v1',
        SUPABASE_JWT_ACCEPT: 'true',
      });
      expect(Object.keys(config).filter((key) => key.startsWith('SUPABASE_JWT'))).toEqual([]);
    });

    it('ignores unrelated environment variables', () => {
      const config = parseConfig({ PATH: '/usr/bin', HOME: '/home/x' });
      expect(config).not.toHaveProperty('PATH');
      expect(config).not.toHaveProperty('HOME');
    });

    it.each([
      ['5', 5],
      ['10.0.0.1', ['10.0.0.1']],
      ['10.0.0.0/8, 127.0.0.1, ::1', ['10.0.0.0/8', '127.0.0.1', '::1']],
      ['FALSE', false],
    ])('parses TRUST_PROXY=%s', (raw, expected) => {
      expect(parseConfig({ TRUST_PROXY: raw }).TRUST_PROXY).toEqual(expected);
    });
  });

  describe('defaults', () => {
    it('applies defaults when nothing is set (development)', () => {
      expect(parseConfig({})).toEqual({
        ...RATE_LIMIT_DEFAULTS,
        NODE_ENV: 'development',
        PORT: 3000,
        DATABASE_POOL_MAX: 10,
        ALLOW_REMOTE_DATA_STORES: false,
        AVATARS_BUCKET: 'avatars',
        AVATAR_STORAGE: 'supabase',
        INVITE_URL_BASE: 'io.supabase.atlasmobile://invite/',
        TRUST_PROXY: false,
        LOG_LEVEL: 'info',
        CHANNEL_PUSH_ENABLED: false,
        CHANNEL_SMS_ENABLED: false,
        CHANNEL_EMAIL_ENABLED: false,
      });
    });

    it.each(['development', 'test'])(
      'does not require database, Redis or Supabase keys when NODE_ENV=%s',
      (nodeEnv) => {
        const config = parseConfig({ NODE_ENV: nodeEnv });
        expect(config.NODE_ENV).toBe(nodeEnv);
        expect(config.DATABASE_URL).toBeUndefined();
        expect(config.REDIS_URL).toBeUndefined();
        expect(config.SUPABASE_URL).toBeUndefined();
      },
    );
  });

  describe('empty strings count as unset', () => {
    it('applies the default for an empty or whitespace-only value', () => {
      const config = parseConfig({
        PORT: '',
        AVATARS_BUCKET: '   ',
        CHANNEL_PUSH_ENABLED: '',
        LOG_LEVEL: '',
        SENTRY_DSN: '',
      });
      expect(config.PORT).toBe(3000);
      expect(config.AVATARS_BUCKET).toBe('avatars');
      expect(config.CHANNEL_PUSH_ENABLED).toBe(false);
      expect(config.LOG_LEVEL).toBe('info');
      expect(config.SENTRY_DSN).toBeUndefined();
    });

    it('treats an empty required key as missing in production', () => {
      const error = validationError({ ...PRODUCTION_ENV, DATABASE_URL: '' });
      expect(error.keys).toEqual(['DATABASE_URL']);
      expect(error.message).toContain('DATABASE_URL: is required when NODE_ENV=production');
    });
  });

  describe('missing required keys (production)', () => {
    it.each(['DATABASE_URL', 'REDIS_URL', 'SUPABASE_URL', 'AUTH_JWT_KEYS'])(
      'fails naming %s when it is missing',
      (key) => {
        const env: Record<string, string> = { ...PRODUCTION_ENV };
        delete env[key];
        const error = validationError(env);
        expect(error.keys).toEqual([key]);
        expect(error.message).toContain(`${key}: is required when NODE_ENV=production`);
      },
    );

    it('reports every missing key at once', () => {
      const error = validationError({ NODE_ENV: 'production' });
      expect(error.keys).toEqual([
        'DATABASE_URL',
        'REDIS_URL',
        'SUPABASE_URL',
        'SUPABASE_STORAGE_SERVICE_KEY',
        'AUTH_JWT_KEYS',
        'AUTH_JWT_ACTIVE_KID',
      ]);
    });

    it('refuses the in-memory avatar storage in production (API-100-37)', () => {
      const error = validationError({ ...PRODUCTION_ENV, AVATAR_STORAGE: 'memory' });
      expect(error.keys).toEqual(['AVATAR_STORAGE']);
      expect(error.message).not.toContain('fake-storage-key');
      expect(parseConfig({ AVATAR_STORAGE: 'memory' }).AVATAR_STORAGE).toBe('memory');
      expect(validationError({ AVATAR_STORAGE: 's3' }).keys).toEqual(['AVATAR_STORAGE']);
    });
  });

  describe('own auth (Phase 6)', () => {
    it('accepts a key set with a verify-only (public) key next to the active one', () => {
      const keys = JSON.stringify([throwawayKey('old', false), throwawayKey('new')]);
      const config = parseConfig({ AUTH_JWT_KEYS: keys, AUTH_JWT_ACTIVE_KID: 'new' });
      expect(config.AUTH_JWT_ACTIVE_KID).toBe('new');
    });

    it.each([
      ['not JSON', '{nope', 'k1'],
      ['an empty array', '[]', 'k1'],
      ['an unknown active kid', AUTH_KEYS, 'k2'],
      ['an active key without d', JSON.stringify([throwawayKey('k1', false)]), 'k1'],
      ['a duplicated kid', JSON.stringify([throwawayKey('k1'), throwawayKey('k1')]), 'k1'],
      ['an RSA key', JSON.stringify([{ kty: 'RSA', kid: 'k1', n: 'AQAB', e: 'AQAB' }]), 'k1'],
      [
        'a private part of another key',
        JSON.stringify([{ ...throwawayKey('k1'), x: throwawayKey('k9').x }]),
        'k1',
      ],
    ])('refuses %s, naming the key only (never key material)', (_label, keys, kid) => {
      const error = validationError({ AUTH_JWT_KEYS: keys, AUTH_JWT_ACTIVE_KID: kid });
      expect(error.keys).toEqual(['AUTH_JWT_KEYS']);
      const parsed = JSON.parse(AUTH_KEYS) as Record<string, string>[];
      expect(error.message).not.toContain(parsed[0].d);
    });

    it('needs both AUTH_JWT_KEYS and AUTH_JWT_ACTIVE_KID', () => {
      expect(validationError({ AUTH_JWT_KEYS: AUTH_KEYS }).keys).toEqual(['AUTH_JWT_ACTIVE_KID']);
      expect(validationError({ AUTH_JWT_ACTIVE_KID: 'k1' }).keys).toEqual(['AUTH_JWT_KEYS']);
    });

    it('refuses the test mailbox in production, allows it elsewhere', () => {
      expect(
        validationError({ ...PRODUCTION_ENV, AUTH_TEST_MAILBOX_ENABLED: 'true' }).keys,
      ).toEqual(['AUTH_TEST_MAILBOX_ENABLED']);
      expect(parseConfig({ AUTH_TEST_MAILBOX_ENABLED: 'true' }).AUTH_TEST_MAILBOX_ENABLED).toBe(
        true,
      );
    });

    it('parses client id lists and the Apple switch', () => {
      const config = parseConfig({
        GOOGLE_CLIENT_IDS: ' web.apps.example , android.apps.example ',
      });
      expect(config.GOOGLE_CLIENT_IDS).toEqual(['web.apps.example', 'android.apps.example']);
      expect(validationError({ APPLE_SIGN_IN_ENABLED: 'true' }).keys).toEqual(['APPLE_CLIENT_IDS']);
    });
  });

  describe('invalid values', () => {
    it.each([
      ['NODE_ENV', 'staging'],
      ['PORT', 'abc'],
      ['PORT', '0'],
      ['PORT', '70000'],
      ['PORT', '3000.5'],
      ['DATABASE_POOL_MAX', '-1'],
      ['DATABASE_URL', 'not a url'],
      ['DATABASE_URL', 'mysql://localhost/atlas'],
      ['REDIS_URL', 'http://localhost:6379'],
      ['ALLOW_REMOTE_DATA_STORES', 'yes'],
      ['SUPABASE_URL', 'example.supabase.co'],
      ['AUTH_JWT_CLOCK_SKEW_SECONDS', '31'],
      ['AUTH_JWT_CLOCK_SKEW_SECONDS', '-1'],
      ['AVATARS_BUCKET', 'Has Spaces'],
      ['INVITE_URL_BASE', 'no-scheme'],
      ['TRUST_PROXY', 'yes'],
      ['TRUST_PROXY', '10.0.0.1/99'],
      ['LOG_LEVEL', 'verbose'],
      ['SENTRY_DSN', 'not-a-dsn'],
      ['OTEL_EXPORTER_OTLP_ENDPOINT', 'grpc:localhost'],
      ['GIT_COMMIT', 'not-a-sha'],
      ['CHANNEL_PUSH_ENABLED', 'yes'],
      ['CHANNEL_SMS_ENABLED', '1'],
      ['CHANNEL_EMAIL_ENABLED', 'on'],
    ])('rejects %s=%s naming the key', (key, value) => {
      const error = validationError({ ...PRODUCTION_ENV, [key]: value });
      expect(error.keys).toEqual([key]);
      expect(error.message).toMatch(new RegExp(`- ${key}: `));
    });

    it('reports several invalid keys at once', () => {
      const error = validationError({
        PORT: 'abc',
        LOG_LEVEL: 'loud',
        CHANNEL_SMS_ENABLED: 'maybe',
      });
      expect(error.keys).toEqual(['PORT', 'LOG_LEVEL', 'CHANNEL_SMS_ENABLED']);
    });
  });

  describe('never leaks values', () => {
    it('does not include an invalid secret value in the error', () => {
      const leaky = 'not-json-secret-LEAK';
      const error = validationError({ ...PRODUCTION_ENV, AUTH_JWT_KEYS: leaky });
      expect(error.message).toContain('AUTH_JWT_KEYS');
      expect(error.message).not.toContain(leaky);
      expect(error.stack).not.toContain(leaky);
      expect(JSON.stringify(error.problems)).not.toContain(leaky);
    });

    it('does not include any configured value when another key is invalid', () => {
      const badDbUrl = 'mysql://fake_user:fake-db-password-NEVER-PRINT@localhost/atlas';
      const error = validationError({ ...PRODUCTION_ENV, DATABASE_URL: badDbUrl, PORT: 'abc' });
      expect(error.keys).toEqual(['PORT', 'DATABASE_URL']);
      for (const value of [SECRET, badDbUrl, 'fake-db-password-NEVER-PRINT', 'abc']) {
        expect(error.message).not.toContain(value);
      }
    });
  });
});
