import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

import type { Client } from 'pg';

import { createAuthUser } from '../support/profile-api';
import {
  errorLogLines,
  every,
  failures,
  parseRateLimitEnv,
  request,
  samples,
  stats,
  table,
  upload,
  withLoadStack,
} from './load-harness';

/**
 * `npm run build && npm run load:profiles [-- --users <n>] [--duration <s>] [--out <file.json>]
 *  [--rate-limit-env KEY=VALUE,...]` (API-100-38, Phase 3 hand-off timings).
 *
 * A light load check of the profile and settings routes against the BUILT app, on the shared harness
 * (`load-harness.ts`: throwaway Postgres 17.11 + Redis containers, `node dist/main.js` on a spare
 * port, throwaway JWT secret, DEFAULT rate limits). Profile photos go to the API's in-memory Storage
 * fake (`AVATAR_STORAGE=memory`): no Storage key, nothing leaves the machine.
 *
 * `--users` (default 60) new users (an Auth account, no profile), all at the same moment, as the
 * app's onboarding does:
 * 1. photo: upload URL, the bytes to the signed URL; Personal Info with that photo path; Profile;
 *    Emergency Info (every other user with Location Sharing off); Preferences; Complete; Profile;
 * 2. users with sharing off: Location Access On (P6) then Complete again (deferred creation);
 * 3. for `--duration` seconds (default 60): the Profile reload every 5 s, a share-flag change every
 *    15 s (Settings);
 * 4. Settings: Personal Info edit, a new photo (upload URL, bytes, `PUT /v1/me/profile/avatar`).
 *
 * Exit code 1 when any request got another status than the scenario expects, the rows are not what
 * it leaves behind, the app logged an error, or any route's p99 is not under the client's 15 s cap
 * (spec §7.8; the profile fetch cap is 15 s).
 */

interface Options {
  users: number;
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
    users: int('--users', 60, 1),
    durationSeconds: int('--duration', 60, 1),
    out: value('--out'),
    rateLimitEnv: parseRateLimitEnv(value('--rate-limit-env')),
  };
}

interface Person {
  id: string;
  token: string;
  /** Location Sharing off at onboarding (deferred circle creation). */
  deferred: boolean;
  /** The emergency contact's number (fictional: +44 7700 900xxx / +44 113 496 0xxx). */
  contactPhone: string;
}

const phoneOf = (n: number) =>
  n < 1000
    ? `+447700900${String(n).padStart(3, '0')}`
    : `+44113496${String(n - 1000).padStart(4, '0')}`;

async function seed(
  client: Client,
  o: Options,
  token: (sub: string) => Promise<string>,
): Promise<Person[]> {
  const people: Person[] = [];
  for (let i = 0; i < o.users; i++) {
    const id = randomUUID();
    await createAuthUser(client, id);
    people.push({ id, token: await token(id), deferred: i % 2 === 1, contactPhone: phoneOf(i) });
  }
  return people;
}

const flags = (on: boolean) => ({
  emergency_notes_shareable: on,
  share_emergency_contact_full_name: on,
  share_emergency_contact_relationship: on,
  share_emergency_contact_phone: false,
  share_emergency_contact_email: false,
  share_blood_type: on,
  share_allergies: on,
  share_medical_conditions: false,
  share_emergency_preferred_language: false,
});

/** Upload URL + the bytes to the signed URL; the object path, or null on a failure. */
async function photo(person: Person): Promise<string | null> {
  const signed = await request(
    'POST /v1/me/avatar/upload-url',
    'POST',
    '/v1/me/avatar/upload-url',
    person.token,
    200,
    { body: { content_type: 'image/jpeg', content_length: 48_000 } },
  );
  if (!signed) return null;
  const ok = await upload(
    'PUT <signed upload URL> (Storage fake)',
    signed.upload_url as string,
    signed.headers as Record<string, string>,
    Buffer.alloc(48_000, 5),
    200,
  );
  return ok ? (signed.object_path as string) : null;
}

async function runPerson(person: Person, start: Promise<void>, durationMs: number): Promise<void> {
  const t = person.token;
  await start;

  // 1. Onboarding.
  const first = await photo(person);
  await request('PUT /v1/me/profile/personal-info', 'PUT', '/v1/me/profile/personal-info', t, 200, {
    body: {
      full_name: 'Load Person',
      date_of_birth: '1991-03-04',
      gender: 'prefer_not_to_say',
      avatar_path: first,
    },
  });
  await request('GET /v1/me/profile', 'GET', '/v1/me/profile', t, 200);
  await request(
    'PUT /v1/me/profile/emergency-info',
    'PUT',
    '/v1/me/profile/emergency-info',
    t,
    200,
    {
      body: {
        emergency_contact_full_name: 'Load Contact',
        emergency_contact_relationship: 'friend',
        emergency_contact_phone: person.contactPhone,
        emergency_contact_email: null,
        blood_type: 'Unknown',
        allergies: 'None',
        medical_conditions: null,
        emergency_preferred_language: 'English',
        location_sharing_enabled: !person.deferred,
        emergency_notes: 'Load test',
        ...flags(false),
      },
    },
  );
  await request('PUT /v1/me/profile/preferences', 'PUT', '/v1/me/profile/preferences', t, 200, {
    body: {
      alert_push_enabled: true,
      alert_email_enabled: true,
      alert_sms_enabled: false,
      location_sharing_enabled: !person.deferred,
      hide_profile_from_non_members: false,
      app_language: 'en',
      timezone: 'Africa/Banjul',
      preferred_language: 'en',
    },
  });
  await request('POST /v1/me/profile/complete', 'POST', '/v1/me/profile/complete', t, 200);
  await request('GET /v1/me/profile', 'GET', '/v1/me/profile', t, 200);

  // 2. Deferred creation: Location Access On, then Complete again.
  if (person.deferred) {
    await request(
      'PATCH /v1/me/profile/location-sharing',
      'PATCH',
      '/v1/me/profile/location-sharing',
      t,
      200,
      { body: { enabled: true } },
    );
    await request('POST /v1/me/profile/complete', 'POST', '/v1/me/profile/complete', t, 200);
  }

  // 3. Steady state: profile reloads and an occasional share-flag change.
  const stopAt = performance.now() + durationMs;
  let toggle = false;
  await Promise.all([
    every(5, stopAt, () => request('GET /v1/me/profile', 'GET', '/v1/me/profile', t, 200)),
    every(15, stopAt, () => {
      toggle = !toggle;
      return request(
        'PATCH /v1/me/profile/sharing-flags',
        'PATCH',
        '/v1/me/profile/sharing-flags',
        t,
        200,
        { body: flags(toggle) },
      );
    }),
  ]);

  // 4. Settings: edit Personal Info, change the photo.
  await request('PUT /v1/me/profile/personal-info', 'PUT', '/v1/me/profile/personal-info', t, 200, {
    body: { full_name: 'Load Person Edited', date_of_birth: '1991-03-04' },
  });
  const second = await photo(person);
  await request('PUT /v1/me/profile/avatar', 'PUT', '/v1/me/profile/avatar', t, 200, {
    body: { object_path: second },
  });
}

/** What the scenario must leave behind, checked in the database. */
async function verifyRows(client: Client, people: Person[]): Promise<string[]> {
  const problems: string[] = [];
  const ids = people.map((p) => p.id);
  const one = async (sql: string) => (await client.query<{ n: number }>(sql, [ids])).rows[0].n;
  const expect = (label: string, actual: number, wanted: number) => {
    if (actual !== wanted) problems.push(`${label}: ${actual}, expected ${wanted}`);
  };
  const n = people.length;
  expect(
    'profiles with all four completion timestamps',
    await one(`select count(*)::int as n from public.profiles where id = any($1)
                 and personal_info_completed_at is not null and emergency_info_completed_at is not null
                 and preferences_completed_at is not null and profile_setup_completed_at is not null`),
    n,
  );
  expect(
    'profiles with the edited name and a new photo path',
    await one(`select count(*)::int as n from public.profiles where id = any($1)
                 and full_name = 'Load Person Edited' and avatar_path ~ '/avatar-[0-9a-f-]{36}[.]jpg$'`),
    n,
  );
  expect(
    'circles',
    await one('select count(*)::int as n from public.safety_circles where owner_id = any($1)'),
    n,
  );
  expect(
    'active owner rows with activated_at',
    await one(`select count(*)::int as n from public.safety_circle_members m
                 join public.safety_circles c on c.id = m.circle_id
                where c.owner_id = any($1) and m.role = 'owner' and m.status = 'active'
                  and m.activated_at is not null and m.user_id = c.owner_id`),
    n,
  );
  expect(
    'pending contact invites (7 days)',
    await one(`select count(*)::int as n from public.safety_circle_members m
                 join public.safety_circles c on c.id = m.circle_id
                where c.owner_id = any($1) and m.role = 'member' and m.status = 'pending'
                  and m.invite_expires_at > now() + interval '6 days'`),
    n,
  );
  return problems;
}

async function main(): Promise<void> {
  const o = parseOptions(process.argv.slice(2));
  const exitCode = await withLoadStack(async (stack) => {
    process.stderr.write(`Seeding ${o.users} new users (Auth accounts, no profile)...\n`);
    const people = await seed(stack.client, o, stack.token);
    const app = await stack.startApp({ AVATAR_STORAGE: 'memory', ...o.rateLimitEnv });
    const rateLimits = Object.keys(o.rateLimitEnv).length
      ? Object.entries(o.rateLimitEnv)
          .map(([k, v]) => `${k}=${v}`)
          .join(', ')
      : 'defaults (none raised)';
    process.stderr.write(
      `Load: ${o.users} users onboarding at once, ${o.durationSeconds} s of Settings and reloads; ` +
        `rate limits: ${rateLimits}\n`,
    );
    let release!: () => void;
    const start = new Promise<void>((done) => (release = done));
    const runs = people.map((person) => runPerson(person, start, o.durationSeconds * 1000));
    const began = performance.now();
    release();
    await Promise.all(runs);
    const elapsed = (performance.now() - began) / 1000;

    await app.stop();
    const problems = await verifyRows(stack.client, people);
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
            users: o.users,
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
