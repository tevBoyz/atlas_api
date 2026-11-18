import { randomUUID } from 'node:crypto';

import { Controller, Headers, Param, Post } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { Public } from '../../src/common/guards/route-access';
import { DatabaseService } from '../../src/db';
import { AuditModule, AuditService } from '../../src/modules/audit';
import { createTestApp, withTestConfig } from '../../src/testing/test-app';
import { openTestClient } from '../support/database';

/**
 * The append-only audit log against a real database (API-100-14). The route is test-only: it stands
 * in for a feature that records an action inside its own transaction.
 */
interface AuditRow {
  action: string;
  actor_user_id: string | null;
  target_type: string | null;
  target_id: string | null;
  ip: string | null;
  request_id: string | null;
  detail: Record<string, unknown>;
}

@Controller('test-audit')
@Public()
class AuditIntController {
  constructor(
    private readonly audit: AuditService,
    private readonly database: DatabaseService,
  ) {}

  /** Waits inside the transaction, so concurrent requests really overlap. */
  @Post(':target')
  async record(@Param('target') target: string, @Headers('x-delay-ms') delay?: string) {
    await this.database.db.transaction(async (tx) => {
      await new Promise((resolve) => setTimeout(resolve, Number(delay ?? 0)));
      await this.audit.record(
        {
          action: 'incident.created',
          actor_user_id: null,
          target_type: 'incident',
          target_id: target,
        },
        tx,
      );
    });
    return { ok: true };
  }
}

describe('Audit log (API-100-14)', () => {
  let app: NestFastifyApplication;
  let audit: AuditService;
  let database: DatabaseService;
  let client: Client;

  beforeAll(async () => {
    ({ app } = await createTestApp(
      { imports: [AuditModule], controllers: [AuditIntController] },
      withTestConfig({ TRUST_PROXY: 'true' }),
    ));
    audit = app.get(AuditService);
    database = app.get(DatabaseService);
    client = await openTestClient();
  });

  afterAll(async () => {
    await client.end();
    await app.close();
  });

  async function rowsFor(targetId: string): Promise<AuditRow[]> {
    const { rows } = await client.query<AuditRow>(
      `select action, actor_user_id, target_type, target_id, host(ip) as ip, request_id, detail
         from public.audit_log where target_id = $1`,
      [targetId],
    );
    return rows;
  }

  const entry = (targetId: string) => ({
    action: 'incident.created' as const,
    actor_user_id: randomUUID(),
    target_type: 'incident',
    target_id: targetId,
  });

  describe('AC1: append-only, also for the role the API connects as', () => {
    let targetId: string;

    beforeAll(async () => {
      targetId = randomUUID();
      await database.db.transaction((tx) => audit.record(entry(targetId), tx));
    });

    it('the API role owns the table (a REVOKE alone would not bind it)', async () => {
      const { rows } = await client.query<{ owner: string; me: string }>(
        `select tableowner as owner, current_user as me
           from pg_tables where schemaname = 'public' and tablename = 'audit_log'`,
      );
      expect(rows[0].owner).toBe(rows[0].me);
    });

    it.each([
      ['UPDATE', `update public.audit_log set action = 'tampered'`],
      ['UPDATE of no rows', `update public.audit_log set action = 'x' where false`],
      ['DELETE', 'delete from public.audit_log'],
      ['DELETE of no rows', 'delete from public.audit_log where false'],
      ['TRUNCATE', 'truncate public.audit_log'],
    ])('%s is refused', async (_label, statement) => {
      await expect(client.query(statement)).rejects.toMatchObject({
        code: 'P0001',
        message: expect.stringContaining('audit_log is append-only') as string,
      });
      expect(await rowsFor(targetId)).toHaveLength(1);
      expect((await rowsFor(targetId))[0].action).toBe('incident.created');
    });

    it('INSERT is allowed', async () => {
      const id = randomUUID();
      await client.query(`insert into public.audit_log (action, target_id) values ('x.y', $1)`, [
        id,
      ]);
      expect(await rowsFor(id)).toHaveLength(1);
    });
  });

  describe("AC2: inside the caller's transaction", () => {
    it('RACE: rolling the transaction back removes the audit row', async () => {
      const targetId = randomUUID();
      await expect(
        database.db.transaction(async (tx) => {
          await audit.record(entry(targetId), tx);
          throw new Error('the action failed');
        }),
      ).rejects.toThrow('the action failed');
      expect(await rowsFor(targetId)).toEqual([]);
    });

    it('RACE: the row is invisible to others until commit, then it stays', async () => {
      const targetId = randomUUID();
      await database.db.transaction(async (tx) => {
        await audit.record(entry(targetId), tx);
        expect(await rowsFor(targetId)).toEqual([]);
      });
      expect(await rowsFor(targetId)).toHaveLength(1);
    });

    it('occurred_at is the transaction time', async () => {
      const targetId = randomUUID();
      const txNow = await database.db.transaction(async (tx) => {
        await audit.record(entry(targetId), tx);
        const result = await tx.execute<{ now: string }>('select now()::text as now');
        return result.rows[0].now;
      });
      const { rows } = await client.query<{ at: string }>(
        'select occurred_at::text as at from public.audit_log where target_id = $1',
        [targetId],
      );
      expect(rows[0].at).toBe(txNow);
    });

    it('stores the entry; outside a request, request id and IP are null', async () => {
      const targetId = randomUUID();
      const actor = randomUUID();
      await database.db.transaction((tx) =>
        audit.record({ ...entry(targetId), actor_user_id: actor, detail: { outcome: 'x' } }, tx),
      );
      expect(await rowsFor(targetId)).toEqual([
        {
          action: 'incident.created',
          actor_user_id: actor,
          target_type: 'incident',
          target_id: targetId,
          ip: null,
          request_id: null,
          detail: { outcome: 'x' },
        },
      ]);
    });
  });

  describe('per-request context', () => {
    it('RACE: concurrent requests each record their own request id and IP', async () => {
      const requests = Array.from({ length: 30 }, (_, i) => ({
        target: randomUUID(),
        requestId: `audit-request-${i}`,
        ip: `198.51.100.${i + 1}`,
        // Later requests finish first, so their transactions interleave.
        delay: String((30 - i) * 5),
      }));
      const responses = await Promise.all(
        requests.map((r) =>
          app.inject({
            method: 'POST',
            url: `/v1/test-audit/${r.target}`,
            headers: {
              'x-request-id': r.requestId,
              'x-forwarded-for': r.ip,
              'x-delay-ms': r.delay,
            },
          }),
        ),
      );
      expect(responses.every((res) => res.statusCode === 201)).toBe(true);
      for (const r of requests) {
        const rows = await rowsFor(r.target);
        expect(rows).toHaveLength(1);
        expect(rows[0].request_id).toBe(r.requestId);
        expect(rows[0].ip).toBe(r.ip);
      }
    });
  });

  describe('AC4: detail', () => {
    it('never stores medical or share fields, tokens, phone numbers or coordinates', async () => {
      const targetId = randomUUID();
      await database.db.transaction((tx) =>
        audit.record(
          {
            ...entry(targetId),
            detail: {
              recipient_count: 2,
              blood_type: 'O+',
              share_payload: { allergies: 'nuts' },
              invite_token: 'abc',
              phone: '+12015550101',
              note: 'call 12015550101',
              location_lat: 13.4549,
              location_lng: -16.579,
            },
          },
          tx,
        ),
      );
      expect((await rowsFor(targetId))[0].detail).toEqual({ recipient_count: 2 });
    });
  });

  describe('AC5: no read endpoint', () => {
    it('the app exposes no audit route', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/audit' });
      expect(res.statusCode).toBe(404);
    });
  });
});
