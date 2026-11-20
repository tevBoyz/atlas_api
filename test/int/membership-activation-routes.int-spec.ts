import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { AppModule } from '../../src/app.module';
import { collectControllers, discoverRoutes } from '../../src/openapi/route-discovery';
import { createTestApp, withTestConfig } from '../../src/testing/test-app';
import { authHeader } from '../../src/testing/test-tokens';
import { acceptInvite } from '../support/circle-api';
import { openTestClient } from '../support/database';
import { addActiveMember, createCircle, createIncident, createUser } from '../support/fixtures';
import { insertExpiredMember, insertMember, memberRow } from '../support/invite-rows';

/**
 * API-100-30 AC5 (spec §4.4 "known bypass", §11.3 "no endpoint inserts or activates a member row
 * directly", policy `membership.activate`): the ONLY route of the API that makes a
 * `safety_circle_members` row `active` is `POST /v1/invites/{token}/accept` (the owner row of
 * profile setup arrives with API-100-36).
 *
 * - Dynamic: every route the app registers (discovered from the controllers, so a new route is
 *   covered automatically) is called by the circle owner, an active member and the invitees, with
 *   real ids and tokens in its path and a hostile body (`status: active`, `activated_at`, ...).
 *   Afterwards no row of the database has become active, no `activated_at` has moved, and no active
 *   row was added. Then accept, the positive control, does activate.
 * - Static: in the source, the only member-row write that sets `status` to `active` is the accept
 *   write, and nothing writes `activated_at`.
 */
type Body = Record<string, unknown>;

const ACCEPT_ROUTE = 'POST /v1/invites/{token}/accept';
const SRC = resolve(__dirname, '../../src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

describe('only accept activates a member row (API-100-30 AC5)', () => {
  let app: NestFastifyApplication;
  let client: Client;

  beforeAll(async () => {
    ({ app } = await createTestApp(
      {},
      withTestConfig({
        RATE_LIMIT_AUTHENTICATED_MAX: '1000000',
        RATE_LIMIT_PUBLIC_MAX: '1000000',
        RATE_LIMIT_EMERGENCY_WRITE_MAX: '1000000',
        RATE_LIMIT_LOCATION_PING_MAX: '1000000',
      }),
    ));
    client = await openTestClient();
  });

  afterAll(async () => {
    await client?.end();
    await app?.close();
  });

  const activeState = async () =>
    (
      await client.query<Body>(
        `select id::text, status, role, activated_at::text as activated_at
           from public.safety_circle_members
          where status = 'active' or activated_at is not null
          order by id`,
      )
    ).rows;

  it('every registered route except accept, with hostile bodies, activates nothing', async () => {
    const routes = discoverRoutes(collectControllers(AppModule));
    const names = routes.map((r) => `${r.method.toUpperCase()} ${r.path}`);
    expect(names).toContain(ACCEPT_ROUTE);
    const fastify = app.getHttpAdapter().getInstance();
    for (const route of routes) {
      const url = route.path.replace(/\{(\w+)\}/g, ':$1');
      expect({
        route: route.name,
        registered: fastify.hasRoute({ method: route.method.toUpperCase(), url }),
      }).toEqual({ route: route.name, registered: true });
    }

    const owner = await createUser(client, { fullName: 'Owner', phone: true });
    const circle = await createCircle(client, owner);
    const ben = await createUser(client, { fullName: 'Ben', phone: true });
    await addActiveMember(client, circle, ben);
    const invitee = await createUser(client, { fullName: 'Link Invitee' });
    const phoneInvitee = await createUser(client, { fullName: 'Phone Invitee', phone: true });
    const link = await insertMember(client, circle.id, { name: 'Link' });
    const phoneRow = await insertMember(client, circle.id, { phone: phoneInvitee.phone });
    const expired = await insertExpiredMember(client, circle.id, { name: 'Expired' });
    const declined = await insertMember(client, circle.id, { status: 'declined', canceled: true });
    const incident = await createIncident(client, owner, circle);

    const hostile = {
      status: 'active',
      role: 'owner',
      user_id: invitee.id,
      member_status: 'active',
      activated_at: '2000-01-01T00:00:00Z',
      invite_consumed_at: '2000-01-01T00:00:00Z',
      invite_token: link.token,
      display_name: 'Hostile',
      phone: '+447700900999',
      emergency_type: 'medical',
      location_source: 'unavailable',
      invites: [{ phone: '+447700900998', display_name: 'H', status: 'active' }],
    };
    const paramValues = (param: string, target: 'link' | 'phone' | 'expired' | 'declined') => {
      const row = { link, phone: phoneRow, expired, declined }[target];
      switch (param) {
        case 'token':
          return row.token;
        case 'member_id':
          return row.id;
        case 'circle_id':
          return circle.id;
        case 'id':
          return incident.id;
        default:
          throw new Error(`No value for path parameter {${param}}: add one to this test`);
      }
    };

    const before = await activeState();
    const callers = [owner, ben, invitee, phoneInvitee];
    const statuses: string[] = [];
    for (const route of routes) {
      if (`${route.method.toUpperCase()} ${route.path}` === ACCEPT_ROUTE) continue;
      for (const target of ['link', 'phone', 'expired', 'declined'] as const) {
        const url = route.path.replace(/\{(\w+)\}/g, (_m, p: string) => paramValues(p, target));
        for (const caller of callers) {
          const reply = await app.inject({
            method: route.method.toUpperCase() as 'GET',
            url,
            headers: {
              ...(await authHeader(caller.id)),
              'idempotency-key': randomUUID(),
              ...(route.method.toUpperCase() === 'GET'
                ? {}
                : { 'content-type': 'application/json' }),
            },
            ...(route.method.toUpperCase() === 'GET' ? {} : { payload: JSON.stringify(hostile) }),
          });
          statuses.push(`${route.method} ${route.path} → ${reply.statusCode}`);
          expect({ route: url, status: reply.statusCode < 500 }).toEqual({
            route: url,
            status: true,
          });
        }
        if (!route.path.includes('{')) break;
      }
    }
    expect(statuses.length).toBeGreaterThan(routes.length);
    expect(await activeState()).toEqual(before);
    for (const row of [link, phoneRow, expired, declined]) {
      expect((await memberRow(client, row.id)).status).not.toBe('active');
    }

    // Positive control: accept activates, with the trigger's time (a fresh circle and invite: the
    // loop above may have rotated, claimed or declined the others).
    const control = await createCircle(client, await createUser(client));
    const controlRow = await insertMember(client, control.id);
    const joiner = await createUser(client);
    const accepted = await acceptInvite(app, joiner.id, controlRow.token);
    expect(accepted.statusCode).toBe(200);
    const after = await memberRow(client, controlRow.id);
    expect(after.status).toBe('active');
    expect(after.activated_at).toEqual(after.invite_consumed_at);
  });

  it('in the source, only the accept write sets status active, and nothing writes activated_at', () => {
    const activating: string[] = [];
    const activatedAtWrites: string[] = [];
    // `db/tooling` is the local CLI (baseline, migrations, the fake seed of README), never a route.
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8');
      const name = relative(SRC, file).replace(/\\/g, '/');
      if (name.startsWith('db/tooling/')) continue;
      // `set ... status = 'active'` of an UPDATE, or `'active'` in the VALUES of an INSERT.
      for (const statement of text.matchAll(
        /(update\s+public\.safety_circle_members[\s\S]*?(?:where|returning)|insert\s+into\s+public\.safety_circle_members[\s\S]*?(?:returning|on conflict|`))/gi,
      )) {
        if (/'active'/.test(statement[0])) activating.push(name);
        if (/activated_at/.test(statement[0])) activatedAtWrites.push(name);
      }
      // The record-style SET of `invitee-invites.repository.ts`.
      if (/status:\s*sql`'active'`/.test(text)) activating.push(`${name} (set record)`);
    }
    expect(activating).toEqual(['modules/invites/invitee-invites.repository.ts (set record)']);
    expect(activatedAtWrites).toEqual([]);
  });
});
