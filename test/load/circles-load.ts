import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

import type { Client } from 'pg';

import { createCircle, createUser, type UserFixture } from '../support/fixtures';
import {
  errorLogLines,
  every,
  failures,
  parseRateLimitEnv,
  request,
  samples,
  stats,
  table,
  withLoadStack,
} from './load-harness';

/**
 * `npm run build && npm run load:circles [-- --owners <n>] [--duration <s>] [--out <file.json>]
 *  [--rate-limit-env KEY=VALUE,...]` (API-100-33, Phase 2 hand-off timings).
 *
 * A light load check of the circles and invites routes against the BUILT app, on the shared harness
 * (`load-harness.ts`: throwaway Postgres 17.11 + Redis containers, `node dist/main.js` on a spare
 * port, throwaway JWT secret, DEFAULT rate limits). `TRUST_PROXY=127.0.0.1` and one
 * `x-forwarded-for` address per invitee, as behind the production proxy, so the public lookup is
 * limited per device rather than for everyone at once.
 *
 * `--owners` (default 40) owners, each with 4 invitees (two with an Auth phone, two by link), all
 * at the same moment, as the app does:
 * 1. Owner: My Safety Circle (`GET /v1/me/circle`, capacity), invites by phone (one), by batch (an
 *    invitee plus a number without an account), two links (each with an Idempotency-Key), reloads
 *    the circle.
 * 2. Invitees, while the owner resends then cancels the batch row of the number without an account:
 *    phone invitee 1 opens Incoming (claims), previews and accepts; phone invitee 2 opens Incoming
 *    and declines; link invitee 3 looks the link up (public), previews and accepts; link invitee 4
 *    does the same, opens joined circles and the member list, then leaves.
 * 3. For `--duration` seconds (default 60): the owner reloads My Safety Circle every 5 s, the two
 *    members reload joined circles and invitee 2 Incoming every 10 s.
 * 4. Owner: member list, removes invitee 3, capacity.
 *
 * Exit code 1 when any request got another status than the scenario expects, the rows are not what
 * it leaves behind, the app logged an error, or any route's p99 is not under the client's 15 s cap
 * (spec §7.8).
 */

interface Options {
  owners: number;
  durationSeconds: number;
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
    owners: int('--owners', 40, 1),
    durationSeconds: int('--duration', 60, 1),
    out: value('--out'),
    rateLimitEnv: parseRateLimitEnv(value('--rate-limit-env')),
  };
}

interface Invitee {
  user: UserFixture;
  token: string;
  /** The device's address behind the proxy. */
  ip: string;
}

interface Party {
  owner: UserFixture;
  ownerToken: string;
  circleId: string;
  invitees: Invitee[];
  /** The batch number without an account. */
  strangerPhone: string;
}

/** Fictional numbers: Ofcom's drama ranges (+44 7700 900xxx and +44 113 496 0xxx). */
const phoneOf = (n: number) =>
  n < 1000
    ? `+447700900${String(n).padStart(3, '0')}`
    : `+44113496${String(n - 1000).padStart(4, '0')}`;

async function seed(
  client: Client,
  o: Options,
  token: (sub: string) => Promise<string>,
): Promise<Party[]> {
  const parties: Party[] = [];
  let phone = 0;
  for (let p = 0; p < o.owners; p++) {
    const owner = await createUser(client, { fullName: `Load Owner ${p + 1}` });
    const circle = await createCircle(client, owner);
    const invitees: Invitee[] = [];
    for (let i = 0; i < 4; i++) {
      const user = await createUser(client, {
        fullName: `Load Invitee ${p + 1}.${i + 1}`,
        phone: i < 2 ? phoneOf(phone++) : undefined,
      });
      invitees.push({ user, token: await token(user.id), ip: `10.20.${p}.${i + 1}` });
    }
    parties.push({
      owner,
      ownerToken: await token(owner.id),
      circleId: circle.id,
      invitees,
      strangerPhone: phoneOf(phone++),
    });
  }
  return parties;
}

async function runParty(party: Party, start: Promise<void>, durationMs: number): Promise<void> {
  const { ownerToken: ot, circleId, invitees } = party;
  const [i1, i2, i3, i4] = invitees;
  await start;

  // 1. The owner opens My Safety Circle and invites.
  await request('GET /v1/me/circle', 'GET', '/v1/me/circle', ot, 200);
  await request('GET /v1/me/circle/capacity', 'GET', '/v1/me/circle/capacity', ot, 200);
  await request(
    'POST /v1/me/circle/invites/phone',
    'POST',
    '/v1/me/circle/invites/phone',
    ot,
    201,
    {
      body: { display_name: 'Phone Friend', phone: i1.user.phone, relationship: 'friend' },
      idempotent: true,
    },
  );
  const batch = await request(
    'POST /v1/me/circle/invites/phone/batch',
    'POST',
    '/v1/me/circle/invites/phone/batch',
    ot,
    200,
    {
      body: {
        invites: [
          { phone: i2.user.phone, display_name: 'Batch Friend' },
          { phone: party.strangerPhone, display_name: 'No Account' },
        ],
      },
      idempotent: true,
    },
  );
  const strangerRow = (batch?.created as { member_id: string; phone: string }[] | undefined)?.find(
    (row) => row.phone === party.strangerPhone,
  )?.member_id;
  const links: string[] = [];
  for (const name of ['Link Three', 'Link Four']) {
    const link = await request(
      'POST /v1/me/circle/invites/link',
      'POST',
      '/v1/me/circle/invites/link',
      ot,
      201,
      { body: { display_name: name }, idempotent: true },
    );
    links.push(typeof link?.invite_token === 'string' ? link.invite_token : 'missing');
  }
  await request('GET /v1/me/circle', 'GET', '/v1/me/circle', ot, 200);

  // 2. The invitees answer while the owner resends and cancels the stranger's invite.
  const xff = (invitee: Invitee) => ({ headers: { 'x-forwarded-for': invitee.ip } });
  const phoneInvitee = async (invitee: Invitee, accept: boolean) => {
    const list = await request('GET /v1/me/invites', 'GET', '/v1/me/invites', invitee.token, 200);
    const pending = (list as unknown as { invite_token: string | null }[] | null)?.find(
      (row) => row.invite_token,
    );
    const token = pending?.invite_token ?? 'missing';
    if (accept) {
      await request(
        'POST /v1/invites/:token/preview',
        'POST',
        `/v1/invites/${token}/preview`,
        invitee.token,
        200,
      );
      await request(
        'POST /v1/invites/:token/accept',
        'POST',
        `/v1/invites/${token}/accept`,
        invitee.token,
        200,
      );
    } else {
      await request(
        'POST /v1/invites/:token/decline',
        'POST',
        `/v1/invites/${token}/decline`,
        invitee.token,
        200,
      );
    }
  };
  const linkInvitee = async (invitee: Invitee, token: string, leave: boolean) => {
    await request(
      'GET /v1/invites/:token/status (public)',
      'GET',
      `/v1/invites/${token}/status`,
      null,
      200,
      xff(invitee),
    );
    await request(
      'POST /v1/invites/:token/preview',
      'POST',
      `/v1/invites/${token}/preview`,
      invitee.token,
      200,
    );
    await request(
      'POST /v1/invites/:token/accept',
      'POST',
      `/v1/invites/${token}/accept`,
      invitee.token,
      200,
    );
    if (leave) {
      await request(
        'GET /v1/me/joined-circles',
        'GET',
        '/v1/me/joined-circles',
        invitee.token,
        200,
      );
      await request(
        'GET /v1/circles/:circle_id/members (member)',
        'GET',
        `/v1/circles/${circleId}/members`,
        invitee.token,
        200,
      );
      await request(
        'POST /v1/circles/:circle_id/leave',
        'POST',
        `/v1/circles/${circleId}/leave`,
        invitee.token,
        200,
      );
    }
  };
  const ownerFollowUp = async () => {
    const row = strangerRow ?? 'missing';
    await request(
      'POST /v1/me/circle/invites/:member_id/resend',
      'POST',
      `/v1/me/circle/invites/${row}/resend`,
      ot,
      200,
    );
    await request(
      'POST /v1/me/circle/invites/:member_id/cancel',
      'POST',
      `/v1/me/circle/invites/${row}/cancel`,
      ot,
      200,
    );
  };
  await Promise.all([
    phoneInvitee(i1, true),
    phoneInvitee(i2, false),
    linkInvitee(i3, links[0], false),
    linkInvitee(i4, links[1], true),
    ownerFollowUp(),
  ]);

  // 3. Steady screens.
  const stopAt = performance.now() + durationMs;
  await Promise.all([
    every(5, stopAt, () => request('GET /v1/me/circle', 'GET', '/v1/me/circle', ot, 200)),
    ...[i1, i3].map((invitee) =>
      every(10, stopAt, () =>
        request('GET /v1/me/joined-circles', 'GET', '/v1/me/joined-circles', invitee.token, 200),
      ),
    ),
    every(10, stopAt, () => request('GET /v1/me/invites', 'GET', '/v1/me/invites', i2.token, 200)),
  ]);

  // 4. The owner removes invitee 3.
  const members = await request(
    'GET /v1/circles/:circle_id/members (owner)',
    'GET',
    `/v1/circles/${circleId}/members`,
    ot,
    200,
  );
  const i3Row = (
    members as unknown as { member_id: string; user_id: string | null }[] | null
  )?.find((row) => row.user_id === i3.user.id)?.member_id;
  await request(
    'DELETE /v1/circles/:circle_id/members/:member_id',
    'DELETE',
    `/v1/circles/${circleId}/members/${i3Row ?? 'missing'}`,
    ot,
    200,
  );
  await request('GET /v1/me/circle/capacity', 'GET', '/v1/me/circle/capacity', ot, 200);
}

/** What the scenario must leave behind, checked in the database. */
async function verifyRows(client: Client, parties: Party[]): Promise<string[]> {
  const problems: string[] = [];
  const circles = parties.map((p) => p.circleId);
  const count = async (where: string) =>
    (
      await client.query<{ n: number }>(
        `select count(*)::int as n from public.safety_circle_members m
          where m.circle_id = any($1) and ${where}`,
        [circles],
      )
    ).rows[0].n;
  const expect = (label: string, actual: number, wanted: number) => {
    if (actual !== wanted) problems.push(`${label}: ${actual}, expected ${wanted}`);
  };
  const n = parties.length;
  // owner + phone invitee 1 (active) + invitee 2 (declined) + the stranger's row (canceled).
  expect('member rows', await count('true'), n * 4);
  expect('owner rows', await count(`m.role = 'owner'`), n);
  expect(
    'active members (invitee 1)',
    await count(`m.role = 'member' and m.status = 'active' and m.activated_at is not null`),
    n,
  );
  expect('declined rows', await count(`m.status = 'declined'`), n * 2);
  expect('canceled by the owner', await count(`m.invite_canceled_at is not null`), n * 2);
  expect(
    'rows above 5 used',
    (
      await client.query<{ n: number }>(
        `select count(*)::int as n from (
           select m.circle_id from public.safety_circle_members m
            where m.circle_id = any($1) and m.role = 'member' and m.status = 'active'
            group by m.circle_id having count(*) > 5) x`,
        [circles],
      )
    ).rows[0].n,
    0,
  );
  return problems;
}

async function main(): Promise<void> {
  const o = parseOptions(process.argv.slice(2));
  const exitCode = await withLoadStack(async (stack) => {
    process.stderr.write(`Seeding ${o.owners} owners x 4 invitees...\n`);
    const parties = await seed(stack.client, o, stack.token);
    const app = await stack.startApp({ TRUST_PROXY: '127.0.0.1', ...o.rateLimitEnv });
    const rateLimits = Object.keys(o.rateLimitEnv).length
      ? Object.entries(o.rateLimitEnv)
          .map(([k, v]) => `${k}=${v}`)
          .join(', ')
      : 'defaults (none raised)';
    process.stderr.write(
      `Load: ${o.owners} owners, 4 invitees each, ${o.durationSeconds} s of screen reloads; ` +
        `rate limits: ${rateLimits}\n`,
    );
    let release!: () => void;
    const start = new Promise<void>((done) => (release = done));
    const runs = parties.map((party) => runParty(party, start, o.durationSeconds * 1000));
    const began = performance.now();
    release();
    await Promise.all(runs);
    const elapsed = (performance.now() - began) / 1000;

    await app.stop();
    const problems = await verifyRows(stack.client, parties);
    const appErrors = errorLogLines(app.logFile);
    const rows = stats();
    const slow = rows.filter((r) => !(r.p99 < 15_000));
    process.stdout.write(`${table(rows)}\n\n`);
    process.stdout.write(
      `Requests ${samples.length} in ${elapsed.toFixed(1)} s, errors ${failures.length}, ` +
        `app error log lines ${appErrors.length}, row check ${problems.length ? problems.join('; ') : 'ok'}, ` +
        `routes with p99 >= 15 s: ${slow.length}\n`,
    );
    if (failures.length) process.stdout.write(`${JSON.stringify(failures.slice(0, 20))}\n`);
    if (o.out) {
      writeFileSync(
        o.out,
        `${JSON.stringify(
          {
            owners: o.owners,
            invitees_per_owner: 4,
            duration_seconds: o.durationSeconds,
            elapsed_seconds: Number(elapsed.toFixed(1)),
            requests: samples.length,
            errors: failures.length,
            failures: failures.slice(0, 50),
            rate_limits: rateLimits,
            routes: rows,
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
