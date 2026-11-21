import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { sql } from 'drizzle-orm';
import type { Client, Pool } from 'pg';

import { DatabaseService } from '../../src/db/database.service';
import { OutboxRelay } from '../../src/jobs/outbox-relay.service';
import { createTestApp, type LogCapture } from '../../src/testing/test-app';
import { openTestClient } from '../support/database';

/**
 * Phase 7 gap 1: a Postgres connection reset while a client is CHECKED OUT of a pool (in a
 * transaction, or held) must not crash the process. Before the fix the client had no 'error'
 * listener, so node-postgres's 'error' event threw ("Unhandled 'error' event", ECONNRESET) and the
 * API died. The reset is forced with pg_terminate_backend from another connection on the local test
 * database. Expected: the process stays up, the in-flight work fails normally, a warn is logged
 * (no connection string), the broken client is discarded and the next query uses a new backend,
 * and /readyz is still 200.
 */

const LOST = 'postgres connection lost';

async function waitFor(check: () => boolean, what: string, ms = 5_000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function lostLogs(logs: LogCapture, pool: string): Record<string, unknown>[] {
  return logs.lines.filter((line) => line.msg === LOST && line.pool === pool);
}

describe('Postgres connection lost while checked out (Phase 7 gap 1)', () => {
  let app: NestFastifyApplication;
  let logs: LogCapture;
  let admin: Client;
  const unhandled: unknown[] = [];
  const onUncaught = (err: unknown): void => {
    unhandled.push(err);
  };

  beforeAll(async () => {
    process.on('uncaughtException', onUncaught);
    ({ app, logs } = await createTestApp());
    admin = await openTestClient();
  });

  afterAll(async () => {
    await admin.end();
    await app.close();
    process.off('uncaughtException', onUncaught);
  });

  async function terminate(pid: number): Promise<void> {
    const { rows } = await admin.query<{ ok: boolean }>('select pg_terminate_backend($1) as ok', [
      pid,
    ]);
    expect(rows[0].ok).toBe(true);
  }

  async function expectReady(): Promise<void> {
    let res = await app.inject({ method: 'GET', url: '/readyz' });
    for (let i = 0; i < 40 && res.statusCode !== 200; i++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      res = await app.inject({ method: 'GET', url: '/readyz' });
    }
    expect(res.statusCode).toBe(200);
  }

  /** This worker database's idle backends of one pool (other workers' databases are never touched). */
  async function idleBackends(applicationName: string): Promise<number[]> {
    const { rows } = await admin.query<{ pid: number }>(
      `select pid from pg_stat_activity where application_name = $1 and state = 'idle'
          and datname = current_database()`,
      [applicationName],
    );
    return rows.map((row) => row.pid);
  }

  it('API pool: a reset of a client idle in the pool is logged and the pool recovers', async () => {
    const database = app.get(DatabaseService);
    await database.ping(); // at least one connection, now idle in the pool
    const pids = await idleBackends('atlas-api');
    expect(pids.length).toBeGreaterThan(0);
    const before = lostLogs(logs, 'api').length;

    for (const pid of pids) await terminate(pid);
    await waitFor(() => lostLogs(logs, 'api').length >= before + pids.length, 'idle warns');
    expect(unhandled).toEqual([]);

    const [next] = await database.query<{ pid: number }>('select pg_backend_pid() as pid');
    expect(pids).not.toContain(next.pid);
    await expectReady();
  });

  it('outbox relay pool: a reset of its client while idle in the pool is logged and the relay recovers', async () => {
    const relay = app.get(OutboxRelay);
    await relay.flush();
    const pids = await idleBackends('atlas-outbox-relay');
    expect(pids).toHaveLength(1); // max 1
    const before = lostLogs(logs, 'outbox-relay').length;

    // The 1 s sweep timer may check the client out meanwhile: idle or checked out, both are safe.
    await terminate(pids[0]);
    await waitFor(() => lostLogs(logs, 'outbox-relay').length > before, 'the relay warn');
    expect(unhandled).toEqual([]);
    await expect(relay.flush()).resolves.toBeUndefined();
    expect(await idleBackends('atlas-outbox-relay')).not.toContain(pids[0]);
  });

  it('API pool: a reset during an idle-in-transaction checkout is logged, the transaction fails, the pool recovers', async () => {
    const database = app.get(DatabaseService);
    const before = lostLogs(logs, 'api').length;
    let resume!: () => void;
    const gate = new Promise<void>((resolve) => (resume = resolve));
    let gotPid!: (pid: number) => void;
    const pidReady = new Promise<number>((resolve) => (gotPid = resolve));

    const transaction = database.db.transaction(async (tx) => {
      const { rows } = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
      gotPid(rows[0].pid);
      await gate; // checked out, idle in transaction, no query in flight
      await tx.execute(sql`select 1`);
    });
    const outcome = transaction.then(
      () => 'committed',
      () => 'failed',
    );

    const pid = await pidReady;
    await terminate(pid);
    await waitFor(() => lostLogs(logs, 'api').length > before, 'the connection-lost warn');
    resume();

    expect(await outcome).toBe('failed');
    expect(unhandled).toEqual([]);

    const [next] = await database.query<{ pid: number }>('select pg_backend_pid() as pid');
    expect(next.pid).not.toBe(pid); // the broken client was discarded, not reused
    await expectReady();

    const line = lostLogs(logs, 'api').at(-1)!;
    expect(line.level).toBe('warn');
    const err = line.err as { code?: unknown; message?: unknown };
    expect(typeof err.code).toBe('string');
    expect(typeof err.message).toBe('string');
    expect(JSON.stringify(line)).not.toContain(process.env.DATABASE_URL!);
    expect(JSON.stringify(line)).not.toMatch(/postgres(ql)?:\/\//);
  });

  it('API pool: a reset during a running query rejects that query normally', async () => {
    const database = app.get(DatabaseService);
    const before = lostLogs(logs, 'api').length;
    const sleeping = database.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_sleep(30)`);
    });
    const outcome = sleeping.then(
      () => 'completed',
      () => 'failed',
    );

    let pid: number | undefined;
    for (let i = 0; i < 100 && pid === undefined; i++) {
      const { rows } = await admin.query<{ pid: number }>(
        `select pid from pg_stat_activity
          where application_name = 'atlas-api' and query like '%pg_sleep(30)%' and state = 'active'
            and datname = current_database()`,
      );
      pid = rows[0]?.pid;
      if (pid === undefined) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(pid).toBeDefined();
    await terminate(pid!);

    expect(await outcome).toBe('failed');
    await waitFor(() => lostLogs(logs, 'api').length > before, 'the connection-lost warn');
    expect(unhandled).toEqual([]);
    await expect(database.query('select 1 as one')).resolves.toEqual([{ one: 1 }]);
    await expectReady();
  });

  it('outbox relay pool (separate, max 1): a reset on a checked-out client is logged and the relay recovers', async () => {
    const relay = app.get(OutboxRelay);
    const pool = (relay as unknown as { pool: Pool }).pool;
    await relay.flush(); // no sweep running; the pool's only client is free
    const before = lostLogs(logs, 'outbox-relay').length;

    const client = await pool.connect();
    const { rows } = await client.query<{ pid: number }>('select pg_backend_pid() as pid');
    const pid = rows[0].pid;
    await client.query('begin');

    await terminate(pid);
    await waitFor(() => lostLogs(logs, 'outbox-relay').length > before, 'the relay warn');
    expect(unhandled).toEqual([]);
    await expect(client.query('select 1')).rejects.toThrow();
    client.release();

    const next = await pool.query<{ pid: number }>('select pg_backend_pid() as pid');
    expect(next.rows[0].pid).not.toBe(pid);
    await expect(relay.flush()).resolves.toBeUndefined();
    await expectReady();
  });
});
