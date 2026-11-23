import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { createTestApp, withTestConfig } from '../../src/testing/test-app';
import {
  acceptInvite,
  cancelInvite,
  createInviteLink,
  declineInvite,
  getCapacity,
  invitePhone,
  inviteBatch,
  leaveCircle,
  listJoinedCircles,
  listMembers,
  listMyInvites,
  lookupInvite,
  previewInvite,
  removeMember,
  resendInvite,
} from '../support/circle-api';
import { openTestClient } from '../support/database';
import { createCircle, createUser, type UserFixture } from '../support/fixtures';
import { sqlOutcomeAs } from '../support/incident-api';
import {
  insertMember,
  withoutActiveIncidentId,
  withoutOwnerAvatarUrl,
} from '../support/invite-rows';

/**
 * API-100-33 AC4: the SQL functions and the API are interchangeable writers of circles and invites.
 * One scenario (phone, batch and link invites; lookup, preview, accept, decline, cancel, resend,
 * the incoming list, remove, leave, the member list, capacity and joined circles, plus a few error
 * cases) runs five times on fresh users:
 *
 * - `sql` and `api`: everything through one side (the references);
 * - `sql→api`: the invites are created by the SQL RPCs (today's app), everything after through the
 *   API (accepted, declined, canceled, resent, removed, left);
 * - `api→sql`: the invites are created by the API, everything after through the SQL RPCs;
 * - `mixed`: every step alternates between the two (so remove and leave are mixed too).
 *
 * Every step's outcome (body or `fn:code`) and the final `safety_circle_members` rows of the circle
 * must be the same in all runs, once ids, tokens and phones are replaced by role names and server
 * timestamps by their rank in the run. `audit_log` and `idempotency_keys` are API-only.
 *
 * Also here: the Phase 2 lists order by the timestamp's JSON text, as the SQL does (known
 * difference from strict time order, recorded in docs/phase2_handoff.md).
 */
type Body = Record<string, unknown>;
type Outcome = { ok: true; body: unknown } | { ok: false; code: string };
type Mode = 'sql' | 'api' | 'sql→api' | 'api→sql' | 'mixed';
type Side = 'sql' | 'api';

let counter = 0;
/** Ofcom's drama range (+44 7700 900000-900999): numbers reserved for fiction. */
const phoneNumber = () => `+447700900${String(100 + counter++).padStart(3, '0')}`;

interface Cast {
  owner: UserFixture;
  ben: UserFixture;
  cara: UserFixture;
  dan: UserFixture;
  eve: UserFixture;
  gus: UserFixture;
  hal: UserFixture;
  circleId: string;
  /** Exact strings (ids, tokens, phones) → role labels. */
  labels: Map<string, string>;
  /** Tokens → labels, also replaced inside longer strings (invite_url). */
  tokens: Map<string, string>;
}

describe('Phase 2 gate: SQL and API writers of circles and invites are interchangeable (API-100-33 AC4)', () => {
  let app: NestFastifyApplication;
  let client: Client;
  const normalized = {} as Record<Mode, { steps: Record<string, unknown>; rows: unknown }>;
  /**
   * D44 (deliberate divergence): the member rows the API kept as history (`removed` / `left`) where
   * the SQL deletes them, per mode, with the side that ran each step. They are left out of the
   * final-row comparison and checked on their own.
   */
  const endedHistory = {} as Record<
    Mode,
    {
      rows: Array<{ label: string; status: string; user: string; token: unknown }>;
      sides: Record<string, Side>;
      /** SQL-side list steps that saw (and had removed) an API history row. */
      sqlSawHistory: string[];
    }
  >;

  beforeAll(async () => {
    ({ app } = await createTestApp(
      {},
      withTestConfig({ RATE_LIMIT_AUTHENTICATED_MAX: '1000000', RATE_LIMIT_PUBLIC_MAX: '1000000' }),
    ));
    client = await openTestClient();
  });

  afterAll(async () => {
    await client?.end();
    await app?.close();
  });

  async function castFor(): Promise<Cast> {
    const owner = await createUser(client, { fullName: 'Mix Owner' });
    const ben = await createUser(client, { fullName: 'Mix Ben', phone: phoneNumber() });
    const cara = await createUser(client, { fullName: 'Mix Cara' });
    const dan = await createUser(client, { fullName: 'Mix Dan', phone: phoneNumber() });
    const eve = await createUser(client, { fullName: 'Mix Eve' });
    const gus = await createUser(client, { fullName: 'Mix Gus', phone: phoneNumber() });
    const hal = await createUser(client, { fullName: 'Mix Hal' });
    const circle = await createCircle(client, owner);
    const labels = new Map<string, string>([
      [circle.id, 'circle'],
      [circle.ownerMemberId, 'row:owner'],
    ]);
    for (const [name, user] of Object.entries({ owner, ben, cara, dan, eve, gus, hal })) {
      labels.set(user.id, name);
      if (user.phone) labels.set(user.phone, `phone:${name}`);
    }
    return { owner, ben, cara, dan, eve, gus, hal, circleId: circle.id, labels, tokens: new Map() };
  }

  const fromApi = (reply: Awaited<ReturnType<typeof getCapacity>>): Outcome =>
    reply.statusCode < 300
      ? { ok: true, body: reply.json<unknown>() }
      : { ok: false, code: reply.json<{ error: { code: string } }>().error.code };

  const fromSql = async (
    userId: string,
    call: string,
    params: unknown[] = [],
  ): Promise<Outcome> => {
    const outcome = await sqlOutcomeAs(client, userId, call, params);
    return outcome.ok ? { ok: true, body: outcome.body } : { ok: false, code: outcome.code };
  };

  /** The circle's member rows, timestamps in UTC as JSON text. */
  async function rowsOf(circleId: string): Promise<Body[]> {
    await client.query('begin');
    try {
      await client.query(`set local TimeZone = 'UTC'`);
      const { rows } = await client.query<{ row: Body }>(
        'select to_jsonb(m) as row from public.safety_circle_members m where circle_id = $1',
        [circleId],
      );
      return rows.map((r) => r.row);
    } finally {
      await client.query('commit');
    }
  }

  async function run(mode: Mode): Promise<{
    cast: Cast;
    steps: Record<string, Outcome>;
    ended: Body[];
    sides: Record<string, Side>;
    sqlSawHistory: string[];
  }> {
    const cast = await castFor();
    const sides: Record<string, Side> = {};
    const { owner, ben, cara, dan, eve, gus, hal, circleId } = cast;
    const steps: Record<string, Outcome> = {};
    const token = (label: string) =>
      [...cast.tokens].find(([, l]) => l === `token:${label}`)?.[0] ?? 'missing';
    const rowId = (label: string) =>
      [...cast.labels].find(([, l]) => l === `row:${label}`)?.[0] ?? randomUUID();
    let index = 0;

    /** Which side runs step number `n` (create steps first, then the rest). */
    const sideOf = (create: boolean): Side => {
      index += 1;
      switch (mode) {
        case 'sql':
        case 'api':
          return mode;
        case 'sql→api':
          return create ? 'sql' : 'api';
        case 'api→sql':
          return create ? 'api' : 'sql';
        case 'mixed':
          return index % 2 === 0 ? 'sql' : 'api';
      }
    };
    const step = async (
      name: string,
      create: boolean,
      viaApi: () => Promise<Outcome>,
      viaSql: () => Promise<Outcome>,
    ) => {
      const side = sideOf(create);
      sides[name] = side;
      const outcome = side === 'api' ? await viaApi() : await viaSql();
      steps[name] = outcome;
      return outcome;
    };
    /** Labels the member id and token of an invite payload. */
    const learn = (payload: unknown, who: string, tokenLabel = who) => {
      const body = payload as Body;
      cast.labels.set(body.member_id as string, `row:${who}`);
      cast.tokens.set(body.invite_token as string, `token:${tokenLabel}`);
    };

    // --- invites (the "create" side) -----------------------------------------------------------
    const benInvite = await step(
      'invite phone (ben)',
      true,
      async () =>
        fromApi(
          await invitePhone(app, owner.id, {
            display_name: 'Ben Invite',
            phone: ben.phone,
            relationship: 'friend',
          }),
        ),
      () =>
        fromSql(owner.id, 'public.invite_circle_member_by_phone($1, $2, $3)', [
          'Ben Invite',
          ben.phone,
          'friend',
        ]),
    );
    if (benInvite.ok) learn(benInvite.body, 'ben');
    const batch = await step(
      'invite batch (dan, gus)',
      true,
      async () =>
        fromApi(
          await inviteBatch(app, owner.id, {
            invites: [
              { phone: dan.phone, display_name: 'Dan Invite' },
              { phone: gus.phone, display_name: 'Gus Invite' },
            ],
          }),
        ),
      () =>
        fromSql(owner.id, 'public.invite_circle_members_by_phone($1::jsonb)', [
          JSON.stringify([
            { phone: dan.phone, display_name: 'Dan Invite' },
            { phone: gus.phone, display_name: 'Gus Invite' },
          ]),
        ]),
    );
    if (batch.ok) {
      const created = (batch.body as { created: Body[] }).created;
      learn(created[0], 'dan');
      learn(created[1], 'gus');
    }
    const linkInvite = async (who: string, stepName = `invite link (${who})`) => {
      const name = `${who[0].toUpperCase()}${who.slice(1)} Link`;
      const link = await step(
        stepName,
        true,
        async () => fromApi(await createInviteLink(app, owner.id, { display_name: name })),
        () => fromSql(owner.id, 'public.create_circle_invite_link($1)', [name]),
      );
      if (link.ok) learn(link.body, who);
    };
    await linkInvite('cara');
    await linkInvite('eve');
    // 5 of 5 slots are held (Ben, Dan, Gus, Cara, Eve): a sixth invite is refused.
    await linkInvite('hal', 'invite link (hal, circle full)');

    // --- everything after (the "rest" side) ----------------------------------------------------
    const lookup = (name: string, tokenLabel: string) =>
      step(
        name,
        false,
        async () => fromApi(await lookupInvite(app, token(tokenLabel))),
        () => fromSql(owner.id, 'public.lookup_circle_invite($1)', [token(tokenLabel)]),
      );
    const invitee = (
      name: string,
      user: UserFixture,
      op: 'preview' | 'accept' | 'decline',
      tokenLabel: string,
    ) => {
      const api = { preview: previewInvite, accept: acceptInvite, decline: declineInvite }[op];
      return step(
        name,
        false,
        async () => fromApi(await api(app, user.id, token(tokenLabel))),
        () => fromSql(user.id, `public.${op}_circle_invite($1)`, [token(tokenLabel)]),
      );
    };
    const ownerRowCall = (
      name: string,
      op: 'cancel' | 'resend',
      memberLabel: string,
      caller: UserFixture = owner,
    ) =>
      step(
        name,
        false,
        async () =>
          fromApi(
            await (op === 'cancel' ? cancelInvite : resendInvite)(
              app,
              caller.id,
              rowId(memberLabel),
            ),
          ),
        () => fromSql(caller.id, `public.${op}_circle_invite($1)`, [rowId(memberLabel)]),
      );
    const incoming = (name: string, user: UserFixture) =>
      step(
        name,
        false,
        async () => {
          // SCRUM-33 (D46): the additive `owner_avatar_url` is not in the SQL answer.
          const outcome = fromApi(await listMyInvites(app, user.id));
          return outcome.ok ? { ok: true, body: withoutOwnerAvatarUrl(outcome.body) } : outcome;
        },
        () => fromSql(user.id, 'public.list_my_circle_invites()'),
      );

    await lookup('lookup (ben, pending)', 'ben');
    await invitee('preview (ben)', ben, 'preview', 'ben');
    await invitee('accept (ben)', ben, 'accept', 'ben');
    await invitee('accept again (ben)', ben, 'accept', 'ben');
    await lookup('lookup (ben, consumed)', 'ben');
    await invitee('accept (cara)', cara, 'accept', 'cara');
    await incoming('incoming (dan, claims)', dan);
    await invitee('decline (dan)', dan, 'decline', 'dan');
    await invitee('decline again (dan)', dan, 'decline', 'dan');
    // Dan's decline freed a slot.
    await linkInvite('hal');
    await invitee('preview (eve, claims)', eve, 'preview', 'eve');
    await ownerRowCall('cancel (eve)', 'cancel', 'eve');
    await incoming('incoming (eve, canceled)', eve);
    const resent = await ownerRowCall('resend (eve, declined)', 'resend', 'eve');
    if (resent.ok) cast.tokens.set((resent.body as Body).invite_token as string, 'token:eve2');
    await lookup('lookup (eve, old token)', 'eve');
    await lookup('lookup (eve, new token)', 'eve2');
    await invitee('accept (gus)', gus, 'accept', 'gus');
    await invitee('accept (hal)', hal, 'accept', 'hal');
    await step(
      'remove (gus)',
      false,
      async () => fromApi(await removeMember(app, owner.id, circleId, rowId('gus'))),
      () => fromSql(owner.id, 'public.remove_circle_member($1)', [rowId('gus')]),
    );
    await step(
      'leave (hal)',
      false,
      async () => fromApi(await leaveCircle(app, hal.id, circleId)),
      () => fromSql(hal.id, 'public.leave_safety_circle($1)', [circleId]),
    );
    const resentDan = await ownerRowCall('resend (dan, declined)', 'resend', 'dan');
    if (resentDan.ok)
      cast.tokens.set((resentDan.body as Body).invite_token as string, 'token:dan2');
    await ownerRowCall('cancel (dan, pending again)', 'cancel', 'dan');
    for (const [who, user] of [
      ['owner', owner],
      ['ben', ben],
    ] as const) {
      await step(
        `members (${who})`,
        false,
        async () => fromApi(await listMembers(app, user.id, circleId)),
        () => fromSql(user.id, 'public.list_circle_members($1)', [circleId]),
      );
      await step(
        `joined circles (${who})`,
        false,
        async () => {
          // SCRUM-81 (D45): the additive `active_incident_id` is not in the SQL answer.
          const outcome = fromApi(await listJoinedCircles(app, user.id));
          return outcome.ok ? { ok: true, body: withoutActiveIncidentId(outcome.body) } : outcome;
        },
        () => fromSql(user.id, 'public.list_my_joined_circles()'),
      );
    }
    await step(
      'capacity (owner)',
      false,
      async () => fromApi(await getCapacity(app, owner.id)),
      () => fromSql(owner.id, 'public.circle_invite_capacity()'),
    );
    // Errors on the same state.
    await step(
      'remove owner row',
      false,
      async () => fromApi(await removeMember(app, owner.id, circleId, rowId('owner'))),
      () => fromSql(owner.id, 'public.remove_circle_member($1)', [rowId('owner')]),
    );
    await step(
      'leave (hal again)',
      false,
      async () => fromApi(await leaveCircle(app, hal.id, circleId)),
      () => fromSql(hal.id, 'public.leave_safety_circle($1)', [circleId]),
    );
    await ownerRowCall('resend (ben, active)', 'resend', 'ben');
    await ownerRowCall('cancel by a member', 'cancel', 'eve', ben);
    await invitee('accept removed row (gus)', gus, 'accept', 'gus');

    const all = await rowsOf(circleId);
    const isEnded = (row: Body) => row.status === 'removed' || row.status === 'left';
    steps['final rows'] = { ok: true, body: all.filter((row) => !isEnded(row)) };
    // D44: a RETIRED SQL reader (D42) that runs after an API remove / leave sees the history row
    // (it knows no `removed` / `left`); recorded and left out, checked below.
    const sqlSawHistory: string[] = [];
    for (const [name, outcome] of Object.entries(steps)) {
      if (sides[name] !== 'sql' || !outcome.ok || !Array.isArray(outcome.body)) continue;
      const kept = (outcome.body as Body[]).filter((entry) => !isEnded(entry));
      if (kept.length !== outcome.body.length) {
        sqlSawHistory.push(name);
        outcome.body = kept;
      }
    }
    return { cast, steps, ended: all.filter(isEnded), sides, sqlSawHistory };
  }

  // --- normalization -----------------------------------------------------------------------------

  const TIMESTAMP =
    /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(?:\+00(?::00)?|Z)$/;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const timestampKey = (value: string) => {
    const m = TIMESTAMP.exec(value);
    return m ? `${m[1]}T${m[2]}.${(m[3] ?? '').padEnd(6, '0')}` : null;
  };
  function collectTimestamps(value: unknown, into: Set<string>): void {
    if (typeof value === 'string') {
      const key = timestampKey(value);
      if (key) into.add(key);
    } else if (Array.isArray(value)) value.forEach((item) => collectTimestamps(item, into));
    else if (value && typeof value === 'object') {
      Object.values(value).forEach((item) => collectTimestamps(item, into));
    }
  }

  function normalize(cast: Cast, all: unknown): unknown {
    const keys = new Set<string>();
    collectTimestamps(all, keys);
    const rank = new Map([...keys].sort().map((key, i) => [key, `T${i}`]));
    const walk = (value: unknown): unknown => {
      if (typeof value === 'string') {
        const key = timestampKey(value);
        if (key) return rank.get(key);
        if (cast.labels.has(value)) return cast.labels.get(value);
        if (cast.tokens.has(value)) return cast.tokens.get(value);
        for (const [tok, label] of cast.tokens) {
          if (value.includes(tok)) return value.replace(tok, `<${label}>`);
        }
        if (UUID.test(value)) return 'uuid';
        return value;
      }
      if (Array.isArray(value)) return value.map(walk);
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
      }
      return value;
    };
    const out = walk(all) as Record<string, { ok: boolean; body?: unknown }>;
    // Final rows: in label order (the table has no order).
    const rows = out['final rows'].body as Body[];
    out['final rows'] = {
      ok: true,
      body: [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id))),
    };
    return out;
  }

  const MODES: Mode[] = ['sql', 'api', 'sql→api', 'api→sql', 'mixed'];

  it.each(MODES)('%s: the scenario runs through', async (mode) => {
    const { cast, steps, ended, sides, sqlSawHistory } = await run(mode);
    for (const row of ended) expect(row.ended_at).not.toBeNull();
    endedHistory[mode] = {
      rows: ended
        .map((row) => ({
          label: cast.labels.get(row.id as string) ?? 'unknown',
          status: row.status as string,
          user: cast.labels.get(row.user_id as string) ?? String(row.user_id),
          token: row.invite_token,
        }))
        .sort((a, b) => a.label.localeCompare(b.label)),
      sides,
      sqlSawHistory,
    };
    const out = normalize(cast, steps) as Record<string, unknown>;
    const rows = out['final rows'];
    delete out['final rows'];
    normalized[mode] = { steps: out, rows };
  });

  it('the reference run shows what the scenario covers', () => {
    const steps = normalized.sql.steps as Record<
      string,
      { ok: boolean; code?: string; body?: Body }
    >;
    expect(steps['invite phone (ben)'].body).toMatchObject({ resent: false, phone: 'phone:ben' });
    expect(steps['accept (ben)'].body).toEqual({
      circle_id: 'circle',
      member_id: 'row:ben',
      status: 'active',
      owner_name: 'Mix Owner',
    });
    expect(steps['accept again (ben)']).toEqual(steps['accept (ben)']);
    expect(steps['invite link (hal, circle full)']).toEqual({
      ok: false,
      code: 'create_circle_invite_link:circle_full',
    });
    expect(steps['accept (hal)'].body).toMatchObject({ status: 'active' });
    expect(steps['lookup (ben, consumed)'].body).toMatchObject({ status: 'consumed' });
    expect(steps['decline again (dan)']).toEqual({
      ok: false,
      code: 'decline_circle_invite:canceled',
    });
    expect(steps['cancel (eve)'].body).toMatchObject({ status: 'canceled' });
    expect(steps['resend (eve, declined)'].body).toMatchObject({
      member_id: 'row:eve',
      resent: true,
      invite_token: 'token:eve2',
    });
    expect(steps['lookup (eve, old token)'].body).toMatchObject({ status: 'not_found' });
    expect(steps['remove (gus)'].body).toEqual({
      member_id: 'row:gus',
      circle_id: 'circle',
      removed: true,
    });
    expect(steps['leave (hal)'].body).toEqual({
      circle_id: 'circle',
      member_id: 'row:hal',
      left: true,
    });
    expect(steps['remove owner row']).toEqual({
      ok: false,
      code: 'remove_circle_member:cannot_remove_owner',
    });
    expect(steps['leave (hal again)']).toEqual({
      ok: false,
      code: 'leave_safety_circle:not_authorized',
    });
    expect(steps['resend (ben, active)']).toEqual({
      ok: false,
      code: 'resend_circle_invite:already_active',
    });
    expect(steps['cancel by a member']).toEqual({
      ok: false,
      code: 'cancel_circle_invite:not_authorized',
    });
    expect(steps['accept removed row (gus)']).toEqual({
      ok: false,
      code: 'accept_circle_invite:not_found',
    });
    expect(steps['capacity (owner)'].body).toEqual({
      limit: 5,
      active_count: 2,
      pending_count: 1,
      used: 3,
      available: 2,
    });
  });

  it.each(['api', 'sql→api', 'api→sql', 'mixed'] as const)(
    '%s: every step answers as in the SQL-only run',
    (mode) => {
      expect(normalized[mode].steps).toEqual(normalized.sql.steps);
    },
  );

  it.each(['api', 'sql→api', 'api→sql', 'mixed'] as const)(
    '%s: the same final member rows as the SQL-only run',
    (mode) => {
      expect(normalized[mode].rows).toEqual(normalized.sql.rows);
    },
  );

  it.each(MODES)(
    '%s: D44 divergence — exactly the remove / leave run through the API left a history row',
    (mode) => {
      const { rows, sides, sqlSawHistory } = endedHistory[mode];
      // Only a retired SQL list (D42) can see a history row, and only after an API end.
      if (mode === 'sql' || mode === 'api') expect(sqlSawHistory).toEqual([]);
      for (const name of sqlSawHistory) expect(sides[name]).toBe('sql');
      if (sqlSawHistory.length > 0) expect(rows.length).toBeGreaterThan(0);
      const expected = [
        ...(sides['remove (gus)'] === 'api'
          ? [{ label: 'row:gus', status: 'removed', user: 'gus', token: null }]
          : []),
        ...(sides['leave (hal)'] === 'api'
          ? [{ label: 'row:hal', status: 'left', user: 'hal', token: null }]
          : []),
      ];
      expect(rows).toEqual(expected);
      if (mode === 'sql') expect(rows).toEqual([]);
      if (mode === 'api') expect(rows).toHaveLength(2);
    },
  );

  it('the final rows are what the SQL functions leave behind', () => {
    const rows = normalized.sql.rows as { body: Body[] };
    const byId = new Map(rows.body.map((row) => [row.id, row]));
    expect([...byId.keys()].sort()).toEqual(
      ['row:ben', 'row:cara', 'row:dan', 'row:eve', 'row:owner'].sort(),
    );
    expect(byId.get('row:ben')).toMatchObject({ status: 'active', user_id: 'ben' });
    expect(byId.get('row:dan')).toMatchObject({ status: 'declined', invite_token: 'token:dan2' });
    expect(byId.get('row:eve')).toMatchObject({ status: 'pending', user_id: null });
  });

  /**
   * The note on ordering (2026-11-20): `list_my_circle_invites` and `list_my_joined_circles` order by
   * the timestamp's JSON text (`payload->>'invited_at'`, `->>'joined_at'`), not by the timestamp. The
   * API does the same (plus a `member_id` tie-break where the SQL leaves ties in any order). Under
   * the database's collation (ICU `en-US` on supabase/postgres) the text order differs from strict
   * time order in one case: a timestamp with no fraction (`10:00:00+00:00`) sorts after every
   * fractional one of the same second (`10:00:00.5+00:00`), because `+` sorts after `.`. Shown here
   * with both lists: the API matches the SQL, and the earlier whole-second row comes first in the
   * descending list.
   */
  it('lists order by the timestamp text exactly like the SQL (known difference from time order)', async () => {
    const invitee = await createUser(client, { fullName: 'Order Invitee' });
    const owners = await Promise.all([1, 2, 3].map(() => createUser(client)));
    const circles = await Promise.all(owners.map((o) => createCircle(client, o)));
    const invited = [
      "'2026-11-10 10:00:00+00'",
      "'2026-11-10 10:00:00.5+00'",
      "'2026-11-10 09:59:59.9+00'",
    ];
    const rows = [];
    for (let i = 0; i < 3; i += 1) {
      rows.push(
        await insertMember(client, circles[i].id, {
          userId: invitee.id,
          invitedSql: `timestamptz ${invited[i]}`,
          expiresSql: "now() + interval '7 days'",
        }),
      );
    }
    const api = (await listMyInvites(app, invitee.id)).json<Body[]>().map((r) => r.member_id);
    const viaSql = await fromSql(invitee.id, 'public.list_my_circle_invites()');
    const sqlIds = ((viaSql as { body: Body[] }).body ?? []).map((r) => r.member_id);
    expect(api).toEqual(sqlIds);
    const collation = (
      await client.query<{ provider: string }>(
        `select datlocprovider as provider from pg_database where datname = current_database()`,
      )
    ).rows[0].provider;
    // Strict time order (desc) would be .5, :00, 09:59:59.9.
    const timeOrder = [rows[1].id, rows[0].id, rows[2].id];
    if (collation === 'i') expect(api).toEqual([rows[0].id, rows[1].id, rows[2].id]);
    else expect(api).toEqual(timeOrder);

    // Joined circles: joined_at = updated_at of the active row.
    const joiner = await createUser(client, { fullName: 'Order Joiner' });
    const joinOwners = await Promise.all([1, 2].map(() => createUser(client)));
    const joinCircles = await Promise.all(joinOwners.map((o) => createCircle(client, o)));
    const joinedAt = ["'2026-11-10 10:00:00+00'", "'2026-11-10 10:00:00.5+00'"];
    for (let i = 0; i < 2; i += 1) {
      await client.query(
        `insert into public.safety_circle_members (circle_id, role, status, display_name, user_id,
           invite_consumed_at, updated_at)
         values ($1, 'member', 'active', 'Joined', $2, now(), timestamptz ${joinedAt[i]})`,
        [joinCircles[i].id, joiner.id],
      );
    }
    const apiJoined = (await listJoinedCircles(app, joiner.id))
      .json<Body[]>()
      .map((r) => r.circle_id);
    const sqlJoined = (
      (await fromSql(joiner.id, 'public.list_my_joined_circles()')) as { body: Body[] }
    ).body.map((r) => r.circle_id);
    expect(apiJoined).toEqual(sqlJoined);
    if (collation === 'i') expect(apiJoined).toEqual([joinCircles[0].id, joinCircles[1].id]);
    else expect(apiJoined).toEqual([joinCircles[1].id, joinCircles[0].id]);
  });
});
