import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { PROFILE_COLUMNS } from '../../src/modules/profiles/profiles.repository';
import { createTestApp, withTestConfig } from '../../src/testing/test-app';
import { sqlAs } from '../support/circle-api';
import { openTestClient } from '../support/database';
import {
  addMedicalItem,
  asAppUser,
  completeSetup,
  createAuthUser,
  emergencyInfoBody,
  getProfile,
  patchLocationSharing,
  patchSharingFlags,
  personalInfoBody,
  preferencesBody,
  profileViaRls,
  putEmergencyInfo,
  putPersonalInfo,
  putPreferences,
} from '../support/profile-api';

/**
 * API-100-38 mixed writers (the app and the SQL functions share the database until the switch):
 *
 * 1. One onboarding + setup + Settings scenario four ways: (A) today's app path only (direct
 *    `profiles` writes through RLS, then `complete_profile_setup()`), (B) the API only, (C) the app's
 *    writes then the API's setup, (D) the API's writes then the SQL setup. The four end states are
 *    equal (profile, circle, owner row, contact invite), except what differs by design: the
 *    completion timestamps (the app writes its own clock and re-stamps them on every save; the API
 *    sets them once), compared as "set or not".
 * 2. A profile written by the app is read and updated by the API, and the reverse; the API's read
 *    equals the app's `select *` (keys, order, values).
 * 3. The SQL `complete_profile_setup()` after an API setup and the API's after an SQL setup leave
 *    the rows as they were (both idempotent on the other's result).
 */
type Body = Record<string, unknown>;

const CONTACT_PHONE = '+12015550166';

/** The Profile without the keys the app's `select *` does not have (`avatar_url`, SCRUM-21 lists). */
function withoutAvatarUrl(body: Body): Body {
  const copy = { ...body };
  delete copy.avatar_url;
  delete copy.allergy_items;
  delete copy.medical_condition_items;
  return copy;
}

describe('Phase 3 gate: mixed writers (API-100-38)', () => {
  let app: NestFastifyApplication;
  let client: Client;

  beforeAll(async () => {
    ({ app } = await createTestApp(
      {},
      withTestConfig({ RATE_LIMIT_AUTHENTICATED_MAX: '1000000' }),
    ));
    client = await openTestClient();
  });

  afterAll(async () => {
    await client?.end();
    await app?.close();
  });

  const personal = personalInfoBody({ full_name: 'Mixed Writer', gender: 'male' });
  const emergency = emergencyInfoBody({
    emergency_contact_phone: CONTACT_PHONE,
    emergency_contact_email: null,
    share_allergies: true,
  });
  const prefs = preferencesBody({ preferred_language: 'mnk' });

  /** Today's app: UPSERT on id and two UPDATEs through RLS, each with its client completion time. */
  async function appWrites(id: string) {
    await asAppUser(
      client,
      id,
      `insert into public.profiles (id, full_name, date_of_birth, gender, avatar_path, personal_info_completed_at)
       values ($1, $2, $3, $4, null, now())
       on conflict (id) do update set full_name = excluded.full_name, date_of_birth = excluded.date_of_birth,
         gender = excluded.gender, avatar_path = excluded.avatar_path,
         personal_info_completed_at = excluded.personal_info_completed_at`,
      [id, personal.full_name, personal.date_of_birth, personal.gender],
    );
    const e = Object.entries(emergency);
    await asAppUser(
      client,
      id,
      `update public.profiles set ${e.map(([c], i) => `${c} = $${i + 2}`).join(', ')},
         emergency_info_completed_at = now() where id = $1`,
      [id, ...e.map(([, v]) => v)],
    );
    const p = Object.entries(prefs);
    await asAppUser(
      client,
      id,
      `update public.profiles set ${p.map(([c], i) => `${c} = $${i + 2}`).join(', ')},
         preferences_completed_at = now() where id = $1`,
      [id, ...p.map(([, v]) => v)],
    );
  }

  async function apiWrites(id: string) {
    expect((await putPersonalInfo(app, id, personal)).statusCode).toBe(200);
    expect((await putEmergencyInfo(app, id, emergency)).statusCode).toBe(200);
    // SCRUM-21 (D51): the API writes allergies / conditions as items (the PUT ignores the text);
    // the old text columns then hold the same values as the app's direct write.
    expect(
      (await addMedicalItem(app, id, 'allergies', { text: emergency.allergies })).statusCode,
    ).toBe(200);
    expect(
      (await addMedicalItem(app, id, 'medical-conditions', { text: emergency.medical_conditions }))
        .statusCode,
    ).toBe(200);
    expect((await putPreferences(app, id, prefs)).statusCode).toBe(200);
  }

  const sqlSetup = (id: string) => sqlAs<Body>(client, id, 'public.complete_profile_setup()');
  const apiSetup = async (id: string) => {
    const reply = await completeSetup(app, id);
    expect(reply.statusCode).toBe(200);
    return reply.json<Body>();
  };

  /** The end state, comparable across users. */
  async function endState(id: string) {
    const profile = (
      await client.query<Body>(
        'select p.*, p.date_of_birth::text as date_of_birth from public.profiles p where id = $1',
        [id],
      )
    ).rows[0];
    const out: Body = {};
    for (const column of PROFILE_COLUMNS) {
      // `medical_info_updated_at` is owned by the API (SCRUM-21, D51): the app's writes never set it.
      if (['id', 'created_at', 'updated_at', 'medical_info_updated_at'].includes(column)) continue;
      out[column] = column.endsWith('_completed_at') ? profile[column] !== null : profile[column];
    }
    const circles = (
      await client.query<Body>('select name from public.safety_circles where owner_id = $1', [id])
    ).rows;
    const members = (
      await client.query<Body>(
        `select m.role, m.status, m.display_name, m.relationship, m.phone, m.email,
                m.user_id = $1 as is_caller, m.invite_token ~ '^[0-9a-f]{64}$' as token_ok,
                m.invite_expires_at - m.invited_at as lifetime, m.invite_canceled_at is null as not_canceled,
                m.invite_consumed_at is null as not_consumed, m.activated_at is not null as activated
           from public.safety_circle_members m
           join public.safety_circles c on c.id = m.circle_id
          where c.owner_id = $1
          order by m.role desc, m.phone`,
        [id],
      )
    ).rows;
    return { profile: out, circles, members };
  }

  const newUser = async () => {
    const id = randomUUID();
    await createAuthUser(client, id);
    return id;
  };

  it('onboarding + setup + Settings four ways (SQL only, API only, mixed both ways): the same end state', async () => {
    const ways = {
      sqlOnly: async (id: string) => {
        await appWrites(id);
        await sqlSetup(id);
        await asAppUser(
          client,
          id,
          'update public.profiles set share_blood_type = true where id = $1',
          [id],
        );
        await sqlSetup(id);
      },
      apiOnly: async (id: string) => {
        await apiWrites(id);
        await apiSetup(id);
        await patchSharingFlags(app, id, { share_blood_type: true });
        await apiSetup(id);
      },
      appThenApi: async (id: string) => {
        await appWrites(id);
        await apiSetup(id);
        await patchSharingFlags(app, id, { share_blood_type: true });
        await sqlSetup(id);
      },
      apiThenSql: async (id: string) => {
        await apiWrites(id);
        await sqlSetup(id);
        await asAppUser(
          client,
          id,
          'update public.profiles set share_blood_type = true where id = $1',
          [id],
        );
        await apiSetup(id);
      },
    };
    const states: Record<string, unknown> = {};
    for (const [name, run] of Object.entries(ways)) {
      const id = await newUser();
      await run(id);
      states[name] = await endState(id);
    }
    expect(states.apiOnly).toEqual(states.sqlOnly);
    expect(states.appThenApi).toEqual(states.sqlOnly);
    expect(states.apiThenSql).toEqual(states.sqlOnly);
    expect((states.sqlOnly as { members: Body[] }).members).toHaveLength(2);
  });

  it('deferred creation both ways: sharing off, complete, on, complete (SQL vs API) give the same rows', async () => {
    const run = async (useApi: boolean) => {
      const id = await newUser();
      await apiWrites(id);
      await patchLocationSharing(app, id, { enabled: false });
      const off = useApi ? await apiSetup(id) : await sqlSetup(id);
      expect(off).toMatchObject({ circle_id: null, location_sharing_enabled: false });
      if (useApi) await patchLocationSharing(app, id, { enabled: true });
      else
        await asAppUser(
          client,
          id,
          'update public.profiles set location_sharing_enabled = true where id = $1',
          [id],
        );
      const on = useApi ? await apiSetup(id) : await sqlSetup(id);
      expect(on.profile_setup_completed_at).toBe(off.profile_setup_completed_at);
      return endState(id);
    };
    expect(await run(true)).toEqual(await run(false));
  });

  it('a profile written by the app is read and updated by the API, and the reverse', async () => {
    const a = await newUser();
    await appWrites(a);
    expect(JSON.stringify(withoutAvatarUrl((await getProfile(app, a)).json<Body>()))).toBe(
      await profileViaRls(client, a),
    );
    await patchSharingFlags(app, a, { share_medical_conditions: true });
    expect(JSON.parse((await profileViaRls(client, a)) ?? '{}')).toMatchObject({
      share_medical_conditions: true,
      share_allergies: true,
    });

    const b = await newUser();
    await apiWrites(b);
    await asAppUser(
      client,
      b,
      `update public.profiles set allergies = 'Changed by the app' where id = $1`,
      [b],
    );
    const read = (await getProfile(app, b)).json<Body>();
    expect(read.allergies).toBe('Changed by the app');
    expect(JSON.stringify(withoutAvatarUrl(read))).toBe(await profileViaRls(client, b));
  });

  it('the SQL setup after an API setup, and the API setup after an SQL setup, change no row', async () => {
    for (const first of ['api', 'sql'] as const) {
      const id = await newUser();
      await apiWrites(id);
      const one = first === 'api' ? await apiSetup(id) : await sqlSetup(id);
      const rowsAfterFirst = await client.query<Body>(
        `select m.id, m.invite_token, m.status, m.activated_at, m.invite_expires_at > now() + interval '6 days' as fresh
           from public.safety_circle_members m where m.circle_id = $1 order by m.id`,
        [one.circle_id],
      );
      const two = first === 'api' ? await sqlSetup(id) : await apiSetup(id);
      expect(two).toEqual(one);
      const rowsAfterSecond = await client.query<Body>(
        `select m.id, m.invite_token, m.status, m.activated_at, m.invite_expires_at > now() + interval '6 days' as fresh
           from public.safety_circle_members m where m.circle_id = $1 order by m.id`,
        [one.circle_id],
      );
      expect(rowsAfterSecond.rows).toEqual(rowsAfterFirst.rows);
    }
  });
});
