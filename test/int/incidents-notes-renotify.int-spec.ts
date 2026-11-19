import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import {
  INCIDENT_POST_COMMIT_HOOKS,
  type IncidentNotesEvent,
  type IncidentRenotifiedEvent,
} from '../../src/modules/incidents/incident-post-commit';
import { createTestApp, type LogCapture, withTestConfig } from '../../src/testing/test-app';
import { authHeader } from '../../src/testing/test-tokens';
import { openTestClient } from '../support/database';
import {
  addActiveMember,
  type CircleFixture,
  createCircle,
  createUser,
  type UserFixture,
} from '../support/fixtures';
import {
  attachLocation,
  callSqlAs,
  countRows,
  getOpenIncident,
  markSafeViaSql,
  renotifyAlert,
  setIncidentNotes,
  setNotesViaPostgrest,
  type SqlOutcome,
  submitAlert,
} from '../support/incident-api';

/**
 * `PUT /v1/incidents/{id}/notes` and `POST /v1/incidents/{id}/renotify` (API-100-18) beyond the SQL
 * scripts: trimming and counting exactly as Postgres, check order, audit without the note, hooks,
 * re-notify parity with submit, races on separate connections, and interchangeability with the SQL
 * functions. Also proves the shared JSON split (INCIDENT_SHARED_JSON) left every body byte-identical.
 */
type Body = Record<string, unknown>;
type Reply = Awaited<ReturnType<typeof setIncidentNotes>>;

const PARALLEL = 10;

const notesCalls: IncidentNotesEvent[] = [];
const renotifyCalls: IncidentRenotifiedEvent[] = [];

describe('live note and explicit re-notify (API-100-18)', () => {
  let app: NestFastifyApplication;
  let logs: LogCapture;
  let client: Client;
  let baseUrl: string;

  beforeAll(async () => {
    ({ app, logs } = await createTestApp({}, (builder) =>
      withTestConfig({ DATABASE_POOL_MAX: String(PARALLEL * 3) })(builder)
        .overrideProvider(INCIDENT_POST_COMMIT_HOOKS)
        .useValue([
          {
            afterNotes: (event: IncidentNotesEvent) => {
              notesCalls.push(event);
            },
            afterRenotify: (event: IncidentRenotifiedEvent) => {
              renotifyCalls.push(event);
            },
          },
        ]),
    ));
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
    client = await openTestClient();
  });

  afterAll(async () => {
    await client.end();
    await app.close();
  });

  beforeEach(() => {
    notesCalls.length = 0;
    renotifyCalls.length = 0;
  });

  const errorOf = (reply: Reply) => reply.json<{ error: { code: string; details: Body } }>().error;

  async function activeAlert(members = 1): Promise<{
    resident: UserFixture;
    circle: CircleFixture;
    memberUsers: UserFixture[];
    incidentId: string;
  }> {
    const resident = await createUser(client);
    const circle = await createCircle(client, resident);
    const memberUsers: UserFixture[] = [];
    for (let i = 0; i < members; i++) {
      const user = await createUser(client);
      await addActiveMember(client, circle, user);
      memberUsers.push(user);
    }
    const incident = (await submitAlert(app, resident.id, 'medical')).json<Body>();
    return { resident, circle, memberUsers, incidentId: incident.id as string };
  }

  /** A legacy row (statuses the API cannot create). */
  async function legacyIncident(status: 'activating' | 'cancelled') {
    const resident = await createUser(client);
    const { rows } = await client.query<{ id: string }>(
      `insert into public.incidents (resident_id, status, emergency_type, cancelled_at)
       values ($1, $2, 'unspecified', case when $2 = 'cancelled' then now() end) returning id`,
      [resident.id, status],
    );
    return { resident, incidentId: rows[0].id };
  }

  const stored = async (incidentId: string) => {
    const { rows } = await client.query<{
      incident_notes: string | null;
      incident_notes_updated_at: Date | null;
      share_payload: Body | null;
    }>(
      `select incident_notes, incident_notes_updated_at, share_payload
         from public.incidents where id = $1`,
      [incidentId],
    );
    return rows[0];
  };

  const viaSql = async (
    incidentId: string,
    fn: '_incident_activation_json' | '_incident_send_json',
  ) => {
    await client.query(`set timezone = 'UTC'`);
    const { rows } = await client.query<{ body: Body }>(
      `select public.${fn}(i) as body from public.incidents i where i.id = $1`,
      [incidentId],
    );
    return rows[0].body;
  };

  describe('notes: AC1 authorization and status', () => {
    it('without a token: 401 set_incident_notes:not_authenticated', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/v1/incidents/${randomUUID()}/notes`,
        headers: { 'content-type': 'application/json' },
        payload: '{"incident_notes":"x"}',
      });
      expect(res.statusCode).toBe(401);
      expect(errorOf(res).code).toBe('set_incident_notes:not_authenticated');
    });

    it("unknown, another resident's, or a member's view: 404 not_found", async () => {
      const { incidentId, memberUsers, resident } = await activeAlert();
      const outsider = await createUser(client);
      for (const [userId, id] of [
        [resident.id, randomUUID()],
        [outsider.id, incidentId],
        [memberUsers[0].id, incidentId],
      ]) {
        const res = await setIncidentNotes(app, userId, id, { incident_notes: 'x' });
        expect(res.statusCode).toBe(404);
        expect(errorOf(res).code).toBe('set_incident_notes:not_found');
      }
    });

    it('a legacy activating incident accepts a note (activating/active per AC1)', async () => {
      const { resident, incidentId } = await legacyIncident('activating');
      const res = await setIncidentNotes(app, resident.id, incidentId, { incident_notes: 'x' });
      expect(res.statusCode).toBe(200);
      expect(res.json<Body>()).toMatchObject({ status: 'activating', incident_notes: 'x' });
    });

    it('cancelled and resolved: 409 not_open, nothing written', async () => {
      const cancelled = await legacyIncident('cancelled');
      const resolved = await activeAlert();
      await markSafeViaSql(client, resolved.resident.id, resolved.incidentId);
      for (const { resident, incidentId } of [cancelled, resolved]) {
        const res = await setIncidentNotes(app, resident.id, incidentId, { incident_notes: 'x' });
        expect(res.statusCode).toBe(409);
        expect(errorOf(res).code).toBe('set_incident_notes:not_open');
        expect(await stored(incidentId)).toMatchObject({
          incident_notes: null,
          incident_notes_updated_at: null,
        });
      }
    });

    it('check order: not_found and not_open come before too_long', async () => {
      const long = 'x'.repeat(251);
      const { incidentId } = await activeAlert();
      const other = await createUser(client);
      expect(
        errorOf(await setIncidentNotes(app, other.id, incidentId, { incident_notes: long })).code,
      ).toBe('set_incident_notes:not_found');
      const resolved = await activeAlert();
      await markSafeViaSql(client, resolved.resident.id, resolved.incidentId);
      expect(
        errorOf(
          await setIncidentNotes(app, resolved.resident.id, resolved.incidentId, {
            incident_notes: long,
          }),
        ).code,
      ).toBe('set_incident_notes:not_open');
    });
  });

  describe('notes: AC2 trimming and length, exactly as Postgres', () => {
    const emoji = '\u{1F600}';
    const combining = 'é';
    /** [name, value sent, stored value, or 'too_long']. */
    const CASES: [string, string | null | undefined, string | null][] = [
      ['plain', 'Gate code 1234', 'Gate code 1234'],
      ['spaces around', '   Second floor   ', 'Second floor'],
      ['tabs are not trimmed (btrim removes spaces only)', '\tSecond floor\t', '\tSecond floor\t'],
      ['newlines are kept', '\nSecond floor\n', '\nSecond floor\n'],
      ['no-break spaces are kept', ' x ', ' x '],
      ['empty → null', '', null],
      ['spaces only → null', '     ', null],
      ['explicit null → null', null, null],
      ['missing key → null', undefined, null],
      ['250 ASCII characters', 'a'.repeat(250), 'a'.repeat(250)],
      ['250 characters plus spaces around', `  ${'a'.repeat(250)}  `, 'a'.repeat(250)],
      ['250 emoji (500 UTF-16 units)', emoji.repeat(250), emoji.repeat(250)],
      ['125 e + combining accent (250 code points)', combining.repeat(125), combining.repeat(125)],
    ];

    it.each(CASES)('%s', async (_name, value, expected) => {
      const { resident, incidentId } = await activeAlert();
      const body = value === undefined ? {} : { incident_notes: value };
      const before = await stored(incidentId);
      const res = await setIncidentNotes(app, resident.id, incidentId, body);

      expect(res.statusCode).toBe(200);
      expect(res.json<Body>().incident_notes).toBe(expected);
      const after = await stored(incidentId);
      expect(after.incident_notes).toBe(expected);
      expect(after.incident_notes_updated_at).not.toBeNull();
      expect(after.share_payload).toEqual(before.share_payload);
      expect(res.body).toBe(JSON.stringify(await viaSql(incidentId, '_incident_activation_json')));
    });

    it.each([
      ['251 ASCII characters', 'a'.repeat(251)],
      ['251 emoji', emoji.repeat(251)],
      ['126 e + combining accent (252 code points)', combining.repeat(126)],
      ['250 characters and a tab', `${'a'.repeat(250)}\t`],
    ])('%s → 422 too_long, nothing written', async (_name, value) => {
      const { resident, incidentId } = await activeAlert();
      await setIncidentNotes(app, resident.id, incidentId, { incident_notes: 'kept' });
      const before = await stored(incidentId);

      const res = await setIncidentNotes(app, resident.id, incidentId, { incident_notes: value });
      expect(res.statusCode).toBe(422);
      expect(errorOf(res).code).toBe('set_incident_notes:too_long');
      expect(await stored(incidentId)).toEqual(before);
    });

    it('incident_notes_updated_at is stamped on every write, also when clearing', async () => {
      const { resident, incidentId } = await activeAlert();
      const stamps: string[] = [];
      for (const value of ['one', 'one', null, '   ']) {
        const res = await setIncidentNotes(app, resident.id, incidentId, { incident_notes: value });
        stamps.push(res.json<Body>().incident_notes_updated_at as string);
      }
      expect(stamps.every((s) => typeof s === 'string')).toBe(true);
      expect(new Set(stamps).size).toBe(stamps.length);
    });

    it('never copied into share_payload; status, type and location unchanged', async () => {
      const { resident, incidentId } = await activeAlert();
      await client.query(
        `update public.profiles set allergies = 'Peanuts', share_allergies = true where id = $1`,
        [resident.id],
      );
      await attachLocation(app, resident.id, incidentId, {
        location_source: 'current',
        location_lat: 1,
        location_lng: 2,
        location_accuracy_m: 3,
        location_captured_at: '2026-11-19T10:00:00Z',
      });
      const snapshot = async () => {
        const { rows } = await client.query<Body>(
          `select status, emergency_type, share_payload, sent_at, cancelled_at, location_source,
                  location_lat, location_lng, location_accuracy_m, location_captured_at,
                  renotified_at, resolved_at, circle_id
             from public.incidents where id = $1`,
          [incidentId],
        );
        return rows[0];
      };
      const before = await snapshot();
      await setIncidentNotes(app, resident.id, incidentId, { incident_notes: 'Gate code 1234' });
      expect(await snapshot()).toEqual(before);
      expect(JSON.stringify(before.share_payload)).not.toContain('Gate code');
    });
  });

  describe('notes: request conversion', () => {
    it.each([
      ['an array body', '[]', 'body'],
      ['a string body', '"x"', 'body'],
      ['a null body', 'null', 'body'],
      ['a number', '{"incident_notes":42}', 'incident_notes'],
      ['a boolean', '{"incident_notes":true}', 'incident_notes'],
      ['an object', '{"incident_notes":{"a":1}}', 'incident_notes'],
      ['NUL', '{"incident_notes":"a\\u0000b"}', 'incident_notes'],
      ['an unpaired surrogate', '{"incident_notes":"a\\udc00b"}', 'incident_notes'],
    ])('%s → 422 validation:invalid_request, nothing written', async (_name, json, field) => {
      const { resident, incidentId } = await activeAlert();
      const res = await setIncidentNotes(app, resident.id, incidentId, json);
      expect(res.statusCode).toBe(422);
      expect(errorOf(res)).toMatchObject({
        code: 'validation:invalid_request',
        details: { field },
      });
      expect(await stored(incidentId)).toMatchObject({ incident_notes_updated_at: null });
    });

    it('an invalid {id} is 422 on field id before anything else', async () => {
      const { id } = await createUser(client);
      const res = await setIncidentNotes(app, id, 'abc', '[]');
      expect(errorOf(res)).toMatchObject({
        code: 'validation:invalid_request',
        details: { field: 'id' },
      });
    });

    it('unknown keys are ignored', async () => {
      const { resident, incidentId } = await activeAlert();
      const res = await setIncidentNotes(app, resident.id, incidentId, {
        incident_notes: 'x',
        p_incident_notes: 'y',
      });
      expect(res.json<Body>().incident_notes).toBe('x');
    });

    it('PostgREST parity: same outcome for strings, nulls and text Postgres refuses', async () => {
      const kind = (outcome: SqlOutcome) =>
        outcome.ok ? (outcome.body.incident_notes as string | null) : outcome.code;
      for (const json of [
        '{"incident_notes":"  x  "}',
        '{"incident_notes":null}',
        '{}',
        `{"incident_notes":"${'b'.repeat(251)}"}`,
        `{"incident_notes":"${'\\ud83d\\ude00'.repeat(250)}"}`,
        '{"incident_notes":"a\\u0000b"}',
      ]) {
        const a = await activeAlert();
        const b = await activeAlert();
        const api = await setIncidentNotes(app, a.resident.id, a.incidentId, json);
        const sql = await setNotesViaPostgrest(client, b.resident.id, b.incidentId, json);
        const apiKind =
          api.statusCode === 200
            ? api.json<Body>().incident_notes
            : errorOf(api).code === 'validation:invalid_request'
              ? 'conversion'
              : errorOf(api).code;
        const sqlKind = !sql.ok && sql.sqlState.startsWith('22') ? 'conversion' : kind(sql);
        expect(apiKind).toEqual(sqlKind);
      }
    });

    it('documented difference: a JSON number is refused; PostgREST would store its text', async () => {
      const a = await activeAlert();
      const sql = await setNotesViaPostgrest(
        client,
        a.resident.id,
        a.incidentId,
        '{"incident_notes":1.50}',
      );
      expect(sql).toMatchObject({ ok: true, body: { incident_notes: '1.50' } });
      const b = await activeAlert();
      expect(
        (await setIncidentNotes(app, b.resident.id, b.incidentId, '{"incident_notes":1.50}'))
          .statusCode,
      ).toBe(422);
    });
  });

  describe('notes: audit and hook', () => {
    it('audit incident.notes_set never holds the note; the hook gets ids and cleared only', async () => {
      const { resident, circle, incidentId } = await activeAlert();
      const start = logs.text.length;
      await setIncidentNotes(app, resident.id, incidentId, { incident_notes: 'Back door 4321' });
      await setIncidentNotes(app, resident.id, incidentId, { incident_notes: '  ' });

      const { rows } = await client.query<Body>(
        `select action, actor_user_id, target_type, target_id, detail
           from public.audit_log where target_id = $1 and action = 'incident.notes_set'
          order by id`,
        [incidentId],
      );
      expect(rows).toEqual([
        {
          action: 'incident.notes_set',
          actor_user_id: resident.id,
          target_type: 'incident',
          target_id: incidentId,
          detail: { cleared: false },
        },
        {
          action: 'incident.notes_set',
          actor_user_id: resident.id,
          target_type: 'incident',
          target_id: incidentId,
          detail: { cleared: true },
        },
      ]);
      expect(notesCalls).toEqual([
        { incident_id: incidentId, resident_id: resident.id, circle_id: circle.id, cleared: false },
        { incident_id: incidentId, resident_id: resident.id, circle_id: circle.id, cleared: true },
      ]);
      expect(logs.text.slice(start)).not.toContain('4321');
    });

    it('a rejected write leaves no audit row and runs no hook', async () => {
      const { resident, incidentId } = await activeAlert();
      await setIncidentNotes(app, resident.id, incidentId, { incident_notes: 'x'.repeat(300) });
      expect(
        await countRows(
          client,
          `select count(*)::int as n from public.audit_log where target_id = $1 and action = 'incident.notes_set'`,
          [incidentId],
        ),
      ).toBe(0);
      expect(notesCalls).toEqual([]);
    });
  });

  describe('renotify: AC4', () => {
    it('without a token: 401 renotify_emergency_alert:not_authenticated', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/incidents/${randomUUID()}/renotify`,
      });
      expect(res.statusCode).toBe(401);
      expect(errorOf(res).code).toBe('renotify_emergency_alert:not_authenticated');
    });

    it('the same re-notify as a submit on an active alert; IncidentSend, the SQL helper bytes', async () => {
      const { resident, circle, memberUsers, incidentId } = await activeAlert(3);
      await client.query(
        `update public.incident_deliveries set acknowledged_at = now()
          where incident_id = $1 and member_user_id = $2`,
        [incidentId, memberUsers[0].id],
      );
      // Joined after the alert started: no delivery, and re-notify adds none (rule 29, rule 54).
      const late = await createUser(client);
      await addActiveMember(client, circle, late);
      const before = (
        await client.query<Body>(
          `select emergency_type, share_payload, circle_id, sent_at, status from public.incidents where id = $1`,
          [incidentId],
        )
      ).rows[0];
      const deliveriesBefore = (
        await client.query<{
          member_user_id: string;
          delivered_at: Date;
          acknowledged_at: Date | null;
        }>(
          `select member_user_id, delivered_at, acknowledged_at from public.incident_deliveries
            where incident_id = $1 order by member_user_id`,
          [incidentId],
        )
      ).rows;

      const res = await renotifyAlert(app, resident.id, incidentId);

      expect(res.statusCode).toBe(200);
      const body = res.json<Body>();
      expect(body).toMatchObject({
        id: incidentId,
        status: 'active',
        delivered_count: 3,
        acknowledged_count: 1,
      });
      expect(body.renotified_at).toEqual(expect.any(String));
      expect(body).not.toHaveProperty('submit_outcome');
      expect(res.body).toBe(JSON.stringify(await viaSql(incidentId, '_incident_send_json')));

      const after = (
        await client.query<Body>(
          `select emergency_type, share_payload, circle_id, sent_at, status from public.incidents where id = $1`,
          [incidentId],
        )
      ).rows[0];
      expect(after).toEqual(before);
      const deliveriesAfter = (
        await client.query<{
          member_user_id: string;
          delivered_at: Date;
          acknowledged_at: Date | null;
        }>(
          `select member_user_id, delivered_at, acknowledged_at from public.incident_deliveries
            where incident_id = $1 order by member_user_id`,
          [incidentId],
        )
      ).rows;
      expect(deliveriesAfter.map((d) => d.member_user_id)).toEqual(
        deliveriesBefore.map((d) => d.member_user_id),
      );
      expect(deliveriesAfter.map((d) => d.acknowledged_at)).toEqual(
        deliveriesBefore.map((d) => d.acknowledged_at),
      );
      deliveriesAfter.forEach((d, i) =>
        expect(d.delivered_at.getTime()).toBeGreaterThanOrEqual(
          deliveriesBefore[i].delivered_at.getTime(),
        ),
      );
      const { rows: events } = await client.query<Body>(
        `select detail, actor_id from public.incident_events
          where incident_id = $1 and event_type = 'renotified'`,
        [incidentId],
      );
      expect(events).toEqual([{ detail: { recipient_count: 3 }, actor_id: resident.id }]);
    });

    it('no Idempotency-Key is required; a repeat re-notifies again', async () => {
      const { resident, incidentId } = await activeAlert(2);
      expect((await renotifyAlert(app, resident.id, incidentId)).statusCode).toBe(200);
      expect((await renotifyAlert(app, resident.id, incidentId)).statusCode).toBe(200);
      expect(
        await countRows(
          client,
          `select count(*)::int as n from public.incident_events where incident_id = $1 and event_type = 'renotified'`,
          [incidentId],
        ),
      ).toBe(2);
    });

    it("unknown, another resident's or a member's: 404 not_found", async () => {
      const { incidentId, memberUsers, resident } = await activeAlert();
      const outsider = await createUser(client);
      for (const [userId, id] of [
        [resident.id, randomUUID()],
        [outsider.id, incidentId],
        [memberUsers[0].id, incidentId],
      ]) {
        const res = await renotifyAlert(app, userId, id);
        expect(res.statusCode).toBe(404);
        expect(errorOf(res).code).toBe('renotify_emergency_alert:not_found');
      }
    });

    it('resolved, legacy activating and cancelled: 409 not_open, nothing written', async () => {
      const resolved = await activeAlert();
      await markSafeViaSql(client, resolved.resident.id, resolved.incidentId);
      for (const { resident, incidentId } of [
        resolved,
        await legacyIncident('activating'),
        await legacyIncident('cancelled'),
      ]) {
        const res = await renotifyAlert(app, resident.id, incidentId);
        expect(res.statusCode).toBe(409);
        expect(errorOf(res).code).toBe('renotify_emergency_alert:not_open');
        const { rows } = await client.query<Body>(
          'select renotified_at from public.incidents where id = $1',
          [incidentId],
        );
        expect(rows[0].renotified_at).toBeNull();
      }
      expect(renotifyCalls).toEqual([]);
    });

    it('an invalid {id} is 422 on field id', async () => {
      const { id } = await createUser(client);
      const res = await renotifyAlert(app, id, 'not-a-uuid');
      expect(res.statusCode).toBe(422);
      expect(errorOf(res)).toMatchObject({
        code: 'validation:invalid_request',
        details: { field: 'id' },
      });
    });

    it('AC5: audit incident.renotified {recipient_count} and hook incident.renotified', async () => {
      const { resident, circle, incidentId } = await activeAlert(2);
      await renotifyAlert(app, resident.id, incidentId);
      const { rows } = await client.query<Body>(
        `select detail from public.audit_log where target_id = $1 and action = 'incident.renotified'`,
        [incidentId],
      );
      expect(rows).toEqual([{ detail: { recipient_count: 2 } }]);
      expect(renotifyCalls).toEqual([
        {
          incident_id: incidentId,
          resident_id: resident.id,
          circle_id: circle.id,
          recipient_count: 2,
        },
      ]);
    });
  });

  describe('INCIDENT_SHARED_JSON split: existing bodies are byte-identical to the SQL helpers', () => {
    it('submit (minus submit_outcome), open read, renotify = _incident_send_json; notes = activation json', async () => {
      const { resident, incidentId } = await activeAlert(2);
      await attachLocation(app, resident.id, incidentId, {
        location_source: 'current',
        location_lat: 9.03,
        location_lng: 38.74,
        location_accuracy_m: 12.5,
        location_captured_at: '2026-11-19T10:00:00.123456Z',
      });
      const notes = await setIncidentNotes(app, resident.id, incidentId, { incident_notes: 'x' });
      expect(notes.body).toBe(
        JSON.stringify(await viaSql(incidentId, '_incident_activation_json')),
      );

      const resubmit = await submitAlert(app, resident.id, 'fire');
      const { submit_outcome: outcome, ...send } = resubmit.json<Body>();
      expect(outcome).toBe('renotified');
      const sendViaSql = await viaSql(incidentId, '_incident_send_json');
      expect(JSON.stringify(send)).toBe(JSON.stringify(sendViaSql));
      // The submit body is `_incident_send_json(rec) || {submit_outcome}`, built by Postgres (jsonb key order).
      const { rows } = await client.query<{ body: Body }>(
        `select public._incident_send_json(i) || jsonb_build_object('submit_outcome', 'renotified') as body
           from public.incidents i where i.id = $1`,
        [incidentId],
      );
      expect(resubmit.body).toBe(JSON.stringify(rows[0].body));
      expect((await getOpenIncident(app, resident.id)).body).toBe(
        `{"open_incident":${JSON.stringify(sendViaSql)}}`,
      );

      const renotified = await renotifyAlert(app, resident.id, incidentId);
      expect(renotified.body).toBe(JSON.stringify(await viaSql(incidentId, '_incident_send_json')));
    });
  });

  describe('races on separate connections', () => {
    const request = async (method: string, path: string, userId: string, body?: unknown) => {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          ...(await authHeader(userId)),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(method === 'POST' && path === '/v1/incidents'
            ? { 'idempotency-key': randomUUID() }
            : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as Body };
    };
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    async function waitForLockWaiters(n: number) {
      for (let i = 0; i < 200; i++) {
        const waiting = await countRows(
          client,
          `select count(*)::int as n from pg_stat_activity
            where wait_event_type = 'Lock' and datname = current_database()`,
        );
        if (waiting >= n) return;
        await sleep(25);
      }
      throw new Error(`fewer than ${n} sessions waiting on a lock`);
    }

    /** Runs mark_incident_safe on its own connection and leaves it uncommitted. */
    async function closeUncommitted(residentId: string, incidentId: string) {
      const closer = await openTestClient();
      await closer.query('begin');
      await closer.query(
        `select set_config('request.jwt.claim.sub', $1, true),
                set_config('request.jwt.claims', $2, true)`,
        [residentId, JSON.stringify({ sub: residentId, role: 'authenticated' })],
      );
      await closer.query('select public.mark_incident_safe($1)', [incidentId]);
      return {
        commit: async () => {
          await closer.query('commit');
          await closer.end();
        },
      };
    }

    it('notes queued behind mark safe: not_open once the close commits, note unchanged', async () => {
      const { resident, incidentId } = await activeAlert();
      await setIncidentNotes(app, resident.id, incidentId, { incident_notes: 'before' });
      const close = await closeUncommitted(resident.id, incidentId);
      const notes = request('PUT', `/v1/incidents/${incidentId}/notes`, resident.id, {
        incident_notes: 'after',
      });
      await waitForLockWaiters(1);
      await close.commit();

      const reply = await notes;
      expect(reply.status).toBe(409);
      expect((reply.body as { error: { code: string } }).error.code).toBe(
        'set_incident_notes:not_open',
      );
      expect(await stored(incidentId)).toMatchObject({ incident_notes: 'before' });
    });

    it('renotify queued behind mark safe: not_open, no renotified event', async () => {
      const { resident, incidentId } = await activeAlert();
      const close = await closeUncommitted(resident.id, incidentId);
      const renotify = request('POST', `/v1/incidents/${incidentId}/renotify`, resident.id);
      await waitForLockWaiters(1);
      await close.commit();

      const reply = await renotify;
      expect(reply.status).toBe(409);
      expect((reply.body as { error: { code: string } }).error.code).toBe(
        'renotify_emergency_alert:not_open',
      );
      expect(
        await countRows(
          client,
          `select count(*)::int as n from public.incident_events where incident_id = $1 and event_type = 'renotified'`,
          [incidentId],
        ),
      ).toBe(0);
    });

    it(`renotify racing submit (${PARALLEL} each): one incident, every call re-notifies once`, async () => {
      const { resident, incidentId } = await activeAlert(2);
      const replies = await Promise.all(
        Array.from({ length: PARALLEL }, (_, i) =>
          i % 2 === 0
            ? request('POST', `/v1/incidents/${incidentId}/renotify`, resident.id)
            : request('POST', '/v1/incidents', resident.id, { emergency_type: 'fire' }),
        ).concat(
          Array.from({ length: PARALLEL }, (_, i) =>
            i % 2 === 0
              ? request('POST', '/v1/incidents', resident.id, { emergency_type: 'fire' })
              : request('POST', `/v1/incidents/${incidentId}/renotify`, resident.id),
          ),
        ),
      );
      expect(replies.map((r) => r.status)).toEqual(Array(PARALLEL * 2).fill(200));
      expect(replies.every((r) => r.body.id === incidentId)).toBe(true);
      expect(
        await countRows(
          client,
          'select count(*)::int as n from public.incidents where resident_id = $1',
          [resident.id],
        ),
      ).toBe(1);
      expect(
        await countRows(
          client,
          `select count(*)::int as n from public.incident_events
            where incident_id = $1 and event_type = 'renotified' and (detail->>'recipient_count')::int = 2`,
          [incidentId],
        ),
      ).toBe(PARALLEL * 2);
      expect(
        await countRows(
          client,
          'select count(*)::int as n from public.incident_deliveries where incident_id = $1',
          [incidentId],
        ),
      ).toBe(2);
      expect(
        await countRows(
          client,
          `select count(*)::int as n from public.incident_events
            where incident_id = $1 and event_type = 'alert_sent'`,
          [incidentId],
        ),
      ).toBe(1);
    });

    it('notes from the API and the SQL function interleaved: each write lands whole', async () => {
      const { resident, incidentId } = await activeAlert();
      const sqlClients = await Promise.all(Array.from({ length: 4 }, () => openTestClient()));
      try {
        const values = Array.from({ length: 8 }, (_, i) => `note ${i}`);
        await Promise.all(
          values.map((value, i) =>
            i % 2 === 0
              ? request('PUT', `/v1/incidents/${incidentId}/notes`, resident.id, {
                  incident_notes: value,
                })
              : callSqlAs(
                  sqlClients[(i - 1) / 2],
                  resident.id,
                  'public.set_incident_notes($1, $2)',
                  [incidentId, value],
                ),
          ),
        );
        expect(values).toContain((await stored(incidentId)).incident_notes);
      } finally {
        await Promise.all(sqlClients.map((c) => c.end()));
      }
    });
  });

  describe('interchangeable with the SQL functions', () => {
    /** Two residents in the same state, one driven by the API and one by SQL. */
    async function twins() {
      return [await activeAlert(2), await activeAlert(2)] as const;
    }

    const comparable = (body: Body) => {
      const copy: Body = { ...body };
      for (const key of [
        'id',
        'resident_id',
        'circle_id',
        'activated_at',
        'sent_at',
        'renotified_at',
        'incident_notes_updated_at',
      ]) {
        copy[key] = copy[key] === null ? null : 'set';
      }
      return copy;
    };

    it('notes: same body shape and the same stored note for every input', async () => {
      for (const value of ['  a b  ', '', null, '\tx', 'a'.repeat(250)]) {
        const [a, b] = await twins();
        const api = await setIncidentNotes(app, a.resident.id, a.incidentId, {
          incident_notes: value,
        });
        const sql = await callSqlAs<Body>(
          client,
          b.resident.id,
          'public.set_incident_notes($1, $2)',
          [b.incidentId, value],
        );
        expect(comparable(api.json<Body>())).toEqual(comparable(sql));
      }
    });

    it('notes: each side reads what the other wrote', async () => {
      const { resident, incidentId } = await activeAlert();
      await callSqlAs(client, resident.id, 'public.set_incident_notes($1, $2)', [
        incidentId,
        'from sql',
      ]);
      const open = (await getOpenIncident(app, resident.id)).json<{ open_incident: Body }>()
        .open_incident;
      expect(open.incident_notes).toBe('from sql');
      await setIncidentNotes(app, resident.id, incidentId, { incident_notes: 'from api' });
      const viaSqlOpen = await callSqlAs<Body>(
        client,
        resident.id,
        'public.get_my_open_incident()',
      );
      expect(viaSqlOpen.incident_notes).toBe('from api');
    });

    it('renotify: same rows and events written by the API and by the SQL function', async () => {
      const [a, b] = await twins();
      const api = (await renotifyAlert(app, a.resident.id, a.incidentId)).json<Body>();
      const sql = await callSqlAs<Body>(
        client,
        b.resident.id,
        'public.renotify_emergency_alert($1)',
        [b.incidentId],
      );
      expect(comparable(api)).toEqual(comparable(sql));
      const events = async (id: string) =>
        (
          await client.query<Body>(
            `select event_type, detail - 'recipient_ids' as detail, jsonb_array_length(detail->'recipient_ids') as recipients
               from public.incident_events where incident_id = $1 order by occurred_at, event_type`,
            [id],
          )
        ).rows;
      expect(await events(a.incidentId)).toEqual(await events(b.incidentId));
    });

    it('renotify: API and SQL calls on one incident each refresh the same deliveries', async () => {
      const { resident, incidentId } = await activeAlert(2);
      await renotifyAlert(app, resident.id, incidentId);
      await callSqlAs(client, resident.id, 'public.renotify_emergency_alert($1)', [incidentId]);
      const res = await renotifyAlert(app, resident.id, incidentId);
      expect(res.json<Body>()).toMatchObject({ delivered_count: 2 });
      expect(
        await countRows(
          client,
          `select count(*)::int as n from public.incident_events
            where incident_id = $1 and event_type = 'renotified' and (detail->>'recipient_count')::int = 2`,
          [incidentId],
        ),
      ).toBe(3);
    });
  });
});
