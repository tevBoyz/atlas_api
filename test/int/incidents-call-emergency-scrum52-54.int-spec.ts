import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { RealtimeGateway } from '../../src/realtime/realtime.gateway';
import { createTestApp } from '../../src/testing/test-app';
import { authHeader } from '../../src/testing/test-tokens';
import { removeMember } from '../support/circle-api';
import { openTestClient } from '../support/database';
import { addActiveMember, createCircle, createUser, type UserFixture } from '../support/fixtures';
import {
  getIncidentDetails,
  getOpenIncident,
  markSafe,
  renotifyAlert,
  submitAlert,
} from '../support/incident-api';
import {
  emergencyInfoBody,
  getProfile,
  patchSharingFlags,
  putEmergencyInfo,
} from '../support/profile-api';
import { connectSocket, eventually, sleep, type TestSocket } from '../support/realtime-client';

/**
 * SCRUM-52 (Call Resident, D59) and SCRUM-54 (Emergency services shortcut, D60), migration 0016.
 *
 * D59: `profiles.share_phone` (not null, default TRUE: on for new and existing profiles). When on,
 * the share payload carries `resident_phone`, the account's phone (`users.phone`; Stage 2 [39]: confirmed
 * or not); absent when off or when there is no phone. Accepted by
 * `PATCH /v1/me/profile/sharing-flags` and (optional) by the Emergency Info PUT. Turning it on or off
 * during an active alert rewrites the live view and sends `incident.shared_info_updated` (D53). Never
 * to a non-member, a removed member or a member outside the window; never in the audit log.
 *
 * D60: `emergency_services: [{service, label, number}]` in the fixed order ambulance, police,
 * fire_rescue (GM: 116 / 117 / 119) on the member read and on the resident's live reads (submit,
 * open, re-notify), read from `app_config.emergency_numbers` per request; plus
 * `GET /v1/config/emergency-numbers`.
 */
type Body = Record<string, unknown>;
const EVENT = 'incident.shared_info_updated';
const GM = [
  { service: 'ambulance', label: 'Ambulance', number: '116' },
  { service: 'police', label: 'Police', number: '117' },
  { service: 'fire_rescue', label: 'Fire and Rescue', number: '119' },
];

describe('Call resident and emergency numbers (SCRUM-52/54, D59/D60)', () => {
  let app: NestFastifyApplication;
  let url: string;
  let client: Client;
  let phoneCounter = 0;
  const open: TestSocket[] = [];

  beforeAll(async () => {
    ({ app } = await createTestApp());
    await app.listen(0, '127.0.0.1');
    url = await app.getUrl();
    client = await openTestClient();
    await eventually(() => app.get(RealtimeGateway).ping());
  });

  afterEach(() => {
    for (const socket of open.splice(0)) socket.close();
  });

  afterAll(async () => {
    await client.end();
    await app.close();
  });

  async function connect(user: UserFixture) {
    const socket = await connectSocket(url, user.id);
    open.push(socket);
    return socket;
  }

  /** A fictional Gambian number on the account, confirmed unless `confirmed` is false. */
  async function setAccountPhone(userId: string, confirmed = true): Promise<string> {
    const phone = `+220700${String(1000 + phoneCounter++).padStart(4, '0')}`;
    await client.query(
      `update public.users
          set phone = $2, phone_confirmed_at = case when $3::boolean then now() end
        where id = $1`,
      [userId, phone, confirmed],
    );
    return phone;
  }

  async function scene(options: { phone?: 'confirmed' | 'unconfirmed' | 'none' } = {}) {
    const rita = await createUser(client, { fullName: 'Rita Resident' });
    const circle = await createCircle(client, rita);
    const milo = await createUser(client);
    const nina = await createUser(client);
    const miloRow = await addActiveMember(client, circle, milo);
    await addActiveMember(client, circle, nina);
    const outsider = await createUser(client);
    const kind = options.phone ?? 'confirmed';
    const phone = kind === 'none' ? null : await setAccountPhone(rita.id, kind === 'confirmed');
    return { rita, circle, milo, nina, miloRow, outsider, phone };
  }

  async function raise(rita: UserFixture): Promise<{ id: string; body: Body }> {
    const submitted = await submitAlert(app, rita.id, 'medical');
    expect(submitted.statusCode).toBe(201);
    const body = submitted.json<Body>();
    return { id: body.id as string, body };
  }

  describe('migration 0016', () => {
    it('share_phone is not null with default true; a new profile has it on and the Profile shows it', async () => {
      const { rows } = await client.query<{ is_nullable: string; column_default: string }>(
        `select is_nullable, column_default from information_schema.columns
          where table_schema = 'public' and table_name = 'profiles' and column_name = 'share_phone'`,
      );
      expect(rows).toEqual([{ is_nullable: 'NO', column_default: 'true' }]);
      const user = await createUser(client);
      const profile = (await getProfile(app, user.id)).json<Body>();
      expect(profile.share_phone).toBe(true);
      // Last column, after medical_info_updated_at; then avatar_url and the item lists.
      expect(Object.keys(profile).slice(-5)).toEqual([
        'medical_info_updated_at',
        'share_phone',
        'avatar_url',
        'allergy_items',
        'medical_condition_items',
      ]);
    });

    it('seeds app_config.emergency_numbers for The Gambia', async () => {
      const { rows } = await client.query<{ value: Body }>(
        `select value from public.app_config where key = 'emergency_numbers'`,
      );
      expect(rows[0].value).toEqual({ GM });
    });
  });

  describe('share my phone (D59)', () => {
    it('on by default with a confirmed phone: resident_phone in the member read, the snapshot and the resident body', async () => {
      const { rita, milo, phone } = await scene();
      const { id, body } = await raise(rita);
      expect((body.share_payload as Body).resident_phone).toBe(phone);
      const details = (await getIncidentDetails(app, milo.id, id)).json<Body>();
      expect(details.share_payload).toEqual({ resident_phone: phone });
      expect(details.share_payload_at_activation).toEqual({ resident_phone: phone });
      await markSafe(app, rita.id, id);
    });

    it('Stage 2 [39]: an unconfirmed stored phone is shared too; absent with no phone or when turned off', async () => {
      {
        const { rita, milo, phone } = await scene({ phone: 'unconfirmed' });
        const { id, body } = await raise(rita);
        const details = (await getIncidentDetails(app, milo.id, id)).json<Body>();
        expect(details.share_payload).toEqual({ resident_phone: phone });
        expect(body.share_payload).toEqual({ resident_phone: phone });
        await markSafe(app, rita.id, id);
      }
      {
        const { rita, milo } = await scene({ phone: 'none' });
        const { id } = await raise(rita);
        const details = (await getIncidentDetails(app, milo.id, id)).json<Body>();
        expect(details.share_payload).toEqual({});
        await markSafe(app, rita.id, id);
      }
      const { rita, milo } = await scene();
      const off = await patchSharingFlags(app, rita.id, { share_phone: false });
      expect(off.statusCode).toBe(200);
      expect(off.json<Body>().share_phone).toBe(false);
      const { id } = await raise(rita);
      expect((await getIncidentDetails(app, milo.id, id)).json<Body>().share_payload).toEqual({});
      await markSafe(app, rita.id, id);
    });

    it('the Emergency Info PUT keeps share_phone when left out, sets it when sent, refuses a non-boolean', async () => {
      const { rita } = await scene();
      const kept = await putEmergencyInfo(app, rita.id, emergencyInfoBody());
      expect(kept.statusCode).toBe(200);
      expect(kept.json<Body>().share_phone).toBe(true);
      const off = await putEmergencyInfo(app, rita.id, emergencyInfoBody({ share_phone: false }));
      expect(off.json<Body>().share_phone).toBe(false);
      expect(
        (await putEmergencyInfo(app, rita.id, emergencyInfoBody())).json<Body>().share_phone,
      ).toBe(false);
      const bad = await putEmergencyInfo(app, rita.id, emergencyInfoBody({ share_phone: 'yes' }));
      expect(bad.statusCode).toBe(422);
      expect(bad.json<{ error: { code: string; details: Body } }>().error).toMatchObject({
        code: 'validation:invalid_request',
        details: { field: 'share_phone' },
      });
      const badPatch = await patchSharingFlags(app, rita.id, { share_phone: null });
      expect(badPatch.statusCode).toBe(422);
    });

    it('turned off and on mid-alert: the live view and incident.shared_info_updated follow; the snapshot stays', async () => {
      const { rita, milo, phone } = await scene();
      const { id } = await raise(rita);
      const miloSocket = await connect(milo);
      const ritaSocket = await connect(rita);
      await expect(miloSocket.join(id)).resolves.toEqual({ ok: true });
      await expect(ritaSocket.join(id)).resolves.toEqual({ ok: true });

      await patchSharingFlags(app, rita.id, { share_phone: false });
      const off = await miloSocket.next<Body>(EVENT);
      expect(off).toMatchObject({ incident_id: id, share_payload: {} });
      await expect(ritaSocket.next<Body>(EVENT)).resolves.toEqual(off);
      let details = (await getIncidentDetails(app, milo.id, id)).json<Body>();
      expect(details.share_payload).toEqual({});
      expect(details.share_payload_at_activation).toEqual({ resident_phone: phone });
      expect(details.share_payload_updated_at).toBe(off.updated_at);

      // Through the Emergency Info PUT this time.
      await putEmergencyInfo(app, rita.id, emergencyInfoBody({ share_phone: true }));
      const on = await miloSocket.next<Body>(EVENT);
      expect(on.share_payload).toEqual({ resident_phone: phone });
      details = (await getIncidentDetails(app, milo.id, id)).json<Body>();
      expect(details.share_payload).toEqual({ resident_phone: phone });

      // The same value again changes nothing members see: nothing is sent.
      await patchSharingFlags(app, rita.id, { share_phone: true });
      await sleep(300);
      expect(miloSocket.of(EVENT)).toHaveLength(2);
      await markSafe(app, rita.id, id);
    });

    it('Stage 3 [B3] (SCRUM-23/24/79): emergency_preferred_language reaches members only while share_emergency_preferred_language is on; the app language never', async () => {
      const { rita, milo } = await scene({ phone: 'none' });
      const saved = await putEmergencyInfo(
        app,
        rita.id,
        emergencyInfoBody({
          emergency_preferred_language: ' Wolof ',
          share_emergency_preferred_language: true,
        }),
      );
      expect(saved.statusCode).toBe(200);
      await client.query(`update public.profiles set preferred_language = 'wo' where id = $1`, [
        rita.id,
      ]);
      const { id, body } = await raise(rita);
      expect(body.share_payload).toEqual({ emergency_preferred_language: 'Wolof' });
      const miloSocket = await connect(milo);
      await expect(miloSocket.join(id)).resolves.toEqual({ ok: true });
      let details = (await getIncidentDetails(app, milo.id, id)).json<Body>();
      expect(details.share_payload).toEqual({ emergency_preferred_language: 'Wolof' });
      expect(details.share_payload_at_activation).toEqual({
        emergency_preferred_language: 'Wolof',
      });
      expect(JSON.stringify(details)).not.toContain('"preferred_language"');

      await patchSharingFlags(app, rita.id, { share_emergency_preferred_language: false });
      const off = await miloSocket.next<Body>(EVENT);
      expect(off.share_payload).toEqual({});
      details = (await getIncidentDetails(app, milo.id, id)).json<Body>();
      expect(details.share_payload).toEqual({});
      await markSafe(app, rita.id, id);

      // Off from the start: never in the snapshot either.
      const second = await raise(rita);
      expect(second.body.share_payload).toEqual({});
      const later = (await getIncidentDetails(app, milo.id, second.id)).json<Body>();
      expect(later.share_payload_at_activation).toEqual({});
      await markSafe(app, rita.id, second.id);
    });

    it('never to a removed member, an outsider or a member who joined after the alert', async () => {
      const { rita, circle, milo, nina, miloRow, outsider, phone } = await scene();
      const { id } = await raise(rita);
      const late = await createUser(client);
      await addActiveMember(client, circle, late);
      const miloSocket = await connect(milo);
      const ninaSocket = await connect(nina);
      const outsiderSocket = await connect(outsider);
      const lateSocket = await connect(late);
      await expect(miloSocket.join(id)).resolves.toEqual({ ok: true });
      await expect(ninaSocket.join(id)).resolves.toEqual({ ok: true });
      await expect(outsiderSocket.join(id)).resolves.toMatchObject({ ok: false });
      await expect(lateSocket.join(id)).resolves.toMatchObject({ ok: false });

      expect((await removeMember(app, rita.id, circle.id, miloRow.id)).statusCode).toBe(200);
      await sleep(200);
      await patchSharingFlags(app, rita.id, { share_phone: false });
      await expect(ninaSocket.next<Body>(EVENT)).resolves.toMatchObject({ incident_id: id });
      await patchSharingFlags(app, rita.id, { share_phone: true });
      await expect(ninaSocket.next<Body>(EVENT)).resolves.toMatchObject({
        share_payload: { resident_phone: phone },
      });
      await sleep(300);

      for (const user of [milo, outsider, late]) {
        const read = await getIncidentDetails(app, user.id, id);
        expect(read.statusCode).toBe(404);
        expect(read.body).not.toContain(phone);
      }
      for (const socket of [miloSocket, outsiderSocket, lateSocket]) {
        expect(socket.of(EVENT)).toEqual([]);
        expect(JSON.stringify(socket.received)).not.toContain(phone);
      }
      await markSafe(app, rita.id, id);
      // The phone is never written to the audit log.
      const { rows } = await client.query<{ n: number }>(
        `select count(*)::int as n from public.audit_log where detail::text like $1`,
        [`%${(phone as string).slice(1)}%`],
      );
      expect(rows[0].n).toBe(0);
    });
  });

  describe('emergency numbers (D60)', () => {
    it('on the member read and the resident live reads (submit, open, re-notify), fixed order', async () => {
      const { rita, milo } = await scene();
      const { id, body } = await raise(rita);
      expect(body.emergency_services).toEqual(GM);
      const open = (await getOpenIncident(app, rita.id)).json<{ open_incident: Body }>();
      expect(open.open_incident.emergency_services).toEqual(GM);
      const renotified = await renotifyAlert(app, rita.id, id);
      expect(renotified.json<Body>().emergency_services).toEqual(GM);
      const again = await submitAlert(app, rita.id, 'fire');
      expect(again.statusCode).toBe(200);
      expect(again.json<Body>().emergency_services).toEqual(GM);
      const details = (await getIncidentDetails(app, milo.id, id)).json<Body>();
      expect(details.emergency_services).toEqual(GM);
      // Mark safe keeps IncidentSend (the alert is over).
      expect((await markSafe(app, rita.id, id)).json<Body>()).not.toHaveProperty(
        'emergency_services',
      );
      expect(
        (await getOpenIncident(app, rita.id)).json<{ open_incident: unknown }>().open_incident,
      ).toBeNull();
    });

    it('a config change applies on the next read (no restart); the order stays fixed; a missing row falls back', async () => {
      const { rita, milo } = await scene();
      const { id } = await raise(rita);
      try {
        await client.query(
          `update public.app_config set value = $1::jsonb where key = 'emergency_numbers'`,
          [
            JSON.stringify({
              GM: [
                { service: 'fire_rescue', label: 'Fire', number: '118' },
                { service: 'ambulance', label: 'Ambulance', number: '116' },
              ],
            }),
          ],
        );
        const expected = [
          { service: 'ambulance', label: 'Ambulance', number: '116' },
          { service: 'fire_rescue', label: 'Fire', number: '118' },
        ];
        expect(
          (await getIncidentDetails(app, milo.id, id)).json<Body>().emergency_services,
        ).toEqual(expected);
        const config = await app.inject({
          method: 'GET',
          url: '/v1/config/emergency-numbers',
          headers: await authHeader(milo.id),
        });
        expect(config.json<Body>()).toEqual({ country: 'GM', emergency_services: expected });

        await client.query(
          `update public.app_config set value = '{"SN": []}' where key = 'emergency_numbers'`,
        );
        expect(
          (await getIncidentDetails(app, milo.id, id)).json<Body>().emergency_services,
        ).toEqual([]);

        await client.query(`delete from public.app_config where key = 'emergency_numbers'`);
        expect(
          (await getIncidentDetails(app, milo.id, id)).json<Body>().emergency_services,
        ).toEqual(GM);
      } finally {
        await client.query(
          `insert into public.app_config (key, value) values ('emergency_numbers', $1::jsonb)
           on conflict (key) do update set value = excluded.value`,
          [JSON.stringify({ GM })],
        );
        await markSafe(app, rita.id, id);
      }
    });

    it('Stage 2 [B9]: chosen by the incident country_code; unknown or missing -> The Gambia', async () => {
      const ET = [
        { service: 'ambulance', label: 'Ambulance', number: '907' },
        { service: 'police', label: 'Police', number: '991' },
      ];
      const original = await client.query<{ value: unknown }>(
        `select value from public.app_config where key = 'emergency_numbers'`,
      );
      await client.query(
        `update public.app_config set value = $1::jsonb where key = 'emergency_numbers'`,
        [JSON.stringify({ GM, ET })],
      );
      const submitIn = async (rita: UserFixture, country: string | undefined) =>
        app.inject({
          method: 'POST',
          url: '/v1/incidents',
          headers: {
            ...(await authHeader(rita.id)),
            'idempotency-key': randomUUID(),
            'content-type': 'application/json',
          },
          payload: JSON.stringify({ emergency_type: 'medical', country_code: country }),
        });
      try {
        const et = await scene();
        const etSubmit = await submitIn(et.rita, 'et');
        expect(etSubmit.statusCode).toBe(201);
        const etId = etSubmit.json<Body>().id as string;
        expect(etSubmit.json<Body>()).toMatchObject({ country_code: 'ET', emergency_services: ET });
        const open = (await getOpenIncident(app, et.rita.id)).json<{ open_incident: Body }>();
        expect(open.open_incident.emergency_services).toEqual(ET);
        const details = (await getIncidentDetails(app, et.milo.id, etId)).json<Body>();
        expect(details).toMatchObject({ country_code: 'ET', emergency_services: ET });
        expect(
          (await renotifyAlert(app, et.rita.id, etId)).json<Body>().emergency_services,
        ).toEqual(ET);
        await markSafe(app, et.rita.id, etId);

        for (const country of ['FR', undefined]) {
          const other = await scene();
          const reply = await submitIn(other.rita, country);
          expect(reply.json<Body>().emergency_services).toEqual(GM);
          const otherId = reply.json<Body>().id as string;
          expect(
            (await getIncidentDetails(app, other.milo.id, otherId)).json<Body>().emergency_services,
          ).toEqual(GM);
          await markSafe(app, other.rita.id, otherId);
        }
      } finally {
        await client.query(
          `update public.app_config set value = $1::jsonb where key = 'emergency_numbers'`,
          [JSON.stringify(original.rows[0].value)],
        );
      }
    });

    it('GET /v1/config/emergency-numbers: any valid token (no profile needed), 401 without one', async () => {
      const noProfile = await createUser(client, { profile: false });
      const ok = await app.inject({
        method: 'GET',
        url: '/v1/config/emergency-numbers',
        headers: await authHeader(noProfile.id),
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json<Body>()).toEqual({ country: 'GM', emergency_services: GM });
      const anonymous = await app.inject({ method: 'GET', url: '/v1/config/emergency-numbers' });
      expect(anonymous.statusCode).toBe(401);
      expect(anonymous.json<{ error: { code: string } }>().error.code).toBe(
        'get_emergency_numbers:not_authenticated',
      );
    });
  });
});
