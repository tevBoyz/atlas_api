import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';

import type { Client } from 'pg';

import { addActiveMember, createCircle, createUser, type UserFixture } from '../support/fixtures';
import {
  errorLogLines,
  failures,
  type LoadStack,
  logLines,
  parseRateLimitEnv,
  request,
  type RouteStats,
  samples,
  stats,
  table,
  withLoadStack,
} from './load-harness';

/**
 * `npm run build && npm run load:notifications [-- --residents <n>] [--members <n>]
 *  [--workers <n>] [--rounds <n>] [--baseline-main <path/to/old/dist/main.js>] [--out <file>]`
 * (API-100-49).
 *
 * Load check of the notification pipeline against the BUILT app, on the shared harness
 * (`load-harness.ts`: throwaway Postgres 17.11 + Redis containers, nothing from `.env`):
 *
 * 1. Seeds `--residents` (default 50) residents, each with `--members` (default 3) active members
 *    (the Phase 1 load check's shape).
 * 2. Starts the API (`node dist/main.js`) and `--workers` (default 2) worker processes
 *    (`WORKER=1`, same build), all with CHANNEL_PUSH_ENABLED=true on the FAKE push adapter (nothing
 *    leaves the processes), default retry settings and rate limits. Every member registers one
 *    device (`PUT /v1/me/devices/current`, a fake FCM token).
 * 3. `--rounds` (default 3) SOS bursts with the workers NOT started yet (`after, workers idle`: the
 *    request path alone, the outbox rows wait in the queue), then the workers start and drain that
 *    backlog, then `--rounds` more bursts while they fan out (`after, workers busy`). One burst:
 *    every resident submits at the same instant, then submits again at once (re-notify), then marks
 *    safe at once.
 * 4. Waits until every delivery row has an outcome, stops every process (its own PID), and checks:
 *    one outbox row per write, each published once; exactly one delivery row per recipient and
 *    outbox row, every one `sent` after one attempt, every provider message id distinct (no lost
 *    and no duplicate delivery); no app or worker error log line, no failed job; submit p99 under
 *    the 2 s budget.
 * 5. With `--baseline-main`, first runs the same bursts against that other build (the Phase 4
 *    release, without notifications) on its own fresh stack, and prints the submit / re-notify /
 *    mark-safe latencies side by side (API-100-48 AC3: "the HTTP response time of submit/mark safe
 *    is unaffected"). Phase 1's own figures (docs/phase1_handoff.md section 3) are printed for
 *    reference. On one machine the busy phase also shares CPU and the database with the workers.
 */

const PHASE1_SUBMIT_P95_MS = 628.5;
const PHASE1_MARK_SAFE_P95_MS = 218.0;
const SETTLE_TIMEOUT_MS = 120_000;
const ROUTES = ['submit', 're-notify', 'mark safe'] as const;

interface Options {
  residents: number;
  members: number;
  workers: number;
  rounds: number;
  baselineMain?: string;
  out?: string;
  rateLimitEnv: Record<string, string>;
}

function parseOptions(argv: string[]): Options {
  const value = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const int = (flag: string, fallback: number, min: number) => {
    const raw = value(flag);
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min) throw new Error(`${flag} must be an integer >= ${min}`);
    return n;
  };
  return {
    residents: int('--residents', 50, 1),
    members: int('--members', 3, 1),
    workers: int('--workers', 2, 1),
    rounds: int('--rounds', 3, 1),
    baselineMain: value('--baseline-main'),
    out: value('--out'),
    rateLimitEnv: parseRateLimitEnv(value('--rate-limit-env')),
  };
}

interface Party {
  resident: UserFixture;
  members: UserFixture[];
  tokens: Map<string, string>;
  incidentIds: string[];
}

async function seed(
  client: Client,
  o: Options,
  token: (sub: string) => Promise<string>,
): Promise<Party[]> {
  const parties: Party[] = [];
  for (let r = 0; r < o.residents; r++) {
    const resident = await createUser(client, { fullName: `Load Resident ${r + 1}` });
    const circle = await createCircle(client, resident);
    const members: UserFixture[] = [];
    for (let m = 0; m < o.members; m++) {
      const member = await createUser(client, { fullName: `Load Member ${r + 1}.${m + 1}` });
      await addActiveMember(client, circle, member);
      members.push(member);
    }
    const tokens = new Map<string, string>();
    for (const user of [resident, ...members]) tokens.set(user.id, await token(user.id));
    parties.push({ resident, members, tokens, incidentIds: [] });
  }
  return parties;
}

/** All parties run `step` at the same instant. */
async function burst(parties: Party[], step: (party: Party) => Promise<unknown>): Promise<void> {
  let release!: () => void;
  const start = new Promise<void>((done) => (release = done));
  const runs = parties.map(async (party) => {
    await start;
    await step(party);
  });
  release();
  await Promise.all(runs);
}

/** `--rounds` x (submit burst, re-notify burst, mark-safe burst). Routes are prefixed by `label`. */
async function sosRounds(parties: Party[], o: Options, label: string): Promise<void> {
  for (let round = 0; round < o.rounds; round++) {
    await burst(parties, async (party) => {
      const body = await request(
        `${label} submit`,
        'POST',
        '/v1/incidents',
        party.tokens.get(party.resident.id)!,
        201,
        { body: { emergency_type: 'medical' }, idempotent: true },
      );
      if (body) party.incidentIds.push(String(body.id));
    });
    await burst(parties, (party) =>
      request(
        `${label} re-notify`,
        'POST',
        '/v1/incidents',
        party.tokens.get(party.resident.id)!,
        200,
        { body: { emergency_type: 'medical' }, idempotent: true },
      ),
    );
    await burst(parties, (party) => {
      const id = party.incidentIds.at(-1);
      return id
        ? request(
            `${label} mark safe`,
            'POST',
            `/v1/incidents/${id}/mark-safe`,
            party.tokens.get(party.resident.id)!,
            200,
            { idempotent: true },
          )
        : Promise.resolve(null);
    });
    await sleep(1_000);
  }
}

interface Counts {
  outbox: number;
  unpublished: number;
  publish_attempts_over_1: number;
  deliveries: number;
  queued: number;
  sent: number;
  not_sent: number;
  attempts_over_1: number;
  distinct_provider_ids: number;
  duplicate_targets: number;
  last_sent_ms: number | null;
}

async function counts(client: Client, ids: string[], since: Date): Promise<Counts> {
  const { rows } = await client.query<Counts>(
    `with o as (
       select * from public.notification_outbox where aggregate_id = any($1::uuid[])
     ),
     d as (
       select d.* from public.notification_deliveries d join o on o.id = d.outbox_id
     )
     select (select count(*)::int from o) as outbox,
            (select count(*)::int from o where published_at is null) as unpublished,
            (select count(*)::int from o where attempts > 1) as publish_attempts_over_1,
            (select count(*)::int from d) as deliveries,
            (select count(*)::int from d where status = 'queued') as queued,
            (select count(*)::int from d where status = 'sent') as sent,
            (select count(*)::int from d where status not in ('queued', 'sent')) as not_sent,
            (select count(*)::int from d where attempts > 1) as attempts_over_1,
            (select count(distinct provider_message_id)::int from d) as distinct_provider_ids,
            (select count(*)::int from (
               select 1 from d group by outbox_id, recipient_user_id, channel, device_id
               having count(*) > 1) x) as duplicate_targets,
            (select (extract(epoch from max(sent_at) - $2::timestamptz) * 1000)::int from d)
              as last_sent_ms`,
    [ids, since.toISOString()],
  );
  return rows[0];
}

/** The same bursts against another build (no workers, no devices): latency only. */
async function baselineRun(o: Options): Promise<{ appErrors: number }> {
  let appErrors = 0;
  const code = await withLoadStack(
    async (stack: LoadStack) => {
      process.stderr.write(`[before] seeding ${o.residents} x ${o.members}...\n`);
      const parties = await seed(stack.client, o, stack.token);
      const app = await stack.startApp(o.rateLimitEnv);
      await sosRounds(parties, o, 'before');
      await app.stop();
      appErrors = errorLogLines(app.logFile).length;
      return 0;
    },
    { mainJs: o.baselineMain },
  );
  if (code !== 0) throw new Error('the baseline run failed');
  return { appErrors };
}

async function main(): Promise<void> {
  const o = parseOptions(process.argv.slice(2));
  const baseline = o.baselineMain ? await baselineRun(o) : undefined;

  const exitCode = await withLoadStack(async (stack) => {
    process.stderr.write(`[after] seeding ${o.residents} x ${o.members}...\n`);
    const parties = await seed(stack.client, o, stack.token);
    const env = { ...o.rateLimitEnv, CHANNEL_PUSH_ENABLED: 'true' };
    const app = await stack.startApp(env);
    const workers: Awaited<ReturnType<LoadStack['startWorker']>>[] = [];

    await burst(parties, async (party) => {
      for (const member of party.members) {
        await request(
          'PUT /v1/me/devices/current',
          'PUT',
          '/v1/me/devices/current',
          party.tokens.get(member.id)!,
          200,
          {
            headers: { 'x-atlas-installation-id': randomUUID() },
            body: {
              platform: 'android',
              app_version: '1.0.0',
              push_provider: 'fcm',
              push_token: `fake-load-${randomUUID()}`,
            },
          },
        );
      }
    });

    const { rows: clock } = await stack.client.query<{ now: Date }>('select now() as now');
    const burstAt = clock[0].now;
    const began = performance.now();
    process.stderr.write(
      `[after] ${o.rounds} SOS rounds with the workers idle, then ${o.rounds} while they fan out...\n`,
    );
    await sosRounds(parties, o, 'idle');
    for (let i = 0; i < o.workers; i++) workers.push(await stack.startWorker(env));
    // Let the workers drain the idle phase's backlog before the busy phase starts.
    const idleIds = parties.flatMap((p) => p.incidentIds);
    const drainDeadline = Date.now() + SETTLE_TIMEOUT_MS;
    for (;;) {
      const c = await counts(stack.client, idleIds, burstAt);
      if (c.deliveries >= idleIds.length * 3 * o.members && c.queued === 0) break;
      if (Date.now() > drainDeadline) break;
      await sleep(250);
    }
    await sosRounds(parties, o, 'busy');

    const ids = parties.flatMap((p) => p.incidentIds);
    const expectedOutbox = ids.length * 3;
    const expectedDeliveries = expectedOutbox * o.members;
    let current = await counts(stack.client, ids, burstAt);
    const deadline = Date.now() + SETTLE_TIMEOUT_MS;
    while (
      Date.now() < deadline &&
      (current.deliveries < expectedDeliveries || current.queued > 0 || current.unpublished > 0)
    ) {
      await sleep(250);
      current = await counts(stack.client, ids, burstAt);
    }
    const elapsed = (performance.now() - began) / 1000;
    // Let anything late (a duplicate send) land before the processes stop.
    await sleep(2_000);
    current = await counts(stack.client, ids, burstAt);

    await app.stop();
    for (const worker of workers) await worker.stop();

    const problems: string[] = [];
    const want = (label: string, actual: number, wanted: number) => {
      if (actual !== wanted) problems.push(`${label}: ${actual}, expected ${wanted}`);
    };
    want('incidents submitted', ids.length, parties.length * o.rounds * 2);
    want('outbox rows', current.outbox, expectedOutbox);
    want('unpublished outbox rows', current.unpublished, 0);
    want('outbox rows published more than once', current.publish_attempts_over_1, 0);
    want('delivery rows', current.deliveries, expectedDeliveries);
    want('deliveries sent', current.sent, expectedDeliveries);
    want('deliveries not sent', current.not_sent, 0);
    want('deliveries with more than one attempt', current.attempts_over_1, 0);
    want('distinct provider message ids', current.distinct_provider_ids, expectedDeliveries);
    want('duplicate delivery targets', current.duplicate_targets, 0);

    const appErrors = errorLogLines(app.logFile);
    const workerErrors = workers.flatMap((w) => errorLogLines(w.logFile));
    const failedJobs = workers
      .flatMap((w) => logLines(w.logFile))
      .filter((line) => typeof line.msg === 'string' && line.msg.startsWith('job failed')).length;
    const rows = stats();
    const route = (label: string, name: string): RouteStats | undefined =>
      rows.find((r) => r.route === `${label} ${name}`);
    const comparison = ROUTES.map((name) => ({
      route: name,
      before: route('before', name),
      after_workers_idle: route('idle', name),
      after_workers_busy: route('busy', name),
    }));
    const submit = route('busy', 'submit');
    const f = (n: number | undefined) => (n === undefined ? '-' : n.toFixed(1));
    const lines = [
      '| Route | Build | p50 ms | p95 ms | p99 ms | max ms |',
      '| --- | --- | --- | --- | --- | --- |',
      ...comparison.flatMap((c) =>
        (
          [
            ['before (Phase 4 build)', c.before],
            ['after, workers idle', c.after_workers_idle],
            ['after, workers busy', c.after_workers_busy],
          ] as const
        )
          .filter(([, r]) => r !== undefined)
          .map(
            ([build, r]) =>
              `| ${c.route} | ${build} | ${f(r?.p50)} | ${f(r?.p95)} | ${f(r?.p99)} | ${f(r?.max)} |`,
          ),
      ),
    ];
    const summary = {
      residents: o.residents,
      members_per_resident: o.members,
      workers: o.workers,
      rounds: o.rounds,
      baseline_main: o.baselineMain ?? null,
      requests: samples.length,
      errors: failures.length,
      failures: failures.slice(0, 50),
      routes: rows,
      comparison,
      counts: current,
      burst_to_all_settled_seconds: Number(elapsed.toFixed(2)),
      row_check_problems: problems,
      app_error_log_lines: appErrors.length,
      baseline_app_error_log_lines: baseline?.appErrors ?? null,
      worker_error_log_lines: workerErrors.length,
      failed_job_log_lines: failedJobs,
      phase1_reference_p95_ms: {
        submit: PHASE1_SUBMIT_P95_MS,
        mark_safe: PHASE1_MARK_SAFE_P95_MS,
      },
    };
    process.stdout.write(`${table(rows)}\n\n${lines.join('\n')}\n\n`);
    process.stdout.write(
      `Outbox ${current.outbox}/${expectedOutbox}, deliveries ${current.deliveries}/${expectedDeliveries} ` +
        `(sent ${current.sent}, other ${current.not_sent}, retried ${current.attempts_over_1}, ` +
        `duplicates ${current.duplicate_targets}), all settled ${elapsed.toFixed(1)} s after the first burst.\n` +
        `Phase 1 reference p95: submit ${PHASE1_SUBMIT_P95_MS} ms, mark safe ${PHASE1_MARK_SAFE_P95_MS} ms; ` +
        `p99 submit (workers busy) ${submit ? submit.p99.toFixed(1) : '-'} ms (budget 2000 ms).\n` +
        `Errors ${failures.length}, app error log lines ${appErrors.length}` +
        `${baseline ? ` (before: ${baseline.appErrors})` : ''}, worker error log lines ` +
        `${workerErrors.length}, failed job log lines ${failedJobs}, row check ` +
        `${problems.length ? problems.join('; ') : 'ok'}\n`,
    );
    if (o.out) writeFileSync(o.out, `${JSON.stringify(summary, null, 2)}\n`);
    return failures.length > 0 ||
      problems.length > 0 ||
      appErrors.length > 0 ||
      (baseline?.appErrors ?? 0) > 0 ||
      workerErrors.length > 0 ||
      failedJobs > 0 ||
      !submit ||
      !(submit.p99 < 2000)
      ? 1
      : 0;
  });
  process.exit(exitCode);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
