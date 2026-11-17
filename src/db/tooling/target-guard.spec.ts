import {
  assertSafeTarget,
  describeTarget,
  formatTarget,
  UnsafeDatabaseTargetError,
} from './target-guard';

/** Fake credentials only; long and distinctive so a leak into a message is easy to detect. */
const USER = 'fake_user_SHOULD_NOT_PRINT';
const PASSWORD = 'fake-password-NEVER-PRINT';
const url = (hostPort: string, rest = '/atlas') =>
  `postgresql://${USER}:${PASSWORD}@${hostPort}${rest}`;

function refusal(databaseUrl: string, allowRemote = false): UnsafeDatabaseTargetError {
  try {
    assertSafeTarget(databaseUrl, allowRemote);
  } catch (error) {
    if (error instanceof UnsafeDatabaseTargetError) return error;
    throw error;
  }
  throw new Error('expected the guard to refuse');
}

describe('db target guard (API-100-03)', () => {
  it.each(['localhost:54329', '127.0.0.1:54329', '[::1]:54329', 'LOCALHOST:5432'])(
    'accepts the local host %s',
    (hostPort) => {
      expect(assertSafeTarget(url(hostPort), false).isLocal).toBe(true);
    },
  );

  it.each([
    'db.abcdefghijklmnop.supabase.co:5432',
    'aws-0-eu-west-1.pooler.supabase.com:6543',
    '10.0.0.5:5432',
    'localhost.evil.example:5432',
    '127.0.0.2:5432',
    'host.docker.internal:54329',
  ])('refuses the non-local host %s', (hostPort) => {
    const error = refusal(url(hostPort));
    expect(error.message).toMatch(/^Refusing to run against /);
  });

  it('never puts the user name or password in a refusal', () => {
    const error = refusal(url('db.abcdefghijklmnop.supabase.co:5432', '/postgres'));
    expect(error.message).toContain('db.abcdefghijklmnop.supabase.co:5432/postgres');
    expect(error.message).not.toContain(USER);
    expect(error.message).not.toContain(PASSWORD);
  });

  it('allows a remote host only with the explicit flag', () => {
    const target = assertSafeTarget(url('db.example.supabase.co:5432'), true);
    expect(target).toEqual({
      host: 'db.example.supabase.co',
      port: 5432,
      database: 'atlas',
      isLocal: false,
    });
  });

  it.each(['host', 'hostaddr', 'port', 'service'])(
    'refuses a local URL whose "%s" query parameter could redirect the connection',
    (param) => {
      const error = refusal(url('localhost:54329', `/atlas?${param}=db.example.supabase.co`));
      expect(error.message).toContain(`"${param}"`);
      expect(error.message).not.toContain(PASSWORD);
    },
  );

  it('refuses a URL without an explicit host (socket / PGHOST fallback)', () => {
    expect(() => assertSafeTarget('postgresql:///atlas', false)).toThrow(
      'DATABASE_URL must name a host explicitly.',
    );
  });

  it.each(['not a url', 'mysql://u:p@localhost/x', 'https://localhost/x'])(
    'refuses a malformed or non-postgres URL (%s)',
    (value) => {
      expect(() => assertSafeTarget(value, true)).toThrow(UnsafeDatabaseTargetError);
    },
  );

  it('formats targets as host:port/database with defaults', () => {
    expect(formatTarget(describeTarget('postgres://u:p@localhost'))).toBe(
      'localhost:5432/(default)',
    );
    expect(formatTarget(describeTarget('postgres://u:p@[::1]:54329/postgres'))).toBe(
      '[::1]:54329/postgres',
    );
  });
});
