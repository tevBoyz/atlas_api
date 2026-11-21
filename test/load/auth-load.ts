import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

import { throwawayAuthKeys } from '../../src/testing/test-auth-keys';
import {
  errorLogLines,
  failures,
  request,
  samples,
  stats,
  table,
  withLoadStack,
} from './load-harness';

/**
 * `npm run build && npm run load:auth [-- --users <n>] [--out <file.json>]` (API-100-59, Phase 6
 * hand-off timings). On the shared harness (`load-harness.ts`: throwaway Postgres 17.11 + Redis,
 * the BUILT app on a spare port, nothing from `.env`), with throwaway signing keys generated at run
 * time, the fake email adapter on and the TEST-ONLY mailbox route (to follow the emailed links), and
 * DEFAULT rate limits (each simulated phone has its own client address, behind TRUST_PROXY).
 *
 * 1. sign-up burst: `--users` (default 100) sign-ups at once, then every confirmation link at once;
 * 2. login burst: every user signs in with the password at once (argon2id);
 * 3. refresh-rotation burst: every session refreshes 5 times in a row, all sessions at once;
 * 4. lockout under concurrency: 20 accounts get 12 wrong passwords each at the same instant (must end
 *    with exactly 5 failures and ONE lock each: 4 x 401 and 8 x 423), and 20 accounts get 4 at once
 *    (exactly 4 counted, none locked: no lost failure counts).
 *
 * Exit code 1 on any unexpected status, any row check problem, an error log line, or a p99 at or
 * above 2 s on sign-up, verify, login or refresh (the lockout bursts are timed, not budgeted).
 */
const REFRESHES = 5;
const PASSWORD = ['Load', 'Test', 'Pass', '1'].join('');

let ipCounter = 0;
/** A new private client address per simulated phone (10.x.y.z, behind TRUST_PROXY). */
const nextIp = () => {
  ipCounter += 1;
  return `10.${(ipCounter >> 16) & 255}.${(ipCounter >> 8) & 255}.${ipCounter & 255}`;
};
const device = { platform: 'android', app_version: '1.0.0' };

function option(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

interface Session {
  refresh_token: string;
  session_id: string;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const users = Number(option(argv, '--users') ?? 100);
  const out = option(argv, '--out');
  if (!Number.isInteger(users) || users < 40 || users > 1000) {
    throw new Error('--users must be an integer from 40 to 1000');
  }

  const exitCode = await withLoadStack(async (stack) => {
    const app = await stack.startApp({
      ...throwawayAuthKeys(['load-key-1']),
      CHANNEL_EMAIL_ENABLED: 'true',
      AUTH_TEST_MAILBOX_ENABLED: 'true',
      TRUST_PROXY: 'true',
    });
    const problems: string[] = [];
    const started = performance.now();
    const emails = Array.from({ length: users }, () => `load-${randomUUID()}@example.test`);
    const as = () => ({ headers: { 'x-forwarded-for': nextIp() } });

    // 1. Sign-up, then confirm.
    await Promise.all(
      emails.map((email, i) =>
        request('signup', 'POST', '/v1/auth/signup', null, 202, {
          ...as(),
          body: {
            email,
            password: PASSWORD,
            phone: `+447700900${String(i).padStart(3, '0')}`,
            full_name: 'Load Example',
            device,
          },
        }),
      ),
    );
    const tokens = await Promise.all(
      emails.map(async (email) => {
        const res = await fetch(`${app.url}/__test/auth-messages?to=${encodeURIComponent(email)}`);
        const body = (await res.json()) as { messages: { text: string }[] };
        return /token=([\w-]+)/.exec(body.messages.at(-1)?.text ?? '')?.[1];
      }),
    );
    if (tokens.some((t) => !t)) problems.push('a confirmation link is missing');
    await Promise.all(
      tokens.map((token) =>
        request('email verify', 'POST', '/v1/auth/email/verify', null, 200, {
          ...as(),
          body: { token, device },
        }),
      ),
    );

    // 2. Login burst.
    const sessions = (await Promise.all(
      emails.map((email) =>
        request('login', 'POST', '/v1/auth/login', null, 200, {
          ...as(),
          body: { email, password: PASSWORD, device },
        }),
      ),
    )) as unknown as (Session | null)[];

    // 3. Refresh rotation: each session refreshes in a row, all sessions at once.
    await Promise.all(
      sessions.map(async (session) => {
        let current = session;
        for (let i = 0; i < REFRESHES && current; i += 1) {
          current = (await request('refresh', 'POST', '/v1/auth/refresh', null, 200, {
            ...as(),
            body: { refresh_token: current.refresh_token },
          })) as unknown as Session | null;
        }
      }),
    );
    const live = sessions.filter((s): s is Session => s !== null).map((s) => s.session_id);
    const chains = await stack.client.query<{ tokens: number; unused: number; revoked: boolean }>(
      `select count(rt.id)::int as tokens, count(rt.id) filter (where rt.used_at is null)::int as unused,
              s.revoked_at is not null as revoked
         from public.device_sessions s join public.refresh_tokens rt on rt.session_id = s.id
        where s.id = any($1::uuid[]) group by s.id, s.revoked_at`,
      [live],
    );
    const badChains = chains.rows.filter(
      (c) => c.tokens !== REFRESHES + 1 || c.unused !== 1 || c.revoked,
    );
    if (badChains.length > 0) problems.push(`${badChains.length} refresh chains not as expected`);

    // 4. Lockout under concurrency (accounts of step 1).
    const lockAccounts = emails.slice(0, 20);
    const countAccounts = emails.slice(20, 40);
    const statusCounts = new Map<string, number[]>();
    const wrong = async (email: string, route: string) => {
      const ip = nextIp();
      const t0 = performance.now();
      const res = await fetch(`${app.url}/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
        body: JSON.stringify({ email, password: 'Wrong1234', device }),
      });
      await res.text();
      samples.push({
        route,
        ms: performance.now() - t0,
        ok: res.status === 401 || res.status === 423,
      });
      statusCounts.set(email, [...(statusCounts.get(email) ?? []), res.status]);
    };
    await Promise.all(
      lockAccounts.flatMap((email) =>
        Array.from({ length: 12 }, () => wrong(email, 'login wrong x12')),
      ),
    );
    await Promise.all(
      countAccounts.flatMap((email) =>
        Array.from({ length: 4 }, () => wrong(email, 'login wrong x4')),
      ),
    );
    for (const email of lockAccounts) {
      const codes = (statusCounts.get(email) ?? []).sort();
      const want = [...Array<number>(4).fill(401), ...Array<number>(8).fill(423)];
      if (JSON.stringify(codes) !== JSON.stringify(want))
        problems.push(`lock statuses ${codes.join(',')}`);
    }
    const rows = await stack.client.query<{
      email: string;
      failed_attempts: number;
      locked: boolean;
    }>(
      `select email, failed_attempts, locked_until > now() as locked from public.login_lockouts
        where email = any($1::text[])`,
      [[...lockAccounts, ...countAccounts]],
    );
    const byEmail = new Map(rows.rows.map((r) => [r.email, r]));
    for (const email of lockAccounts) {
      const r = byEmail.get(email);
      if (!r || r.failed_attempts !== 5 || !r.locked)
        problems.push('a locked account is not 5/locked');
    }
    for (const email of countAccounts) {
      const r = byEmail.get(email);
      if (!r || r.failed_attempts !== 4 || r.locked)
        problems.push('a counted account is not 4/unlocked');
    }

    const elapsed = (performance.now() - started) / 1000;
    const appErrors = errorLogLines(app.logFile);
    const routeStats = stats();
    // The lockout bursts (hundreds of argon2 checks at one instant on one machine) prove counting,
    // not latency: only the everyday routes have the 2 s budget.
    const slow = routeStats.filter((r) => !r.route.startsWith('login wrong') && !(r.p99 < 2_000));
    process.stdout.write(`${table(routeStats)}\n\n`);
    process.stdout.write(
      `Users ${users}, requests ${samples.length} in ${elapsed.toFixed(1)} s, errors ${failures.length}, ` +
        `app error log lines ${appErrors.length}, row check ${problems.length ? problems.slice(0, 5).join('; ') : 'ok'}, ` +
        `routes with p99 >= 2 s: ${slow.length}\n`,
    );
    if (failures.length) process.stdout.write(`${JSON.stringify(failures.slice(0, 20))}\n`);
    if (out) {
      writeFileSync(
        out,
        `${JSON.stringify(
          {
            users,
            refreshes_per_session: REFRESHES,
            elapsed_seconds: Number(elapsed.toFixed(1)),
            requests: samples.length,
            errors: failures.length,
            failures: failures.slice(0, 50),
            routes: routeStats,
            row_check_problems: problems,
            app_error_log_lines: appErrors.length,
          },
          null,
          2,
        )}\n`,
      );
    }
    return failures.length > 0 || problems.length > 0 || appErrors.length > 0 || slow.length > 0
      ? 1
      : 0;
  });
  process.exit(exitCode);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
