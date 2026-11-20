import {
  checkMigrationsApplied,
  READINESS_CHECK_TIMEOUT_MS,
  type ReadinessCheck,
  type ReadinessCheckName,
  ReadinessTimeoutError,
  runReadinessChecks,
  withTimeout,
} from './readiness';

const ok: ReadinessCheck = () => Promise.resolve();
const fail: ReadinessCheck = () => Promise.reject(new Error('connection refused'));
const hang: ReadinessCheck = () => new Promise<void>(() => undefined);

function checks(overrides: Partial<Record<ReadinessCheckName, ReadinessCheck>> = {}) {
  return { db: ok, redis: ok, migrations: ok, realtime: ok, jobs: ok, ...overrides };
}

describe('readiness checks (API-100-07)', () => {
  it('uses a short default timeout (1-2 s)', () => {
    expect(READINESS_CHECK_TIMEOUT_MS).toBeGreaterThanOrEqual(1_000);
    expect(READINESS_CHECK_TIMEOUT_MS).toBeLessThanOrEqual(2_000);
  });

  it('is ready when every check passes', async () => {
    await expect(runReadinessChecks(checks())).resolves.toEqual({
      ready: true,
      failed: [],
      reasons: {},
    });
  });

  it.each(['db', 'redis', 'migrations', 'realtime', 'jobs'] as const)(
    'reports only %s when only it fails',
    async (name) => {
      const report = await runReadinessChecks(checks({ [name]: fail }));
      expect(report.ready).toBe(false);
      expect(report.failed).toEqual([name]);
      expect(report.reasons[name]).toBe('connection refused');
    },
  );

  it('lists failures in the fixed order db, redis, migrations, realtime, jobs whatever finishes first', async () => {
    const late: ReadinessCheck = () =>
      new Promise((_, reject) => setTimeout(() => reject(new Error('late')), 30));
    const report = await runReadinessChecks(
      checks({ db: late, redis: fail, migrations: fail, realtime: fail, jobs: fail }),
    );
    expect(report.failed).toEqual(['db', 'redis', 'migrations', 'realtime', 'jobs']);
    const two = await runReadinessChecks(checks({ migrations: fail, db: late }));
    expect(two.failed).toEqual(['db', 'migrations']);
  });

  it('fails a check that does not answer within the timeout, and answers on time', async () => {
    const started = Date.now();
    const report = await runReadinessChecks(checks({ redis: hang }), 50);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(report.failed).toEqual(['redis']);
    expect(report.reasons.redis).toBe('timed out after 50 ms');
  });

  it('runs checks in parallel (total time is one timeout, not five)', async () => {
    const started = Date.now();
    const report = await runReadinessChecks(
      { db: hang, redis: hang, migrations: hang, realtime: hang, jobs: hang },
      100,
    );
    expect(Date.now() - started).toBeLessThan(290);
    expect(report.failed).toEqual(['db', 'redis', 'migrations', 'realtime', 'jobs']);
  });

  it('treats a synchronous throw as a failure', async () => {
    const throws: ReadinessCheck = () => {
      throw new Error('REDIS_URL is not set');
    };
    const report = await runReadinessChecks(checks({ redis: throws }));
    expect(report.failed).toEqual(['redis']);
    expect(report.reasons.redis).toBe('REDIS_URL is not set');
  });

  it('withTimeout rejects with ReadinessTimeoutError', async () => {
    await expect(withTimeout(hang, 10)).rejects.toBeInstanceOf(ReadinessTimeoutError);
    await expect(withTimeout(ok, 10)).resolves.toBeUndefined();
  });
});

describe('migrations check (API-100-07)', () => {
  it('passes without querying when no migrations are expected', async () => {
    const fetchApplied = jest.fn();
    await expect(checkMigrationsApplied([], fetchApplied)).resolves.toBeUndefined();
    expect(fetchApplied).not.toHaveBeenCalled();
  });

  it('passes when every expected migration is recorded', async () => {
    const fetchApplied = jest.fn().mockResolvedValue(['0002_b', '0001_a']);
    await expect(checkMigrationsApplied(['0001_a', '0002_b'], fetchApplied)).resolves.toBe(
      undefined,
    );
    expect(fetchApplied).toHaveBeenCalledWith(['0001_a', '0002_b']);
  });

  it('fails naming the migrations that are not recorded', async () => {
    const fetchApplied = jest.fn().mockResolvedValue(['0001_a']);
    await expect(checkMigrationsApplied(['0001_a', '0002_b'], fetchApplied)).rejects.toThrow(
      '1 migration(s) not applied: 0002_b',
    );
  });

  it('fails when the lookup fails (e.g. the table does not exist yet)', async () => {
    const fetchApplied = jest
      .fn()
      .mockRejectedValue(new Error('relation "public.api_schema_migrations" does not exist'));
    await expect(checkMigrationsApplied(['0001_a'], fetchApplied)).rejects.toThrow(
      'does not exist',
    );
  });
});
