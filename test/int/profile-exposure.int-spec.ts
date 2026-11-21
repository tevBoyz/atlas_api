import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { AppModule } from '../../src/app.module';
import { collectControllers, discoverRoutes } from '../../src/openapi/route-discovery';
import { createTestApp, withTestConfig } from '../../src/testing/test-app';
import { authHeader } from '../../src/testing/test-tokens';
import { openTestClient } from '../support/database';
import {
  addActiveMember,
  createCircle,
  createIncident,
  createUser,
  type UserFixture,
} from '../support/fixtures';
import { insertMember } from '../support/invite-rows';

/**
 * API-100-34 AC2: no route of the API exposes another user's profile beyond what Phases 1-2 already
 * allow (the name as `resident_name` / `display_name` / `owner_name`, and the photo as an
 * `*avatar_url`; the incident share payload only for flags the resident turned on, and every flag is
 * off here).
 *
 * The target user has a profile full of marker values (date of birth, emergency contact, medical
 * fields, notes, a photo path) and is the owner of a circle with an active incident, an active
 * member of another circle and the inviter of a link invite. Every route the app registers
 * (discovered from the controllers, so later routes are covered automatically) is called by four
 * other users (a member of the target's circle, an outsider, a link invitee and the owner of the
 * circle the target belongs to) with the target's ids and tokens in the path, the target's id in the
 * query and a body naming the target. No response may contain a marker; the photo path may appear
 * only inside an `*avatar_url` value. The target's profile row is unchanged afterwards.
 */
type Json = unknown;

const SUPABASE_URL = 'https://example-project.supabase.co';
const MARKERS = {
  date_of_birth: '1977-07-07',
  emergency_contact_full_name: 'MarkerContactName',
  emergency_contact_phone: '+12015550177',
  emergency_contact_email: 'marker-contact@example.test',
  allergies: 'MarkerAllergy',
  medical_conditions: 'MarkerCondition',
  emergency_preferred_language: 'MarkerLanguage',
  emergency_notes: 'MarkerNotes',
};

/** Every string value in `value` with the key it sits under. */
function strings(value: Json, key = ''): { key: string; text: string }[] {
  if (typeof value === 'string') return [{ key, text: value }];
  if (Array.isArray(value)) return value.flatMap((item) => strings(item, key));
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => strings(v, k));
  }
  return [];
}

describe('no route exposes another user’s profile (API-100-34 AC2)', () => {
  let app: NestFastifyApplication;
  let client: Client;

  beforeAll(async () => {
    ({ app } = await createTestApp(
      {},
      withTestConfig({
        SUPABASE_URL,
        RATE_LIMIT_AUTHENTICATED_MAX: '1000000',
        RATE_LIMIT_PUBLIC_MAX: '1000000',
        RATE_LIMIT_EMERGENCY_WRITE_MAX: '1000000',
        RATE_LIMIT_LOCATION_PING_MAX: '1000000',
        RATE_LIMIT_AVATAR_UPLOAD_MAX: '1000000',
      }),
    ));
    client = await openTestClient();
  });

  afterAll(async () => {
    await client?.end();
    await app?.close();
  });

  const profileHash = async (id: string) =>
    (
      await client.query<{ h: string }>(
        'select md5(p::text) as h from public.profiles p where id = $1',
        [id],
      )
    ).rows[0].h;

  it('every route, called by other users with the target’s ids, returns none of its profile data', async () => {
    const target = await createUser(client, { fullName: 'Target Person', phone: true });
    const avatarPath = `${target.id}/avatar-marker.jpg`;
    await client.query(
      `update public.profiles
          set date_of_birth = $2, emergency_contact_full_name = $3, emergency_contact_phone = $4,
              emergency_contact_email = $5, allergies = $6, medical_conditions = $7,
              emergency_preferred_language = $8, emergency_notes = $9, avatar_path = $10,
              gender = 'prefer_not_to_say', blood_type = 'AB-'
        where id = $1`,
      [
        target.id,
        MARKERS.date_of_birth,
        MARKERS.emergency_contact_full_name,
        MARKERS.emergency_contact_phone,
        MARKERS.emergency_contact_email,
        MARKERS.allergies,
        MARKERS.medical_conditions,
        MARKERS.emergency_preferred_language,
        MARKERS.emergency_notes,
        avatarPath,
      ],
    );
    const circle = await createCircle(client, target);
    const member = await createUser(client, { fullName: 'Member Reader', phone: true });
    const memberRow = await addActiveMember(client, circle, member);
    const outsider = await createUser(client, { fullName: 'Outsider Reader' });
    const invitee = await createUser(client, { fullName: 'Link Reader' });
    const link = await insertMember(client, circle.id, { name: 'Link Reader' });
    const otherOwner = await createUser(client, { fullName: 'Other Owner', phone: true });
    const otherCircle = await createCircle(client, otherOwner);
    const targetRow = await addActiveMember(client, otherCircle, target);
    const incident = await createIncident(client, target, circle);
    await client.query(
      `insert into public.incident_deliveries (incident_id, member_id, member_user_id)
       values ($1, $2, $3)`,
      [incident.id, memberRow.id, member.id],
    );
    const before = await profileHash(target.id);

    const routes = discoverRoutes(collectControllers(AppModule));
    const hostile = {
      id: target.id,
      user_id: target.id,
      profile_id: target.id,
      member_id: targetRow.id,
      circle_id: circle.id,
      object_path: avatarPath,
      avatar_path: avatarPath,
    };
    const leaks: string[] = [];
    let calls = 0;
    for (const route of routes) {
      const method = route.method.toUpperCase();
      for (const caller of [member, outsider, invitee, otherOwner] as UserFixture[]) {
        for (const ids of [
          { circle_id: circle.id, member_id: memberRow.id },
          { circle_id: otherCircle.id, member_id: targetRow.id },
        ]) {
          const path = route.path.replace(/\{(\w+)\}/g, (_m, p: string) => {
            switch (p) {
              case 'circle_id':
                return ids.circle_id;
              case 'member_id':
                return ids.member_id;
              case 'token':
                return link.token;
              case 'id':
                return incident.id;
              case 'session_id':
                // Own sessions (API-100-56): an id that is nobody's session.
                return randomUUID();
              default:
                throw new Error(`No value for path parameter {${p}}: add one to this test`);
            }
          });
          const reply = await app.inject({
            method: method as 'GET',
            url: `${path}?id=${target.id}&user_id=${target.id}`,
            headers: {
              ...(await authHeader(caller.id)),
              'idempotency-key': randomUUID(),
              ...(method === 'GET' || method === 'DELETE'
                ? {}
                : { 'content-type': 'application/json' }),
            },
            ...(method === 'GET' || method === 'DELETE'
              ? {}
              : { payload: JSON.stringify(hostile) }),
          });
          calls += 1;
          expect({ route: path, ok: reply.statusCode < 500 }).toEqual({ route: path, ok: true });
          const text = reply.body;
          for (const [field, marker] of Object.entries(MARKERS)) {
            if (text.includes(marker)) leaks.push(`${method} ${route.path}: ${field}`);
          }
          if (text.includes('avatar-marker')) {
            for (const { key, text: value } of strings(text ? (JSON.parse(text) as Json) : null)) {
              if (value.includes('avatar-marker') && !/avatar_url$/.test(key)) {
                leaks.push(`${method} ${route.path}: avatar path under ${key}`);
              }
            }
          }
          if (!route.path.includes('{')) break;
        }
      }
    }
    expect(calls).toBeGreaterThan(routes.length);
    expect(leaks).toEqual([]);
    expect(await profileHash(target.id)).toBe(before);
  });
});
