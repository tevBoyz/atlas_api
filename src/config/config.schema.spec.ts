import { ConfigValidationError, parseConfig } from './config.schema';

/** Fake values only. The secret is long and distinctive so leaks are easy to detect. */
const SECRET = 'fake-jwt-secret-0123456789-abcdefghij-SHOULD-NEVER-APPEAR';
const DB_URL = 'postgresql://fake_user:fake-db-password-NEVER-PRINT@localhost:5432/atlas';

const PRODUCTION_ENV = {
  NODE_ENV: 'production',
  PORT: '8080',
  DATABASE_URL: DB_URL,
  DATABASE_POOL_MAX: '20',
  REDIS_URL: 'redis://localhost:6379',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_JWT_JWKS_URL: 'https://example.supabase.co/auth/v1/.well-known/jwks.json',
  SUPABASE_JWT_SECRET: SECRET,
  SUPABASE_JWT_ISSUER: 'https://example.supabase.co/auth/v1',
  SUPABASE_JWT_AUDIENCE: 'authenticated',
  SUPABASE_STORAGE_SERVICE_KEY: 'fake-storage-key',
  AVATARS_BUCKET: 'avatars',
  INVITE_URL_BASE: 'io.supabase.atlasmobile://invite/',
  TRUST_PROXY: 'true',
  LOG_LEVEL: 'warn',
  SENTRY_DSN: 'https://public@sentry.example.com/1',
  OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
  CHANNEL_PUSH_ENABLED: 'true',
  CHANNEL_SMS_ENABLED: 'false',
  CHANNEL_EMAIL_ENABLED: 'FALSE',
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
        ...PRODUCTION_ENV,
        PORT: 8080,
        DATABASE_POOL_MAX: 20,
        ALLOW_REMOTE_DATA_STORES: false,
        TRUST_PROXY: true,
        CHANNEL_PUSH_ENABLED: true,
        CHANNEL_SMS_ENABLED: false,
        CHANNEL_EMAIL_ENABLED: false,
      });
    });

    it('accepts production with only one Supabase JWT verifier (JWKS or secret)', () => {
      const jwksOnly: Record<string, string> = { ...PRODUCTION_ENV };
      delete jwksOnly.SUPABASE_JWT_SECRET;
      const secretOnly: Record<string, string> = { ...PRODUCTION_ENV };
      delete secretOnly.SUPABASE_JWT_JWKS_URL;
      expect(() => parseConfig(jwksOnly)).not.toThrow();
      expect(() => parseConfig(secretOnly)).not.toThrow();
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
        NODE_ENV: 'development',
        PORT: 3000,
        DATABASE_POOL_MAX: 10,
        ALLOW_REMOTE_DATA_STORES: false,
        SUPABASE_JWT_AUDIENCE: 'authenticated',
        AVATARS_BUCKET: 'avatars',
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
        expect(config.SUPABASE_JWT_JWKS_URL).toBeUndefined();
        expect(config.SUPABASE_JWT_SECRET).toBeUndefined();
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
    it.each(['DATABASE_URL', 'REDIS_URL', 'SUPABASE_URL', 'SUPABASE_JWT_ISSUER'])(
      'fails naming %s when it is missing',
      (key) => {
        const env: Record<string, string> = { ...PRODUCTION_ENV };
        delete env[key];
        const error = validationError(env);
        expect(error.keys).toEqual([key]);
        expect(error.message).toContain(`${key}: is required when NODE_ENV=production`);
      },
    );

    it('fails naming both JWT verifier keys when neither is set', () => {
      const env: Record<string, string> = { ...PRODUCTION_ENV };
      delete env.SUPABASE_JWT_JWKS_URL;
      delete env.SUPABASE_JWT_SECRET;
      const error = validationError(env);
      expect(error.keys).toEqual(['SUPABASE_JWT_JWKS_URL', 'SUPABASE_JWT_SECRET']);
      expect(error.message).toContain('SUPABASE_JWT_JWKS_URL or SUPABASE_JWT_SECRET');
    });

    it('reports every missing key at once', () => {
      const error = validationError({ NODE_ENV: 'production' });
      expect(error.keys).toEqual([
        'DATABASE_URL',
        'REDIS_URL',
        'SUPABASE_URL',
        'SUPABASE_JWT_ISSUER',
        'SUPABASE_JWT_JWKS_URL',
        'SUPABASE_JWT_SECRET',
      ]);
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
      ['SUPABASE_JWT_JWKS_URL', 'ftp://example.com/jwks'],
      ['SUPABASE_JWT_ISSUER', 'nope'],
      ['SUPABASE_JWT_SECRET', 'too-short'],
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
      const leaky = 'short-secret-LEAK';
      const error = validationError({ ...PRODUCTION_ENV, SUPABASE_JWT_SECRET: leaky });
      expect(error.message).toContain('SUPABASE_JWT_SECRET');
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
