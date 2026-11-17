import { ConfigValidationError, parseConfig } from './config.schema';
import { dataStoreProblems } from './data-store-guard';

/** Fake values only. The password is distinctive so a leak is easy to detect. */
const PASSWORD = 'fake-remote-password-NEVER-PRINT';
const REMOTE_DB = `postgresql://fake_user.ref:${PASSWORD}@db.fakeproject.supabase.example:5432/postgres`;
const REMOTE_REDIS = `rediss://default:${PASSWORD}@cache.fake-redis.example:6380`;
const LOCAL_DB = 'postgresql://postgres:postgres@127.0.0.1:54329/postgres';
const LOCAL_REDIS = 'redis://127.0.0.1:63799';

function configError(env: Record<string, string>): ConfigValidationError {
  try {
    parseConfig(env);
  } catch (error) {
    if (error instanceof ConfigValidationError) return error;
    throw error;
  }
  throw new Error('expected parseConfig to throw');
}

describe('Data store production-safety guard (API-100-07)', () => {
  it.each(['development', 'test'])('accepts local URLs when NODE_ENV=%s', (nodeEnv) => {
    expect(() =>
      parseConfig({ NODE_ENV: nodeEnv, DATABASE_URL: LOCAL_DB, REDIS_URL: LOCAL_REDIS }),
    ).not.toThrow();
    expect(() =>
      parseConfig({
        NODE_ENV: nodeEnv,
        DATABASE_URL: 'postgres://u:p@localhost/atlas',
        REDIS_URL: 'redis://[::1]:6379',
      }),
    ).not.toThrow();
  });

  it.each(['development', 'test'])(
    'refuses a remote DATABASE_URL when NODE_ENV=%s, naming key and host only',
    (nodeEnv) => {
      const error = configError({ NODE_ENV: nodeEnv, DATABASE_URL: REMOTE_DB });
      expect(error.keys).toEqual(['DATABASE_URL']);
      expect(error.message).toContain('DATABASE_URL: points to the non-local host');
      expect(error.message).toContain('db.fakeproject.supabase.example');
      expect(error.message).toContain('ALLOW_REMOTE_DATA_STORES=true');
      expect(error.message).not.toContain(PASSWORD);
      expect(error.message).not.toContain('fake_user');
      expect(error.message).not.toContain(REMOTE_DB);
    },
  );

  it('refuses a remote REDIS_URL, naming key and host only', () => {
    const error = configError({ NODE_ENV: 'development', REDIS_URL: REMOTE_REDIS });
    expect(error.keys).toEqual(['REDIS_URL']);
    expect(error.message).toContain('cache.fake-redis.example');
    expect(error.message).not.toContain(PASSWORD);
    expect(error.message).not.toContain('default:');
  });

  it('reports both keys at once', () => {
    const error = configError({ DATABASE_URL: REMOTE_DB, REDIS_URL: REMOTE_REDIS });
    expect(error.keys).toEqual(['DATABASE_URL', 'REDIS_URL']);
  });

  it('refuses query parameters that can redirect the database connection', () => {
    const error = configError({
      DATABASE_URL:
        'postgresql://postgres:postgres@127.0.0.1:54329/postgres?host=db.remote.example',
    });
    expect(error.keys).toEqual(['DATABASE_URL']);
    expect(error.message).not.toContain('db.remote.example');
  });

  it('allows remote URLs with ALLOW_REMOTE_DATA_STORES=true', () => {
    const config = parseConfig({
      DATABASE_URL: REMOTE_DB,
      REDIS_URL: REMOTE_REDIS,
      ALLOW_REMOTE_DATA_STORES: 'true',
    });
    expect(config.ALLOW_REMOTE_DATA_STORES).toBe(true);
  });

  it('does not apply in production (hosted data stores are expected there)', () => {
    expect(
      dataStoreProblems({
        NODE_ENV: 'production',
        DATABASE_URL: REMOTE_DB,
        REDIS_URL: REMOTE_REDIS,
      }),
    ).toEqual([]);
  });

  it('has nothing to check when the URLs are unset', () => {
    expect(dataStoreProblems({ NODE_ENV: 'development' })).toEqual([]);
  });
});
