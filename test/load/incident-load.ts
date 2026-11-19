import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  createWriteStream,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';

import { Client } from 'pg';
import type { StartedTestContainer } from 'testcontainers';

import { applyBaseline } from '../../src/db/tooling/baseline';
import { runMigrations } from '../../src/db/tooling/migrate';
import { assertSafeTarget } from '../../src/db/tooling/target-guard';
import { TEST_JWT_AUDIENCE, TEST_JWT_ISSUER } from '../../src/testing/test-auth-config';
import { signTestToken } from '../../src/testing/test-tokens';
import { addActiveMember, createCircle, createUser, type UserFixture } from '../support/fixtures';
import { startPostgres, startRedis } from '../support/global-setup';

/**
 * `npm run build && npm run load:incidents [-- --duration <s>] [--residents <n>] [--members <n>]
 *  [--out <file.json>]` (API-100-23 AC4).
 *
 * Load check of the incident area against the BUILT app (`node dist/main.js`):
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
  const rateLimitEnv: Record<string, string> = {};
  for (const pair of (value('--rate-limit-env') ?? '').split(',').filter(Boolean)) {
    const [key, val] = pair.split('=');
    if (!/^RATE_LIMIT_[A-Z_]+$/.test(key) || !/^\d+$/.test(val ?? '')) {
      throw new Error('--rate-limit-env takes RATE_LIMIT_<NAME>=<integer>,...');
    }
    rateLimitEnv[key] = val;
  }
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

// --- measurements ---------------------------------------------------------------------------

interface Sample {
  route: string;
  ms: number;
  ok: boolean;
}

const samples: Sample[] = [];
const failures: { route: string; status: number | string; code?: string }[] = [];

let baseUrl = '';

async function request(
  route: string,
  method: 'GET' | 'POST',
  path: string,
  token: string,
  expected: number,
  options: { body?: unknown; idempotent?: boolean } = {},
): Promise<Record<string, unknown> | null> {
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.idempotent) headers['idempotency-key'] = randomUUID();
  const started = performance.now();
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text = await res.text();
    const ms = performance.now() - started;
    const ok = res.status === expected;
    samples.push({ route, ms, ok });
    const parsed = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    if (!ok) {
      const code = (parsed?.error as { code?: string } | undefined)?.code;
      failures.push({ route, status: res.status, code });
      return null;
    }
    return parsed;
  } catch (error) {
    samples.push({ route, ms: performance.now() - started, ok: false });
    failures.push({ route, status: (error as Error).name });
    return null;
  }
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

interface RouteStats {
  route: string;
  requests: number;
  errors: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

function stats(): RouteStats[] {
  const routes = [...new Set(samples.map((s) => s.route))];
  return routes.map((route) => {
    const own = samples.filter((s) => s.route === route);
    const ms = own.map((s) => s.ms).sort((a, b) => a - b);
    return {
      route,
      requests: own.length,
      errors: own.filter((s) => !s.ok).length,
      p50: percentile(ms, 0.5),
      p95: percentile(ms, 0.95),
      p99: percentile(ms, 0.99),
      max: ms[ms.length - 1],
    };
  });
}

// --- scenario ---------------------------------------------------------------------------------

interface Party {
  resident: UserFixture;
  members: UserFixture[];
  tokens: Map<string, string>;
  incidentId?: string;
}

/** Runs `fn` at a fixed rate until `stop` resolves; one call at a time (the next waits). */
async function every(seconds: number, stopAt: number, fn: () => Promise<unknown>): Promise<void> {
  let next = performance.now();
  while (performance.now() < stopAt) {
    await fn();
    next += seconds * 1000;
    const wait = Math.min(next, stopAt) - performance.now();
    if (wait > 0) await sleep(wait);
  }
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

// --- infrastructure ---------------------------------------------------------------------------

function spareTcpPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() =>
        typeof address === 'object' && address ? resolvePort(address.port) : reject(new Error()),
      );
    });
  });
}

/** Only what Node needs on this OS, plus the app's settings. Nothing inherited about the app. */
function appEnvironment(values: Record<string, string>): NodeJS.ProcessEnv {
  const keep = [
    'PATH',
    'Path',
    'PATHEXT',
    'SystemRoot',
    'SYSTEMROOT',
    'windir',
    'ComSpec',
    'TEMP',
    'TMP',
    'HOME',
    'USERPROFILE',
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const key of keep) if (process.env[key] !== undefined) env[key] = process.env[key];
  return { ...env, ...values };
}

async function waitUntilReady(url: string, child: ChildProcess, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`the app exited with code ${child.exitCode}`);
    try {
      const res = await fetch(`${url}/readyz`);
      if (res.status === 200) return;
    } catch {
      // not listening yet
    }
    await sleep(250);
  }
  throw new Error('the app did not become ready in time');
}

async function stopApp(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise((done) => child.once('exit', done));
  child.kill();
  await Promise.race([exited, sleep(10_000)]);
}

async function seed(client: Client, o: Options, secret: string): Promise<Party[]> {
  const parties: Party[] = [];
  const token = (sub: string) =>
    signTestToken({
      secret,
      expiresInSeconds: 3 * 3600,
      claims: { sub, iss: TEST_JWT_ISSUER, aud: TEST_JWT_AUDIENCE },
    });
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

function errorLogLines(logFile: string): string[] {
  return readFileSync(logFile, 'utf8')
    .split('\n')
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => {
      try {
        return JSON.parse(line) as { level?: number; msg?: string };
      } catch {
        return { level: 60, msg: 'unparseable log line' };
      }
    })
    .filter((entry) => (entry.level ?? 0) >= 50)
    .map((entry) => entry.msg ?? '');
}

function table(rows: RouteStats[]): string {
  const f = (n: number) => (Number.isFinite(n) ? n.toFixed(1) : '-');
  const lines = [
    '| Route | Requests | Errors | p50 ms | p95 ms | p99 ms | max ms |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map(
      (r) =>
        `| ${r.route} | ${r.requests} | ${r.errors} | ${f(r.p50)} | ${f(r.p95)} | ${f(r.p99)} | ${f(r.max)} |`,
    ),
  ];
  return lines.join('\n');
}

async function main(): Promise<void> {
  const o = parseOptions(process.argv.slice(2));
  const mainJs = resolve('dist/main.js');
  if (!existsSync(mainJs)) throw new Error('dist/main.js not found: run `npm run build` first');

  const work = mkdtempSync(join(tmpdir(), 'atlas-load-'));
  const logFile = join(work, 'app.log');
  const containers: StartedTestContainer[] = [];
  let child: ChildProcess | undefined;
  let exitCode = 0;
  try {
    const password = randomBytes(24).toString('hex');
    process.stderr.write('Starting throwaway Postgres and Redis containers...\n');
    const [postgres, redis] = await Promise.all([startPostgres(password), startRedis()]);
    containers.push(postgres, redis);
    const dbUrl = `postgresql://postgres:${password}@${postgres.getHost()}:${postgres.getMappedPort(5432)}/postgres`;
    const redisUrl = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}/0`;
    assertSafeTarget(dbUrl, false);

    const client = new Client({ connectionString: dbUrl, application_name: 'atlas-load' });
    await client.connect();
    try {
      const silent = () => undefined;
      await applyBaseline(client, resolve('db/baseline'), silent);
      await runMigrations(client, resolve('db/migrations'), silent);
      const secret = randomBytes(32).toString('hex');
      process.stderr.write(`Seeding ${o.residents} residents x ${o.members} members...\n`);
      const parties = await seed(client, o, secret);

      const port = await spareTcpPort();
      baseUrl = `http://127.0.0.1:${port}`;
      const log = createWriteStream(logFile);
      child = spawn(process.execPath, [mainJs], {
        cwd: work,
        env: appEnvironment({
          NODE_ENV: 'development',
          PORT: String(port),
          LOG_LEVEL: 'info',
          DATABASE_URL: dbUrl,
          REDIS_URL: redisUrl,
          SUPABASE_JWT_SECRET: secret,
          SUPABASE_JWT_ISSUER: TEST_JWT_ISSUER,
          SUPABASE_JWT_AUDIENCE: TEST_JWT_AUDIENCE,
          ...o.rateLimitEnv,
        }),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout?.pipe(log);
      child.stderr?.pipe(log);
      process.stderr.write(
        `Built app (pid ${child.pid}) on port ${port}; waiting for /readyz...\n`,
      );
      await waitUntilReady(baseUrl, child, 60_000);

      const rateLimits = Object.keys(o.rateLimitEnv).length
        ? Object.entries(o.rateLimitEnv)
            .map(([k, v]) => `${k}=${v}`)
            .join(', ')
        : 'defaults (none raised)';
      process.stderr.write(
        `Load: ${o.residents} residents, ${o.members} members each, ${o.durationSeconds} s, ` +
          `ping every ${o.pingSeconds} s, counts every ${o.pollSeconds} s; rate limits: ${rateLimits}\n`,
      );
      let release!: () => void;
      const start = new Promise<void>((done) => (release = done));
      const runs = parties.map((party) => runParty(party, start, o.durationSeconds * 1000, o));
      const began = performance.now();
      release();
      await Promise.all(runs);
      const elapsed = (performance.now() - began) / 1000;

      await stopApp(child);
      log.end();
      const problems = await verifyRows(client, parties, o);
      const appErrors = errorLogLines(logFile);
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
      process.stdout.write(`${table(rows)}\n\n`);
      process.stdout.write(
        `Requests ${samples.length} in ${elapsed.toFixed(1)} s, errors ${failures.length}, ` +
          `app error log lines ${appErrors.length}, row check ${problems.length ? problems.join('; ') : 'ok'}, ` +
          `p99 submit ${submit ? submit.p99.toFixed(1) : '-'} ms (budget 2000 ms)\n`,
      );
      if (o.out) writeFileSync(o.out, `${JSON.stringify(summary, null, 2)}\n`);
      if (
        failures.length > 0 ||
        problems.length > 0 ||
        appErrors.length > 0 ||
        !submit ||
        !(submit.p99 < 2000)
      ) {
        exitCode = 1;
      }
    } finally {
      await client.end();
    }
  } finally {
    if (child) await stopApp(child);
    process.stderr.write('Removing the load containers...\n');
    await Promise.all(containers.map((c) => c.stop({ remove: true, removeVolumes: true })));
    try {
      rmSync(work, { recursive: true, force: true });
    } catch {
      // a log file still open on Windows: the OS temp cleanup removes it
    }
  }
  process.exit(exitCode);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
