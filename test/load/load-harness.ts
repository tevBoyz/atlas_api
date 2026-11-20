import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
import { startPostgres, startRedis } from '../support/global-setup';

/**
 * The shared load harness of `npm run load:incidents` (API-100-23 AC4) and `npm run load:circles`
 * (API-100-33): throwaway Postgres 17.11 + Redis containers (Testcontainers, random ports and
 * password; the local compose database is never touched), the BUILT app (`node dist/main.js`) on a
 * spare port with a clean environment and a random throwaway JWT secret, timed requests with
 * p50/p95/p99 per route, the app's error log lines, and cleanup (the app's own PID, both
 * containers).
 */

// --- measurements ---------------------------------------------------------------------------

export interface Sample {
  route: string;
  ms: number;
  ok: boolean;
}

export const samples: Sample[] = [];
export const failures: { route: string; status: number | string; code?: string }[] = [];

let baseUrl = '';

export interface RequestOptions {
  body?: unknown;
  /** Sends a fresh `Idempotency-Key`. */
  idempotent?: boolean;
  /** Extra headers (e.g. `x-forwarded-for` behind the trusted proxy). */
  headers?: Record<string, string>;
}

/**
 * One timed request. `token` null sends no Authorization header. `expected` is the status (or the
 * statuses) the scenario expects; anything else is a failure. Returns the parsed body, or null on a
 * failure.
 */
export async function request(
  route: string,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  token: string | null,
  expected: number | number[],
  options: RequestOptions = {},
): Promise<Record<string, unknown> | null> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (token) headers.authorization = `Bearer ${token}`;
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
    const ok = (Array.isArray(expected) ? expected : [expected]).includes(res.status);
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

export interface RouteStats {
  route: string;
  requests: number;
  errors: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export function stats(): RouteStats[] {
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

export function table(rows: RouteStats[]): string {
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

/** Runs `fn` at a fixed rate until `stopAt`; one call at a time (the next waits). */
export async function every(
  seconds: number,
  stopAt: number,
  fn: () => Promise<unknown>,
): Promise<void> {
  let next = performance.now();
  while (performance.now() < stopAt) {
    await fn();
    next += seconds * 1000;
    const wait = Math.min(next, stopAt) - performance.now();
    if (wait > 0) await sleep(wait);
  }
}

/** `--rate-limit-env RATE_LIMIT_X=1,...` (raises limits for one run only). */
export function parseRateLimitEnv(raw: string | undefined): Record<string, string> {
  const env: Record<string, string> = {};
  for (const pair of (raw ?? '').split(',').filter(Boolean)) {
    const [key, val] = pair.split('=');
    if (!/^RATE_LIMIT_[A-Z_]+$/.test(key) || !/^\d+$/.test(val ?? '')) {
      throw new Error('--rate-limit-env takes RATE_LIMIT_<NAME>=<integer>,...');
    }
    env[key] = val;
  }
  return env;
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

export async function stopApp(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise((done) => child.once('exit', done));
  child.kill();
  await Promise.race([exited, sleep(10_000)]);
}

export function errorLogLines(logFile: string): string[] {
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

export interface StartedApp {
  child: ChildProcess;
  logFile: string;
  /** Stops the app (its own PID) and flushes its log file. */
  stop: () => Promise<void>;
}

export interface LoadStack {
  /** A migration-role client on the throwaway database (seeding and row checks). */
  client: Client;
  /** Signs a throwaway test JWT for `sub`, accepted by the app of this run. */
  token: (sub: string) => Promise<string>;
  /** Starts the built app with the run's settings (plus `env`); resolves when /readyz is 200. */
  startApp: (env: Record<string, string>) => Promise<StartedApp>;
}

/**
 * Runs `body` against a fresh stack and always cleans up: the app (its own PID), the containers and
 * the temp directory. Returns the exit code `body` returns (1 on an error).
 */
export async function withLoadStack(body: (stack: LoadStack) => Promise<number>): Promise<number> {
  const mainJs = resolve('dist/main.js');
  if (!existsSync(mainJs)) throw new Error('dist/main.js not found: run `npm run build` first');

  const work = mkdtempSync(join(tmpdir(), 'atlas-load-'));
  const logFile = join(work, 'app.log');
  const containers: StartedTestContainer[] = [];
  let child: ChildProcess | undefined;
  let client: Client | undefined;
  try {
    const password = randomBytes(24).toString('hex');
    process.stderr.write('Starting throwaway Postgres and Redis containers...\n');
    const [postgres, redis] = await Promise.all([startPostgres(password), startRedis()]);
    containers.push(postgres, redis);
    const dbUrl = `postgresql://postgres:${password}@${postgres.getHost()}:${postgres.getMappedPort(5432)}/postgres`;
    const redisUrl = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}/0`;
    assertSafeTarget(dbUrl, false);

    client = new Client({ connectionString: dbUrl, application_name: 'atlas-load' });
    await client.connect();
    const silent = () => undefined;
    await applyBaseline(client, resolve('db/baseline'), silent);
    await runMigrations(client, resolve('db/migrations'), silent);
    const secret = randomBytes(32).toString('hex');

    const stack: LoadStack = {
      client,
      token: (sub) =>
        signTestToken({
          secret,
          expiresInSeconds: 3 * 3600,
          claims: { sub, iss: TEST_JWT_ISSUER, aud: TEST_JWT_AUDIENCE },
        }),
      startApp: async (env) => {
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
            ...env,
          }),
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout?.pipe(log);
        child.stderr?.pipe(log);
        process.stderr.write(
          `Built app (pid ${child.pid}) on port ${port}; waiting for /readyz...\n`,
        );
        const started = child;
        await waitUntilReady(baseUrl, started, 60_000);
        return {
          child: started,
          logFile,
          stop: async () => {
            await stopApp(started);
            await new Promise<void>((done) => log.end(done));
          },
        };
      },
    };
    return await body(stack);
  } finally {
    if (child) await stopApp(child);
    await client?.end().catch(() => undefined);
    process.stderr.write('Removing the load containers...\n');
    await Promise.all(containers.map((c) => c.stop({ remove: true, removeVolumes: true })));
    try {
      rmSync(work, { recursive: true, force: true });
    } catch {
      // a log file still open on Windows: the OS temp cleanup removes it
    }
  }
}
