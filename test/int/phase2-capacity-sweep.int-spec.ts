import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { createTestApp, withTestConfig } from '../../src/testing/test-app';
import {
  acceptInvite,
  cancelInvite,
  createInviteLink,
  declineInvite,
  getCapacity,
  getOwnCircle,
  invitePhone,
  inviteBatch,
  leaveCircle,
  listMyInvites,
  previewInvite,
  removeMember,
  resendInvite,
} from '../support/circle-api';
import { openTestClient } from '../support/database';
import { addActiveMember, createCircle, createUser, fakeInviteToken } from '../support/fixtures';
import { insertExpiredMember, insertMember } from '../support/invite-rows';

/**
 * API-100-33 AC3 ("capacity never above 5"): a sweep of mixed concurrent writes on one circle while
 * a sampler on its own connection reads the circle's slot count (active + valid pending, owner
 * excluded, spec rule 8) every few milliseconds. Each round fires, at the same moment: phone,
 * link and batch invites (twice each), a raw insert as the database owner (only the capacity
 * trigger guards it), resends of an expired and a declined row, accepts of pending rows (one of
 * them by two users at once), a decline, a cancel, a preview, the incoming list, a remove and a
 * leave, and the owner's reads. Outcomes are asserted (no 5xx, the bound), not the database-wide
 * deadlock counter (gap 32).
 *
 * The other two AC3 cases are proven where they were built: 6 parallel invites (phone, link,
 * batch) into 1 free slot → exactly 1 (circles-invites-races.int-spec.ts, with a raw insert), and
 * two users accepting the same token → exactly 1, the other `consumed`
 * (invites-invitee-races.int-spec.ts).
 */
type Body = Record<string, unknown>;
type Reply = Awaited<ReturnType<typeof getCapacity>>;

let counter = 0;
/** Ofcom's drama range (+44 7700 900000-900999): numbers reserved for fiction. */
const phoneNumber = () => `+447700900${String(800 + counter++).padStart(3, '0')}`;

const ROUNDS = 8;

describe('Phase 2 gate: capacity never above 5 under concurrent writes (API-100-33 AC3)', () => {
  let app: NestFastifyApplication;
  let client: Client;
  let sampler: Client;
  let rawClient: Client;

  beforeAll(async () => {
    ({ app } = await createTestApp(
      {},
      withTestConfig({
        RATE_LIMIT_AUTHENTICATED_MAX: '1000000',
        RATE_LIMIT_PUBLIC_MAX: '1000000',
        DATABASE_POOL_MAX: '16',
      }),
    ));
    client = await openTestClient();
    sampler = await openTestClient();
    rawClient = await openTestClient();
  });

  afterAll(async () => {
    await rawClient?.end();
    await sampler?.end();
    await client?.end();
    await app?.close();
  });

  const usedSql = `select count(*)::int as n from public.safety_circle_members m
     where m.circle_id = $1 and m.role = 'member'
       and (m.status = 'active'
            or (m.status = 'pending' and m.invite_canceled_at is null
                and m.invite_consumed_at is null
                and coalesce(m.invite_expires_at, m.invited_at + interval '7 days') > now()))`;

  it(`${ROUNDS} rounds of ~22 concurrent writes: the slot count never goes above 5`, async () => {
    let maxSeen = 0;
    let samples = 0;
    for (let round = 0; round < ROUNDS; round += 1) {
      const owner = await createUser(client, { fullName: 'Sweep Owner' });
      const circle = await createCircle(client, owner);
      const ben = await createUser(client, { fullName: 'Sweep Ben' });
      const benRow = await addActiveMember(client, circle, ben);
      const cara = await createUser(client, { fullName: 'Sweep Cara' });
      const caraRow = await addActiveMember(client, circle, cara);
      const p1 = await insertMember(client, circle.id, { name: 'P1' });
      const p2 = await insertMember(client, circle.id, { name: 'P2' });
      const p3 = await insertMember(client, circle.id, { name: 'P3' });
      const expired = await insertExpiredMember(client, circle.id, { name: 'Expired' });
      const declined = await insertMember(client, circle.id, {
        name: 'Declined',
        status: 'declined',
        canceled: true,
      });
      const joiners = await Promise.all([1, 2, 3, 4].map(() => createUser(client)));

      let sampling = true;
      const sampleLoop = (async () => {
        while (sampling) {
          const n = (await sampler.query<{ n: number }>(usedSql, [circle.id])).rows[0].n;
          maxSeen = Math.max(maxSeen, n);
          samples += 1;
        }
      })();

      const replies: Reply[] = [];
      const tagged = new Map<string, Reply[]>();
      const rawResults: Array<{ error?: string; sqlState?: string }> = [];
      const api = (p: Promise<Reply>, tag = '') =>
        p.then((r) => {
          replies.push(r);
          tagged.set(tag, [...(tagged.get(tag) ?? []), r]);
          return r;
        });
      await Promise.all([
        api(invitePhone(app, owner.id, { display_name: 'Ph', phone: phoneNumber() })),
        api(createInviteLink(app, owner.id, {})),
        api(
          inviteBatch(app, owner.id, {
            invites: [
              { phone: phoneNumber(), display_name: 'B1' },
              { phone: phoneNumber(), display_name: 'B2' },
            ],
          }),
        ),
        api(invitePhone(app, owner.id, { display_name: 'Ph2', phone: phoneNumber() })),
        api(createInviteLink(app, owner.id, {})),
        api(
          inviteBatch(app, owner.id, {
            invites: [{ phone: phoneNumber(), display_name: 'B3' }],
          }),
        ),
        // A raw valid pending insert as the database owner: only the trigger guards it.
        rawClient
          .query(
            `insert into public.safety_circle_members (circle_id, role, status, display_name,
               invite_token, invite_expires_at)
             values ($1, 'member', 'pending', 'Raw', $2, now() + interval '7 days')`,
            [circle.id, fakeInviteToken()],
          )
          .then(
            () => rawResults.push({}),
            (error: { message: string; code?: string }) =>
              rawResults.push({ error: error.message, sqlState: error.code }),
          ),
        api(resendInvite(app, owner.id, expired.id)),
        api(resendInvite(app, owner.id, declined.id)),
        // Two users accept p1 at once (one wins); p2 by a third user; p3 is declined.
        api(acceptInvite(app, joiners[0].id, p1.token), 'p1'),
        api(acceptInvite(app, joiners[1].id, p1.token), 'p1'),
        api(acceptInvite(app, joiners[2].id, p2.token)),
        api(declineInvite(app, joiners[3].id, p3.token)),
        api(previewInvite(app, joiners[3].id, p2.token)),
        api(listMyInvites(app, joiners[0].id)),
        api(cancelInvite(app, owner.id, p2.id)),
        api(removeMember(app, owner.id, circle.id, benRow.id)),
        api(leaveCircle(app, cara.id, circle.id)),
        api(getCapacity(app, owner.id), 'capacity'),
        api(getOwnCircle(app, owner.id), 'circle'),
        api(createInviteLink(app, owner.id, { display_name: 'Late' })),
      ]);
      sampling = false;
      await sampleLoop;

      for (const reply of replies) {
        if (reply.statusCode >= 500) throw new Error(`${reply.statusCode} ${reply.body}`);
      }
      for (const result of rawResults) {
        // P0001 = the trigger's raw circle_full; nothing else (no deadlock, no other error).
        if (result.error) expect(result.sqlState).toBe('P0001');
      }
      // Exactly one of the two accepts of p1 won; the other is `consumed` (or `circle_full` when
      // the sweep filled the circle first, in which case neither accepted).
      const p1Accepts = tagged.get('p1') ?? [];
      expect(p1Accepts.filter((r) => r.statusCode === 200).length).toBeLessThanOrEqual(1);
      for (const r of p1Accepts.filter((x) => x.statusCode !== 200)) {
        expect(['accept_circle_invite:consumed', 'accept_circle_invite:circle_full']).toContain(
          r.json<{ error: { code: string } }>().error.code,
        );
      }
      // Capacity reads during the sweep never showed more than 5 used.
      for (const reply of tagged.get('capacity') ?? []) {
        expect(reply.json<Body>().used as number).toBeLessThanOrEqual(5);
      }
      for (const reply of tagged.get('circle') ?? []) {
        const capacity = reply.json<{ capacity: Body }>().capacity;
        expect(capacity.used as number).toBeLessThanOrEqual(5);
        expect(capacity.available as number).toBeGreaterThanOrEqual(0);
      }
      const finalUsed = (await client.query<{ n: number }>(usedSql, [circle.id])).rows[0].n;
      expect(finalUsed).toBeLessThanOrEqual(5);
      void caraRow;
    }
    // The circle starts full (2 active + 3 valid pending), so the bound is reached, never passed.
    expect(maxSeen).toBe(5);
    expect(samples).toBeGreaterThan(ROUNDS);
  });
});
