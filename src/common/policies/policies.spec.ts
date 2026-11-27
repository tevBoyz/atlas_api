import { type SQL, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

import { DomainError } from '../errors/domain-error';
import {
  assertNoActivatedAt,
  circleActiveMember,
  circleActiveMemberSince,
  incidentAlias,
  incidentMemberView,
  isInviteRecipient,
  isMembershipActivationPath,
  isProfileSelf,
  normalizeE164,
  POLICIES,
  requireIncident,
  type SqlExecutor,
} from './index';

const dialect = new PgDialect();
const render = (fragment: SQL) => dialect.sqlToQuery(fragment);

/** A fake executor returning a fixed `allowed` value and recording the query. */
function fakeDb(allowed: unknown): SqlExecutor & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    execute: (query: SQL) => {
      queries.push(render(query).sql);
      return Promise.resolve({ rows: [{ allowed }] });
    },
  };
}

const CALLER = '6f1c2b8e-1d1a-4c55-9a43-1c7a2f0e9d10';
const CIRCLE = '0b4f8c1e-2a9d-4f3e-8b7a-5d6c4e3f2a10';

describe('policy registry (API-100-09 AC1)', () => {
  it('has exactly the spec §11.4 policy names', () => {
    expect(Object.keys(POLICIES).sort()).toEqual(
      [
        'profile.self',
        'circle.owner',
        'circle.activeMember',
        'circle.activeMemberSince',
        'incident.resident',
        'incident.memberView',
        'incident.eventsView',
        'incident.countsView',
        // Stage 2 [B13]: the read-only history of an ended member.
        'incident.historyView',
        'incident.eventsHistoryView',
        'delivery.own',
        'invite.recipient',
        'membership.activate',
      ].sort(),
    );
    for (const [name, policy] of Object.entries(POLICIES)) expect(policy.name).toBe(name);
  });
});

describe('SQL predicate form (API-100-09 AC3)', () => {
  it('values become typed parameters (microsecond timestamps kept as text)', () => {
    const at = '2026-11-10 12:00:00.000001+00';
    const query = render(circleActiveMemberSince.where({ circleId: CIRCLE, callerId: CALLER, at }));
    expect(query.sql).toContain('($1)::uuid is not null');
    expect(query.sql).toContain('activated_at <= ($6)::timestamptz');
    expect(query.sql).toContain("pc_w.status = 'active'");
    expect(query.params).toEqual([CIRCLE, CALLER, at, CIRCLE, CALLER, at]);
  });

  it('columns are used as columns (list form over the incidents table)', () => {
    const query = render(incidentMemberView.where({ callerId: CALLER }));
    expect(query.sql).toContain('"incidents"."circle_id" is not null');
    expect(query.sql).toContain("\"incidents\".\"status\" in ('active', 'resolved', 'closed')");
    expect(query.sql).toContain('pc_w.activated_at <= "incidents"."activated_at"');
    expect(query.sql).toContain('"incidents"."resident_id" is distinct from ($');
  });

  it('works over a table alias', () => {
    const query = render(
      incidentMemberView.where({ callerId: CALLER, incident: incidentAlias('i') }),
    );
    expect(query.sql).toContain('i.circle_id is not null');
    expect(query.sql).not.toContain('"incidents"');
  });

  it('null operands are SQL NULL (the predicate is then false)', () => {
    const query = render(circleActiveMember.where({ circleId: null, callerId: undefined }));
    expect(query.params).toEqual([null, null]);
  });

  it('a JS Date is sent as ISO text (millisecond precision)', () => {
    const query = render(
      circleActiveMemberSince.where({
        circleId: sql`c.id`,
        callerId: CALLER,
        at: new Date('2026-11-10T12:00:00.123Z'),
      }),
    );
    expect(query.params).toContain('2026-11-10T12:00:00.123Z');
  });
});

describe('single-row form (API-100-09 AC3)', () => {
  it('evaluates the predicate in one query; SQL NULL counts as false', async () => {
    const yes = fakeDb(true);
    expect(await circleActiveMember.check(yes, { circleId: CIRCLE, callerId: CALLER })).toBe(true);
    expect(yes.queries).toHaveLength(1);
    expect(yes.queries[0]).toMatch(/^select coalesce\(\(exists/);
    expect(
      await circleActiveMember.check(fakeDb(null), { circleId: CIRCLE, callerId: CALLER }),
    ).toBe(false);
    expect(
      await circleActiveMember.check(fakeDb(false), { circleId: CIRCLE, callerId: CALLER }),
    ).toBe(false);
  });

  it('incident checkById selects the incident by id', async () => {
    const db = fakeDb(true);
    await incidentMemberView.checkById(db, CIRCLE, CALLER);
    expect(db.queries[0]).toContain('from public.incidents pi_i');
    expect(db.queries[0]).toContain('pi_i.id = ($1)::uuid');
  });
});

describe('hidden existence (API-100-09 AC4)', () => {
  it('raises the operation not_found code (404) when the policy fails', async () => {
    const failure = requireIncident(
      fakeDb(false),
      incidentMemberView,
      CIRCLE,
      CALLER,
      'get_incident_details',
    );
    await expect(failure).rejects.toBeInstanceOf(DomainError);
    await expect(failure).rejects.toMatchObject({
      code: 'get_incident_details:not_found',
      status: 404,
    });
  });

  it('resolves when the policy passes', async () => {
    await expect(
      requireIncident(fakeDb(true), incidentMemberView, CIRCLE, CALLER, 'mark_incident_safe'),
    ).resolves.toBeUndefined();
  });
});

describe('profile.self', () => {
  it.each([
    [CALLER, CALLER, true],
    [CALLER.toUpperCase(), CALLER, true],
    [CIRCLE, CALLER, false],
    [null, CALLER, false],
    [CALLER, null, false],
  ])('isProfileSelf(%s, %s) = %s', (profileId, callerId, expected) => {
    expect(isProfileSelf(profileId, callerId)).toBe(expected);
  });
});

describe('invite.recipient (§6.3 rule 18, _normalize_e164)', () => {
  it.each([
    [null, null],
    ['', null],
    ['   ', null],
    ['+12015550101', '+12015550101'],
    [' +12015550101 ', '+12015550101'],
    ['12015550101', '+12015550101'],
    ['2015550101', '+2015550101'],
    ['1234567', '1234567'], // too short: trimmed text, not E.164
    ['012015550101', '012015550101'],
    ['+1 201 555 0101', '+1 201 555 0101'],
    ['\t12015550101', '\t12015550101'], // btrim trims spaces only
  ])('normalizeE164(%j) = %j', (raw, expected) => {
    expect(normalizeE164(raw)).toBe(expected);
  });

  const phoneRow = { userId: null, phone: '+12015550101' };
  const linkRow = { userId: null, phone: null };

  it('phone invite: the caller Auth phone must match after normalization', () => {
    expect(isInviteRecipient(phoneRow, CALLER, '12015550101')).toBe(true);
    expect(isInviteRecipient(phoneRow, CALLER, '+12015550101')).toBe(true);
    expect(isInviteRecipient(phoneRow, CALLER, '+12015550102')).toBe(false);
    expect(isInviteRecipient(phoneRow, CALLER, null)).toBe(false);
    expect(isInviteRecipient(phoneRow, CALLER, '  ')).toBe(false);
  });

  it('link invite: any token holder', () => {
    expect(isInviteRecipient(linkRow, CALLER, null)).toBe(true);
  });

  it('claimed row: only that user', () => {
    expect(isInviteRecipient({ userId: CALLER, phone: null }, CALLER, null)).toBe(true);
    expect(isInviteRecipient({ userId: CIRCLE, phone: null }, CALLER, null)).toBe(false);
    expect(
      isInviteRecipient({ userId: CIRCLE, phone: '+12015550101' }, CALLER, '12015550101'),
    ).toBe(false);
  });
});

describe('membership.activate', () => {
  it('only accept and setup may activate', () => {
    expect(isMembershipActivationPath('invite_accept')).toBe(true);
    expect(isMembershipActivationPath('profile_setup_owner_row')).toBe(true);
    expect(isMembershipActivationPath('owner_direct_update')).toBe(false);
  });

  it('activated_at is never written by the API', () => {
    expect(() => assertNoActivatedAt({ status: 'active' })).not.toThrow();
    expect(() => assertNoActivatedAt({ status: 'active', activatedAt: 'x' })).toThrow(/trigger/);
    expect(() => assertNoActivatedAt({ activated_at: null })).toThrow(/trigger/);
  });

  it('an unknown path matches no row', () => {
    const query = render(
      POLICIES['membership.activate'].where({ path: 'other', callerId: CALLER }),
    );
    expect(query.sql).toBe('false');
  });
});
