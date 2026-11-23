import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { createTestApp } from '../../src/testing/test-app';
import { openTestClient } from '../support/database';
import { addActiveMember, createCircle, createUser, type UserFixture } from '../support/fixtures';
import {
  getIncidentDetails,
  getOpenIncident,
  markSafe,
  submitAlert,
} from '../support/incident-api';
import {
  addMedicalItem,
  deleteMedicalItem,
  editMedicalItem,
  emergencyInfoBody,
  getProfile,
  type MedicalListRoute,
  patchSharingFlags,
  putEmergencyInfo,
} from '../support/profile-api';

/**
 * SCRUM-21 (Add/Edit Medical Information), decisions D51-D53, migration 0014:
 * AC1 blood type from the 9 valid options; AC2 allergies and conditions added, edited and deleted
 * independently (limits, duplicates, 404s); AC3 changes timestamped and used for every future
 * incident (share payload arrays, D52); AC4 edits during an active incident update the live incident
 * view while the activation snapshot (what the alerts carried) never changes (D53). Also the
 * back-fill and the old text columns kept in sync.
 */
type Body = Record<string, unknown>;
type Item = { id: string; text: string; updated_at: string };
const UTC_TEXT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?\+00:00$/;
const MIGRATION_0014 = readFileSync(resolve('db/migrations/0014_medical_info_items.sql'), 'utf8');

describe('SCRUM-21 medical information (D51-D53)', () => {
  let app: NestFastifyApplication;
  let client: Client;

  beforeAll(async () => {
    ({ app } = await createTestApp());
    client = await openTestClient();
  });

  afterAll(async () => {
    await client.end();
    await app.close();
  });

  const errorOf = (reply: { json: <T>() => T }) =>
    reply.json<{ error: { code: string; details?: { field?: string } } }>().error;

  async function add(user: UserFixture, list: MedicalListRoute, text: string): Promise<Body> {
    const reply = await addMedicalItem(app, user.id, list, { text });
    expect({ status: reply.statusCode, text }).toEqual({ status: 200, text });
    return reply.json<Body>();
  }

  const itemsOf = (profile: Body, list: MedicalListRoute) =>
    profile[list === 'allergies' ? 'allergy_items' : 'medical_condition_items'] as Item[];

  async function profileRow(id: string) {
    const { rows } = await client.query<{
      allergies: string | null;
      medical_conditions: string | null;
      medical_info_updated_at: Date | null;
    }>(
      'select allergies, medical_conditions, medical_info_updated_at from public.profiles where id = $1',
      [id],
    );
    return rows[0];
  }

  async function incidentRow(id: string) {
    const { rows } = await client.query<{
      share_payload: Body | null;
      live_share_payload: Body | null;
      live_share_updated_at: Date | null;
    }>(
      'select share_payload, live_share_payload, live_share_updated_at from public.incidents where id = $1',
      [id],
    );
    return rows[0];
  }

  describe('AC1 blood type: the 9 valid options only', () => {
    it('each valid value saves; anything else is 422 profiles:invalid_blood_type', async () => {
      const user = await createUser(client);
      for (const bloodType of ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'Unknown']) {
        const reply = await putEmergencyInfo(
          app,
          user.id,
          emergencyInfoBody({ blood_type: bloodType }),
        );
        expect({ bloodType, status: reply.statusCode }).toEqual({ bloodType, status: 200 });
        expect(reply.json<Body>().blood_type).toBe(bloodType);
      }
      for (const bad of ['C+', 'o+', 'AB', 'unknown', '0+']) {
        const reply = await putEmergencyInfo(app, user.id, emergencyInfoBody({ blood_type: bad }));
        expect(reply.statusCode).toBe(422);
        expect(errorOf(reply)).toMatchObject({
          code: 'profiles:invalid_blood_type',
          details: { field: 'blood_type' },
        });
      }
    });

    it('a blood-type change sets medical_info_updated_at; the same value or another field does not', async () => {
      const user = await createUser(client);
      expect((await profileRow(user.id)).medical_info_updated_at).toBeNull();
      const first = await putEmergencyInfo(app, user.id, emergencyInfoBody({ blood_type: 'A+' }));
      const stamped = first.json<Body>().medical_info_updated_at as string;
      expect(stamped).toMatch(UTC_TEXT);
      const same = await putEmergencyInfo(
        app,
        user.id,
        emergencyInfoBody({ blood_type: 'A+', emergency_notes: 'other text' }),
      );
      expect(same.json<Body>().medical_info_updated_at).toBe(stamped);
      const flags = await patchSharingFlags(app, user.id, { share_blood_type: true });
      expect(flags.json<Body>().medical_info_updated_at).toBe(stamped);
      const changed = await putEmergencyInfo(app, user.id, emergencyInfoBody({ blood_type: 'B-' }));
      expect(changed.json<Body>().medical_info_updated_at).not.toBe(stamped);
      const cleared = await putEmergencyInfo(app, user.id, emergencyInfoBody({ blood_type: null }));
      expect(cleared.json<Body>().blood_type).toBeNull();
      expect(cleared.json<Body>().medical_info_updated_at).not.toBe(
        changed.json<Body>().medical_info_updated_at,
      );
    });
  });

  describe('AC2 multiple items, added, edited and deleted independently', () => {
    it.each(['allergies', 'medical-conditions'] as const)(
      '%s: add, edit, delete one at a time; oldest first; old text column in sync',
      async (list) => {
        const user = await createUser(client);
        const column = list === 'allergies' ? 'allergies' : 'medical_conditions';
        await add(user, list, '  Peanuts ');
        await add(user, list, 'Dust');
        const profile = await add(user, list, 'Penicillin');
        const [peanuts, dust, penicillin] = itemsOf(profile, list);
        expect(itemsOf(profile, list).map((i) => i.text)).toEqual([
          'Peanuts',
          'Dust',
          'Penicillin',
        ]);
        for (const item of itemsOf(profile, list)) {
          expect(Object.keys(item)).toEqual(['id', 'text', 'updated_at']);
          expect(item.updated_at).toMatch(UTC_TEXT);
        }
        expect((await profileRow(user.id))[column]).toBe('Peanuts, Dust, Penicillin');

        // Edit one: only that item changes (text and updated_at); order kept.
        const edited = await editMedicalItem(app, user.id, list, dust.id, { text: 'House dust' });
        expect(edited.statusCode).toBe(200);
        const afterEdit = itemsOf(edited.json<Body>(), list);
        expect(afterEdit.map((i) => [i.id, i.text])).toEqual([
          [peanuts.id, 'Peanuts'],
          [dust.id, 'House dust'],
          [penicillin.id, 'Penicillin'],
        ]);
        expect(afterEdit[0].updated_at).toBe(peanuts.updated_at);
        expect(afterEdit[1].updated_at).not.toBe(dust.updated_at);
        expect((await profileRow(user.id))[column]).toBe('Peanuts, House dust, Penicillin');

        // Delete one: the others stay.
        const deleted = await deleteMedicalItem(app, user.id, list, peanuts.id);
        expect(deleted.statusCode).toBe(200);
        expect(itemsOf(deleted.json<Body>(), list).map((i) => i.text)).toEqual([
          'House dust',
          'Penicillin',
        ]);
        expect((await profileRow(user.id))[column]).toBe('House dust, Penicillin');

        // The GET returns the same lists; the other list is untouched.
        const read = (await getProfile(app, user.id)).json<Body>();
        expect(itemsOf(read, list).map((i) => i.text)).toEqual(['House dust', 'Penicillin']);
        expect(itemsOf(read, list === 'allergies' ? 'medical-conditions' : 'allergies')).toEqual(
          [],
        );

        // Deleting the last items clears the old column.
        for (const item of itemsOf(read, list)) {
          expect((await deleteMedicalItem(app, user.id, list, item.id)).statusCode).toBe(200);
        }
        expect((await profileRow(user.id))[column]).toBeNull();
        expect(itemsOf((await getProfile(app, user.id)).json<Body>(), list)).toEqual([]);
      },
    );

    it('text rules: trimmed, 1-100 characters, JSON string only', async () => {
      const user = await createUser(client);
      expect(
        itemsOf(await add(user, 'allergies', 'a'.repeat(100)), 'allergies')[0].text,
      ).toHaveLength(100);
      for (const text of ['', '   ', 'b'.repeat(101)]) {
        const reply = await addMedicalItem(app, user.id, 'allergies', { text });
        expect(reply.statusCode).toBe(422);
        expect(errorOf(reply)).toMatchObject({
          code: 'profiles:invalid_medical_item',
          details: { field: 'text' },
        });
      }
      for (const body of [{}, { text: null }, { text: 7 }]) {
        const reply = await addMedicalItem(app, user.id, 'allergies', body);
        expect(reply.statusCode).toBe(422);
        expect(errorOf(reply)).toMatchObject({
          code: 'validation:invalid_request',
          details: { field: 'text' },
        });
      }
      const id = itemsOf((await getProfile(app, user.id)).json<Body>(), 'allergies')[0].id;
      const blankEdit = await editMedicalItem(app, user.id, 'allergies', id, { text: ' ' });
      expect(errorOf(blankEdit).code).toBe('profiles:invalid_medical_item');
    });

    it('at most 20 items per list (409 profiles:medical_item_limit_reached), per list', async () => {
      const user = await createUser(client);
      for (let i = 1; i <= 20; i += 1) await add(user, 'allergies', `Allergen ${i}`);
      const full = await addMedicalItem(app, user.id, 'allergies', { text: 'One more' });
      expect(full.statusCode).toBe(409);
      expect(errorOf(full).code).toBe('profiles:medical_item_limit_reached');
      const { rows } = await client.query<{ n: number }>(
        'select count(*)::int as n from public.profile_allergies where user_id = $1',
        [user.id],
      );
      expect(rows[0].n).toBe(20);
      // The other list is separate; deleting one frees a place.
      await add(user, 'medical-conditions', 'Asthma');
      const first = itemsOf((await getProfile(app, user.id)).json<Body>(), 'allergies')[0];
      await deleteMedicalItem(app, user.id, 'allergies', first.id);
      await add(user, 'allergies', 'One more');
    });

    it('a case-insensitive duplicate in the same list is refused (409), in the other list allowed', async () => {
      const user = await createUser(client);
      await add(user, 'allergies', 'Peanuts');
      const dust = itemsOf(await add(user, 'allergies', 'Dust'), 'allergies')[1];
      for (const text of ['Peanuts', 'peanuts', '  PEANUTS ']) {
        const reply = await addMedicalItem(app, user.id, 'allergies', { text });
        expect(reply.statusCode).toBe(409);
        expect(errorOf(reply)).toMatchObject({
          code: 'profiles:duplicate_medical_item',
          details: { field: 'text' },
        });
      }
      const editDup = await editMedicalItem(app, user.id, 'allergies', dust.id, {
        text: 'PEANUTS',
      });
      expect(editDup.statusCode).toBe(409);
      expect(errorOf(editDup).code).toBe('profiles:duplicate_medical_item');
      // An item may change its own case; another user and the other list are independent.
      const recased = await editMedicalItem(app, user.id, 'allergies', dust.id, { text: 'DUST' });
      expect(itemsOf(recased.json<Body>(), 'allergies')[1].text).toBe('DUST');
      await add(user, 'medical-conditions', 'Peanuts');
      await add(await createUser(client), 'allergies', 'Peanuts');
    });

    it("404 for an unknown id, another user's item and an item of the other list; 422 for a non-uuid; 404 without a profile; 401 without a token", async () => {
      const owner = await createUser(client);
      const other = await createUser(client);
      const item = itemsOf(await add(owner, 'allergies', 'Latex'), 'allergies')[0];
      const cases = [
        await editMedicalItem(app, owner.id, 'allergies', randomUUID(), { text: 'x' }),
        await deleteMedicalItem(app, owner.id, 'allergies', randomUUID()),
        await editMedicalItem(app, other.id, 'allergies', item.id, { text: 'stolen' }),
        await deleteMedicalItem(app, other.id, 'allergies', item.id),
        await editMedicalItem(app, owner.id, 'medical-conditions', item.id, { text: 'x' }),
        await deleteMedicalItem(app, owner.id, 'medical-conditions', item.id),
      ];
      for (const reply of cases) {
        expect(reply.statusCode).toBe(404);
        expect(errorOf(reply).code).toBe('profiles:medical_item_not_found');
      }
      // Nothing changed for the owner.
      expect(itemsOf((await getProfile(app, owner.id)).json<Body>(), 'allergies')).toEqual([item]);

      const badId = await deleteMedicalItem(app, owner.id, 'allergies', 'not-a-uuid');
      expect(badId.statusCode).toBe(422);
      expect(errorOf(badId)).toMatchObject({
        code: 'validation:invalid_request',
        details: { field: 'item_id' },
      });

      const noProfile = await createUser(client, { profile: false });
      const missing = await addMedicalItem(app, noProfile.id, 'allergies', { text: 'x' });
      expect(missing.statusCode).toBe(404);
      expect(errorOf(missing).code).toBe('profiles:profile_not_found');

      expect((await addMedicalItem(app, null, 'allergies', { text: 'x' })).statusCode).toBe(401);
    });

    it('the emergency-info PUT no longer writes the old text columns (the lists own them)', async () => {
      const user = await createUser(client);
      await add(user, 'allergies', 'Peanuts');
      const reply = await putEmergencyInfo(
        app,
        user.id,
        emergencyInfoBody({ allergies: 'Overwritten', medical_conditions: 'Overwritten' }),
      );
      expect(reply.statusCode).toBe(200);
      expect(reply.json<Body>()).toMatchObject({ allergies: 'Peanuts', medical_conditions: null });
      expect(itemsOf(reply.json<Body>(), 'allergies').map((i) => i.text)).toEqual(['Peanuts']);
    });

    it('audit rows name the list and the item, never the text', async () => {
      const user = await createUser(client);
      const item = itemsOf(await add(user, 'allergies', 'Shellfish'), 'allergies')[0];
      await editMedicalItem(app, user.id, 'allergies', item.id, { text: 'Shellfish (severe)' });
      await deleteMedicalItem(app, user.id, 'allergies', item.id);
      const { rows } = await client.query<{ action: string; detail: Body; target_id: string }>(
        `select action, detail, target_id::text from public.audit_log
          where actor_user_id = $1 order by occurred_at, id`,
        [user.id],
      );
      expect(rows.map((r) => r.action)).toEqual([
        'profile.medical_item.added',
        'profile.medical_item.updated',
        'profile.medical_item.deleted',
      ]);
      for (const row of rows) {
        expect(row.detail).toEqual({ list: 'allergies', item_id: item.id });
        expect(row.target_id).toBe(user.id);
      }
      expect(JSON.stringify(rows)).not.toMatch(/Shellfish/);
    });
  });

  describe('AC3 timestamped and used for all future incidents', () => {
    it('every item change sets medical_info_updated_at (UTC text in the Profile)', async () => {
      const user = await createUser(client);
      const added = await add(user, 'medical-conditions', 'Asthma');
      const t1 = added.medical_info_updated_at as string;
      expect(t1).toMatch(UTC_TEXT);
      const id = itemsOf(added, 'medical-conditions')[0].id;
      const t2 = (
        await editMedicalItem(app, user.id, 'medical-conditions', id, { text: 'Asthma (mild)' })
      ).json<Body>().medical_info_updated_at as string;
      const t3 = (await deleteMedicalItem(app, user.id, 'medical-conditions', id)).json<Body>()
        .medical_info_updated_at as string;
      expect(new Date(t2).getTime()).toBeGreaterThan(new Date(t1).getTime());
      expect(new Date(t3).getTime()).toBeGreaterThan(new Date(t2).getTime());
      // A refused change does not move it.
      await addMedicalItem(app, user.id, 'medical-conditions', { text: '' });
      expect((await getProfile(app, user.id)).json<Body>().medical_info_updated_at).toBe(t3);
    });

    it('a new incident carries the lists as arrays (D52), only when shared', async () => {
      const resident = await createUser(client);
      await createCircle(client, resident);
      await add(resident, 'allergies', 'Peanuts');
      await add(resident, 'allergies', 'Dust');
      await add(resident, 'medical-conditions', 'Asthma');
      await patchSharingFlags(app, resident.id, {
        share_allergies: true,
        share_medical_conditions: false,
        share_blood_type: true,
      });
      const reply = await submitAlert(app, resident.id, 'medical');
      expect(reply.statusCode).toBe(201);
      expect(reply.json<Body>().share_payload).toEqual({
        blood_type: 'Unknown',
        allergies: ['Peanuts', 'Dust'],
      });
      await markSafe(app, resident.id, reply.json<Body>().id as string);
    });

    it('an old text value with no items (written outside the API) is shared as one item', async () => {
      const resident = await createUser(client);
      await createCircle(client, resident);
      await client.query(
        `update public.profiles set allergies = '  Bees, wasps ', share_allergies = true
          where id = $1`,
        [resident.id],
      );
      const reply = await submitAlert(app, resident.id, 'other');
      expect(reply.json<Body>().share_payload).toEqual({ allergies: ['Bees, wasps'] });
      await markSafe(app, resident.id, reply.json<Body>().id as string);
    });
  });

  describe('AC4 edits during an active incident: live view updated, activation snapshot kept', () => {
    it('member reads get the live payload plus the activation one; a share flag turned off removes the item; resolved incidents freeze; a new incident carries the latest', async () => {
      const rita = await createUser(client, { fullName: 'Rita Resident' });
      const milo = await createUser(client);
      const circle = await createCircle(client, rita);
      await addActiveMember(client, circle, milo);
      await add(rita, 'allergies', 'Peanuts');
      await add(rita, 'medical-conditions', 'Asthma');
      await patchSharingFlags(app, rita.id, {
        share_allergies: true,
        share_medical_conditions: true,
        share_blood_type: true,
      });
      const submitted = await submitAlert(app, rita.id, 'medical');
      const id = submitted.json<Body>().id as string;
      const atActivation = {
        blood_type: 'Unknown',
        allergies: ['Peanuts'],
        medical_conditions: ['Asthma'],
      };
      expect(submitted.json<Body>().share_payload).toEqual(atActivation);

      // Before any change: the live view is the snapshot, never written.
      let details = (await getIncidentDetails(app, milo.id, id)).json<Body>();
      expect(details).toMatchObject({
        share_payload: atActivation,
        share_payload_at_activation: atActivation,
        share_payload_updated_at: null,
      });
      expect((await incidentRow(id)).live_share_payload).toBeNull();

      // Rita adds an allergy and turns condition sharing off during the alert.
      await add(rita, 'allergies', 'Latex');
      await patchSharingFlags(app, rita.id, { share_medical_conditions: false });
      const live = { blood_type: 'Unknown', allergies: ['Peanuts', 'Latex'] };
      details = (await getIncidentDetails(app, milo.id, id)).json<Body>();
      expect(details.share_payload).toEqual(live);
      expect(details.share_payload_at_activation).toEqual(atActivation);
      expect(details.share_payload_updated_at).toMatch(UTC_TEXT);
      const row = await incidentRow(id);
      expect(row.share_payload).toEqual(atActivation);
      expect(row.live_share_payload).toEqual(live);

      // The resident's own reads keep the activation snapshot (what was sent).
      const open = (await getOpenIncident(app, rita.id)).json<{ open_incident: Body }>();
      expect(open.open_incident.share_payload).toEqual(atActivation);

      // A write that changes nothing shared does not touch the live view.
      const before = (await incidentRow(id)).live_share_updated_at;
      await putEmergencyInfo(
        app,
        rita.id,
        emergencyInfoBody({
          blood_type: 'Unknown',
          share_blood_type: true,
          share_allergies: true,
          share_medical_conditions: false,
        }),
      );
      expect((await incidentRow(id)).live_share_updated_at).toEqual(before);

      // Blood type and an emergency-info field shared now: in the live view at once.
      await putEmergencyInfo(
        app,
        rita.id,
        emergencyInfoBody({
          blood_type: 'O+',
          share_blood_type: true,
          share_allergies: true,
          share_emergency_contact_full_name: true,
        }),
      );
      expect((await getIncidentDetails(app, milo.id, id)).json<Body>().share_payload).toEqual({
        emergency_contact_full_name: 'Musa Contact',
        blood_type: 'O+',
        allergies: ['Peanuts', 'Latex'],
      });

      // Mark safe: the resolved incident freezes; later edits do not reach it.
      expect((await markSafe(app, rita.id, id)).statusCode).toBe(200);
      const frozen = (await incidentRow(id)).live_share_payload;
      await add(rita, 'allergies', 'Shellfish');
      expect((await incidentRow(id)).live_share_payload).toEqual(frozen);
      expect((await incidentRow(id)).share_payload).toEqual(atActivation);

      // A new incident carries the latest info (AC3).
      const next = await submitAlert(app, rita.id, 'fire');
      expect(next.json<Body>().share_payload).toEqual({
        emergency_contact_full_name: 'Musa Contact',
        blood_type: 'O+',
        allergies: ['Peanuts', 'Latex', 'Shellfish'],
      });
      const nextDetails = (
        await getIncidentDetails(app, milo.id, next.json<Body>().id as string)
      ).json<Body>();
      expect(nextDetails.share_payload).toEqual(nextDetails.share_payload_at_activation);
      await markSafe(app, rita.id, next.json<Body>().id as string);
    });

    it('an incident from before SCRUM-21 (string values) keeps its snapshot; the live view uses arrays', async () => {
      const resident = await createUser(client);
      const member = await createUser(client);
      const circle = await createCircle(client, resident);
      await addActiveMember(client, circle, member);
      const reply = await submitAlert(app, resident.id, 'medical');
      const id = reply.json<Body>().id as string;
      await client.query(
        `update public.incidents set share_payload = '{"allergies": "Peanuts"}'::jsonb where id = $1`,
        [id],
      );
      await patchSharingFlags(app, resident.id, { share_allergies: true });
      await add(resident, 'allergies', 'Peanuts');
      const details = (await getIncidentDetails(app, member.id, id)).json<Body>();
      expect(details.share_payload_at_activation).toEqual({ allergies: 'Peanuts' });
      expect(details.share_payload).toEqual({ allergies: ['Peanuts'] });
      await markSafe(app, resident.id, id);
    });
  });

  describe('migration 0014 back-fill', () => {
    it('each non-blank old text becomes ONE item (not split); blank stays empty; a re-run adds nothing', async () => {
      const user = await createUser(client);
      const blank = await createUser(client);
      await client.query(
        `update public.profiles
            set allergies = '  Peanuts, dust and pollen ', medical_conditions = 'Asthma'
          where id = $1`,
        [user.id],
      );
      await client.query(
        `update public.profiles set allergies = '   ', medical_conditions = null where id = $1`,
        [blank.id],
      );
      await client.query(MIGRATION_0014);
      await client.query(MIGRATION_0014);
      const profile = (await getProfile(app, user.id)).json<Body>();
      expect(itemsOf(profile, 'allergies').map((i) => i.text)).toEqual([
        'Peanuts, dust and pollen',
      ]);
      expect(itemsOf(profile, 'medical-conditions').map((i) => i.text)).toEqual(['Asthma']);
      // Back-filled profiles get no "last updated" time (unknown).
      expect(profile.medical_info_updated_at).toBeNull();
      const other = (await getProfile(app, blank.id)).json<Body>();
      expect(itemsOf(other, 'allergies')).toEqual([]);
      expect(itemsOf(other, 'medical-conditions')).toEqual([]);
      // The user edits it: the old column follows the items.
      const id = itemsOf(profile, 'allergies')[0].id;
      await editMedicalItem(app, user.id, 'allergies', id, { text: 'Peanuts' });
      await add(user, 'allergies', 'Dust');
      expect((await profileRow(user.id)).allergies).toBe('Peanuts, Dust');
    });

    it('schema: owner-only tables with cascade delete, no Supabase role access', async () => {
      const { rows } = await client.query<{ name: string; rls: boolean }>(
        `select c.relname as name, c.relrowsecurity as rls from pg_class c
          where c.oid in ('public.profile_allergies'::regclass,
                          'public.profile_medical_conditions'::regclass)
          order by 1`,
      );
      expect(rows).toEqual([
        { name: 'profile_allergies', rls: true },
        { name: 'profile_medical_conditions', rls: true },
      ]);
      const grants = await client.query(
        `select table_name, grantee from information_schema.role_table_grants
          where table_name in ('profile_allergies', 'profile_medical_conditions')
            and grantee in ('anon', 'authenticated', 'PUBLIC')`,
      );
      expect(grants.rows).toEqual([]);
      const user = await createUser(client);
      await add(user, 'allergies', 'Peanuts');
      await client.query('delete from public.profiles where id = $1', [user.id]);
      await client.query('delete from public.users where id = $1', [user.id]);
      const left = await client.query('select 1 from public.profile_allergies where user_id = $1', [
        user.id,
      ]);
      expect(left.rows).toEqual([]);
    });
  });
});
