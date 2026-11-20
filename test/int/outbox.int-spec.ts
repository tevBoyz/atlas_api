import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { TestingModule } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import type { Client } from 'pg';

import { DatabaseService } from '../../src/db/database.service';
import { JobQueues } from '../../src/jobs/job-queues.service';
import { OUTBOX_TOPIC_HANDLERS, type OutboxTopicHandler } from '../../src/jobs/job-workers';
import { OUTBOX_QUEUE } from '../../src/jobs/jobs.constants';
import { type OutboxRow, OutboxWriter } from '../../src/jobs/outbox';
import { OutboxRelay } from '../../src/jobs/outbox-relay.service';
import { createTestApp, type LogCapture, withTestConfig } from '../../src/testing/test-app';
import { createTestWorker } from '../../src/testing/test-worker';
import { openTestClient } from '../support/database';

/**
 * Transactional outbox and BullMQ (API-100-45, D23): the row commits or rolls back with the domain
 * write; the relay publishes committed rows (job id = outbox id) and sets `published_at`;
 * re-publishing is harmless; delayed rows become delayed jobs; the `WORKER=1` module consumes them;
 * failed attempts are logged; several relays share the work.
 */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Timers far away: every sweep in this file is explicit (flush / kick). */
const CONFIG = { OUTBOX_RELAY_INTERVAL_MS: '60000', LOG_LEVEL: 'info' };

interface OutboxDbRow {
  id: string;
  topic: string;
  published_at: Date | null;
  attempts: number;
}

async function waitFor(check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await sleep(25);
  }
}

describe('notification outbox and BullMQ (API-100-45)', () => {
  let app: NestFastifyApplication;
  let client: Client;
  let worker: TestingModule;
  let workerLogs: LogCapture;
  const handled: OutboxRow[] = [];
  /** Replaced per test. */
  let handle: (row: OutboxRow) => Promise<void> = () => Promise.resolve();

  const handler: OutboxTopicHandler = {
    topics: ['incident.created', 'incident.renotified', 'incident.resolved'],
    async handle(row) {
      handled.push(row);
      await handle(row);
    },
  };

  beforeAll(async () => {
    ({ app } = await createTestApp({}, withTestConfig(CONFIG)));
    ({ worker, logs: workerLogs } = await createTestWorker((builder) =>
      withTestConfig(CONFIG)(builder).overrideProvider(OUTBOX_TOPIC_HANDLERS).useValue([handler]),
    ));
    client = await openTestClient();
  });

  afterAll(async () => {
    await client.end();
    await worker.close();
    await app.close();
  });

  beforeEach(() => {
    handled.length = 0;
    handle = () => Promise.resolve();
  });

  const outbox = () => app.get(OutboxWriter);
  const relay = () => app.get(OutboxRelay);
  const queue = () => app.get(JobQueues).queue(OUTBOX_QUEUE);

  async function insertCommitted(
    payload: Record<string, unknown> = { n: 1 },
    deliverInMs?: number,
  ): Promise<string> {
    return app.get(DatabaseService).db.transaction((tx) =>
      outbox().insert(tx, {
        topic: 'incident.created',
        aggregateId: null,
        payload: sql`${JSON.stringify(payload)}::jsonb`,
        deliverAt:
          deliverInMs === undefined
            ? undefined
            : sql`clock_timestamp() + make_interval(secs => ${deliverInMs / 1000}::float8)`,
      }),
    );
  }

  async function rowOf(id: string): Promise<OutboxDbRow | undefined> {
    const { rows } = await client.query<OutboxDbRow>(
      'select id, topic, published_at, attempts from public.notification_outbox where id = $1',
      [id],
    );
    return rows[0];
  }

  it('a rolled-back domain transaction leaves no outbox row and no job (DoD)', async () => {
    const before = await queue().getJobCounts();
    let insertedId: string | undefined;
    await expect(
      app.get(DatabaseService).db.transaction(async (tx) => {
        insertedId = await outbox().insert(tx, {
          topic: 'incident.created',
          aggregateId: null,
          payload: sql`'{"rolled_back":true}'::jsonb`,
        });
        throw new Error('domain write failed');
      }),
    ).rejects.toThrow('domain write failed');
    expect(insertedId).toBeDefined();
    expect(await rowOf(insertedId!)).toBeUndefined();
    await relay().flush();
    expect(await queue().getJob(insertedId!)).toBeUndefined();
    expect(await queue().getJobCounts()).toEqual(before);
    await sleep(300);
    expect(handled.find((row) => row.id === insertedId)).toBeUndefined();
  });

  it('a committed row is published once (job id = outbox id) and consumed by the worker', async () => {
    const id = await insertCommitted({ incident_id: 'x', n: 2 });
    expect((await rowOf(id))?.published_at).toBeNull();
    await relay().flush();
    const row = await rowOf(id);
    expect(row?.published_at).toBeInstanceOf(Date);
    expect(row?.attempts).toBe(1);
    const job = await queue().getJob(id);
    expect(job?.name).toBe('incident.created');
    expect(job?.data).toEqual({ outbox_id: id, topic: 'incident.created' });
    await waitFor(() => handled.some((r) => r.id === id));
    expect(handled.filter((r) => r.id === id)).toEqual([
      expect.objectContaining({
        id,
        topic: 'incident.created',
        aggregate_id: null,
        payload: { incident_id: 'x', n: 2 },
      }),
    ]);
  });

  it('kick() publishes right after a commit without waiting for the timer', async () => {
    const id = await insertCommitted();
    const started = Date.now();
    relay().kick();
    await waitFor(async () => (await rowOf(id))?.published_at !== null, 3_000);
    expect(Date.now() - started).toBeLessThan(3_000);
    await waitFor(() => handled.some((r) => r.id === id));
  });

  it('at-least-once: publishing the same row again adds no second job and no second handling', async () => {
    const id = await insertCommitted();
    await relay().flush();
    await waitFor(() => handled.some((r) => r.id === id));
    // A relay that crashed after adding the job but before writing published_at.
    await client.query('update public.notification_outbox set published_at = null where id = $1', [
      id,
    ]);
    await relay().flush();
    expect((await rowOf(id))?.attempts).toBe(2);
    await sleep(500);
    expect(handled.filter((r) => r.id === id)).toHaveLength(1);
  });

  it('delayed jobs (AC4): deliver_at in the future waits that long', async () => {
    const id = await insertCommitted({ delayed: true }, 1_500);
    const published = Date.now();
    await relay().flush();
    expect(await (await queue().getJob(id))?.getState()).toBe('delayed');
    await sleep(500);
    expect(handled.some((r) => r.id === id)).toBe(false);
    await waitFor(() => handled.some((r) => r.id === id), 10_000);
    expect(Date.now() - published).toBeGreaterThanOrEqual(1_200);
  });

  it('two relays (API and worker) share a backlog: every row published exactly once', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 250; i++) ids.push(await insertCommitted({ i }));
    await Promise.all([relay().flush(), worker.get(OutboxRelay).flush(), relay().flush()]);
    const { rows } = await client.query<{ published: number; attempts: number[] }>(
      `select count(*) filter (where published_at is not null)::int as published,
              array_agg(distinct attempts) as attempts
         from public.notification_outbox where id = any($1::uuid[])`,
      [ids],
    );
    expect(rows[0]).toEqual({ published: 250, attempts: [1] });
    await waitFor(() => ids.every((id) => handled.some((r) => r.id === id)), 20_000);
    expect(handled.filter((r) => ids.includes(r.id))).toHaveLength(250);
  });

  it('a failing consumer is retried and every failed attempt is logged (AC5), without row data', async () => {
    let calls = 0;
    handle = (row) => {
      if (row.payload.fail !== true) return Promise.resolve();
      calls += 1;
      return calls < 3
        ? Promise.reject(new Error('consumer failed for secret-payload-value'))
        : Promise.resolve();
    };
    const id = await insertCommitted({ fail: true, note: 'secret-payload-value' });
    await relay().flush();
    await waitFor(() => calls >= 3, 15_000);
    await waitFor(async () => (await (await queue().getJob(id))?.getState()) === 'completed');
    const failures = workerLogs.lines.filter(
      (line) => line.msg === 'job failed, will retry' && line.job_id === id,
    );
    expect(failures).toHaveLength(2);
    expect(failures[0]).toMatchObject({
      queue: 'notification-outbox',
      job_name: 'incident.created',
      error_code: 'internal_error',
    });
    expect(workerLogs.text).not.toContain('secret-payload-value');
    expect((await queue().getJob(id))?.failedReason ?? '').not.toContain('secret-payload-value');
  });

  it('an unknown topic completes with a warning (retrying cannot help)', async () => {
    const { rows } = await client.query<{ id: string }>(
      `insert into public.notification_outbox (topic, payload) values ('test.unknown_topic', '{}')
       returning id`,
    );
    const id = rows[0].id;
    await relay().flush();
    await waitFor(async () => (await (await queue().getJob(id))?.getState()) === 'completed');
    expect(workerLogs.lines).toContainEqual(
      expect.objectContaining({ msg: 'outbox topic without a handler', outbox_id: id }),
    );
  });

  it('the worker module runs without the HTTP server (WORKER=1 shape)', () => {
    const started = workerLogs.lines.find((line) => line.msg === 'job workers started');
    expect(started?.queues).toContain('notification-outbox');
  });
});
