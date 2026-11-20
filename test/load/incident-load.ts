import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

import type { Client } from 'pg';

import { addActiveMember, createCircle, createUser, type UserFixture } from '../support/fixtures';
import {
  every,
  failures,
  parseRateLimitEnv,
  request,
  samples,
  stats,
  table,
  errorLogLines,
  withLoadStack,
} from './load-harness';

/**
 * `npm run build && npm run load:incidents [-- --duration <s>] [--residents <n>] [--members <n>]
 *  [--out <file.json>]` (API-100-23 AC4).
 *
 * Load check of the incident area against the BUILT app (`node dist/main.js`):
 *
 * The containers, the built app and the measurements are the shared harness (`load-harness.ts`).
 *
 * 1. Starts its own throwaway Postgres 17.11 (Supabase image + local shim) and Redis containers with
 *    Testcontainers (same images as compose and the test suites, random ports, random password), so
 *    the local compose database is never touched. Applies the baseline and the API migrations.
 * 2. Seeds `--residents` (default 50) residents with complete profiles, each with a circle of
 *    `--members` (default 3) active members.
 * 3. Starts `dist/main.js` on a spare port (asked from the OS) with a clean environment: a random
 *    throwaway JWT secret, the containers' URLs, NODE_ENV=development, default pool size and the
 *    DEFAULT rate limits (`--rate-limit-env KEY=VALUE,...` raises them for this run only). No `.env`
 *    is read (the app runs from an empty temp directory).
 * 4. All residents submit at once (`POST /v1/incidents`, Idempotency-Key), then each one, as the app
 *    does: reads the live-location config, pings `POST /v1/incidents/{id}/locations` every 12 s for
 *    `--duration` seconds (default 180), polls its delivery counts every 2 s; every member reads the
 *    responder list and the details once and polls the counts every 2 s; the first member
 *    acknowledges once. Then every resident marks safe (Idempotency-Key), reads the open incident
 *    (null), the recent list and the events.
 * 5. Stops the app (its own PID only), checks the rows in the database and the app's error log
 *    lines, prints p50/p95/p99 per route and the errors, and removes both containers.
 *
 * Exit code 1 when any request failed (unexpected status or network error), the rows are not what
 * the scenario leaves behind, the app logged an error, or p99 of the submit is not under 2 s.
 */

interface Options {
  residents: number;
  members: number;
  durationSeconds: number;
  pingSeconds: number;
  pollSeconds: number;
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
  const rateLimitEnv = parseRateLimitEnv(value('--rate-limit-env'));
  return {
    residents: int('--residents', 50, 1),
    members: int('--members', 3, 1),
    durationSeconds: int('--duration', 180, 1),
    pingSeconds: 12,
    pollSeconds: 2,
    out: value('--out'),
    rateLimitEnv,
  };
}

// --- scenario ---------------------------------------------------------------------------------

interface Party {
  resident: UserFixture;
  members: UserFixture[];
  tokens: Map<string, string>;
  incidentId?: string;
}

async function runParty(party: Party, start: Promise<void>, durationMs: number, o: Options) {
  const { resident, members, tokens } = party;
  const rt = tokens.get(resident.id)!;
  await start;
  const submitted = await request('POST /v1/incidents', 'POST', '/v1/incidents', rt, 201, {
    body: { emergency_type: 'medical' },
    idempotent: true,
  });
  if (!submitted) return;
  const id = String(submitted.id);
  party.incidentId = id;
  const stopAt = performance.now() + durationMs;

  const lat = 13.45 + Math.random() / 100;
  const lng = -16.58 + Math.random() / 100;
  const residentLoop = async () => {
    await request('GET /v1/config/live-location', 'GET', '/v1/config/live-location', rt, 200);
    await every(o.pingSeconds, stopAt, () =>
      request(
        'POST /v1/incidents/:id/locations',
        'POST',
        `/v1/incidents/${id}/locations`,
        rt,
        200,
        {
          body: {
            location_source: 'current',
            location_lat: lat + Math.random() / 10_000,
            location_lng: lng + Math.random() / 10_000,
            location_accuracy_m: 5 + Math.random() * 20,
            location_captured_at: new Date().toISOString(),
          },
        },
      ),
    );
  };
  const residentCounts = () =>
    every(o.pollSeconds, stopAt, () =>
      request(
        'GET /v1/incidents/:id/delivery-counts (resident)',
        'GET',
        `/v1/incidents/${id}/delivery-counts`,
        rt,
        200,
      ),
    );
  const memberLoop = async (member: UserFixture, acknowledges: boolean) => {
    const mt = tokens.get(member.id)!;
    await request('GET /v1/responder/incidents', 'GET', '/v1/responder/incidents', mt, 200);
    await request('GET /v1/incidents/:id', 'GET', `/v1/incidents/${id}`, mt, 200);
    let acked = !acknowledges;
    const ackAt = performance.now() + 10_000;
    await every(o.pollSeconds, stopAt, async () => {
      await request(
        'GET /v1/incidents/:id/delivery-counts (member)',
        'GET',
        `/v1/incidents/${id}/delivery-counts`,
        mt,
        200,
      );
      if (!acked && performance.now() >= ackAt) {
        acked = true;
        await request(
          'POST /v1/incidents/:id/acknowledge',
          'POST',
          `/v1/incidents/${id}/acknowledge`,
          mt,
          200,
        );
      }
    });
  };
  await Promise.all([
    residentLoop(),
    residentCounts(),
    ...members.map((member, i) => memberLoop(member, i === 0)),
  ]);

  await request(
    'POST /v1/incidents/:id/mark-safe',
    'POST',
    `/v1/incidents/${id}/mark-safe`,
    rt,
    200,
    {
      idempotent: true,
    },
  );
  await request('GET /v1/me/incidents/open', 'GET', '/v1/me/incidents/open', rt, 200);
  await request('GET /v1/me/incidents', 'GET', '/v1/me/incidents', rt, 200);
  await request('GET /v1/incidents/:id/events', 'GET', `/v1/incidents/${id}/events`, rt, 200);
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
    parties.push({ resident, members, tokens });
  }
  return parties;
}

/** What the scenario must leave behind, checked in the database. */
async function verifyRows(client: Client, parties: Party[], o: Options): Promise<string[]> {
  const problems: string[] = [];
  const ids = parties.map((p) => p.incidentId).filter((id): id is string => Boolean(id));
  if (ids.length !== parties.length) problems.push(`${parties.length - ids.length} submits failed`);
  const one = async (sql: string, params: unknown[] = []) =>
    (await client.query<{ n: number }>(sql, params)).rows[0].n;
  const residents = parties.map((p) => p.resident.id);
  const total = await one(
    'select count(*)::int as n from public.incidents where resident_id = any($1)',
    [residents],
  );
  const resolved = await one(
    `select count(*)::int as n from public.incidents
      where id = any($1) and status = 'resolved' and resolved_reason = 'safe'
        and location_sharing_ended_at is not null and location_source = 'current'`,
    [ids],
  );
  const deliveries = await one(
    'select count(*)::int as n from public.incident_deliveries where incident_id = any($1)',
    [ids],
  );
  const acks = await one(
    `select count(*)::int as n from public.incident_deliveries
      where incident_id = any($1) and acknowledged_at is not null`,
    [ids],
  );
  const events = await one(
    'select count(*)::int as n from public.incident_events where incident_id = any($1)',
    [ids],
  );
  const expect = (label: string, actual: number, wanted: number) => {
    if (actual !== wanted) problems.push(`${label}: ${actual}, expected ${wanted}`);
  };
  expect('incidents', total, parties.length);
  expect('resolved as safe with a stored fix', resolved, parties.length);
  expect('deliveries', deliveries, parties.length * o.members);
  expect('acknowledged deliveries', acks, parties.length);
  // alert_sent, location_sharing_started, then the four closure events.
  expect('events', events, parties.length * 6);
  return problems;
}

async function main(): Promise<void> {
  const o = parseOptions(process.argv.slice(2));
  const exitCode = await withLoadStack(async (stack) => {
    process.stderr.write(`Seeding ${o.residents} residents x ${o.members} members...
`);
    const parties = await seed(stack.client, o, stack.token);
    const app = await stack.startApp(o.rateLimitEnv);

    const rateLimits = Object.keys(o.rateLimitEnv).length
      ? Object.entries(o.rateLimitEnv)
          .map(([k, v]) => `${k}=${v}`)
          .join(', ')
      : 'defaults (none raised)';
    process.stderr.write(
      `Load: ${o.residents} residents, ${o.members} members each, ${o.durationSeconds} s, ` +
        `ping every ${o.pingSeconds} s, counts every ${o.pollSeconds} s; rate limits: ${rateLimits}
`,
    );
    let release!: () => void;
    const start = new Promise<void>((done) => (release = done));
    const runs = parties.map((party) => runParty(party, start, o.durationSeconds * 1000, o));
    const began = performance.now();
    release();
    await Promise.all(runs);
    const elapsed = (performance.now() - began) / 1000;

    await app.stop();
    const problems = await verifyRows(stack.client, parties, o);
    const appErrors = errorLogLines(app.logFile);
    const rows = stats();
    const submit = rows.find((r) => r.route === 'POST /v1/incidents');
    const summary = {
      residents: o.residents,
      members_per_resident: o.members,
      duration_seconds: o.durationSeconds,
      elapsed_seconds: Number(elapsed.toFixed(1)),
      requests: samples.length,
      errors: failures.length,
      failures: failures.slice(0, 50),
      rate_limits: rateLimits,
      routes: rows,
      row_check_problems: problems,
      app_error_log_lines: appErrors.length,
      submit_p99_ms: submit?.p99 ?? null,
    };
    process.stdout.write(`${table(rows)}

`);
    process.stdout.write(
      `Requests ${samples.length} in ${elapsed.toFixed(1)} s, errors ${failures.length}, ` +
        `app error log lines ${appErrors.length}, row check ${problems.length ? problems.join('; ') : 'ok'}, ` +
        `p99 submit ${submit ? submit.p99.toFixed(1) : '-'} ms (budget 2000 ms)
`,
    );
    if (o.out)
      writeFileSync(
        o.out,
        `${JSON.stringify(summary, null, 2)}
`,
      );
    return failures.length > 0 ||
      problems.length > 0 ||
      appErrors.length > 0 ||
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
