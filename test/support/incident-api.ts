import { randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { authHeader, type TestTokenOptions } from '../../src/testing/test-tokens';

/** `POST /v1/incidents` as `userId`, with a fresh Idempotency-Key unless one is given. */
export async function submitAlert(
  app: NestFastifyApplication,
  userId: string,
  emergencyType: unknown,
  key: string = randomUUID(),
  token: TestTokenOptions = {},
) {
  return app.inject({
    method: 'POST',
    url: '/v1/incidents',
    headers: {
      ...(await authHeader(userId, token)),
      'idempotency-key': key,
      'content-type': 'application/json',
    },
    payload: JSON.stringify({ emergency_type: emergencyType }),
  });
}

/** Runs the SQL function as `userId` in its own committed transaction, as PostgREST would. */
export async function submitAlertViaSql(
  client: Client,
  userId: string,
  emergencyType: string,
): Promise<Record<string, unknown>> {
  await client.query('begin');
  try {
    await client.query(
      `select set_config('request.jwt.claim.sub', $1, true),
              set_config('request.jwt.claims', $2, true)`,
      [userId, JSON.stringify({ sub: userId, role: 'authenticated' })],
    );
    const { rows } = await client.query<{ body: Record<string, unknown> }>(
      'select public.submit_emergency_alert($1) as body',
      [emergencyType],
    );
    await client.query('commit');
    return rows[0].body;
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}

/** `GET /v1/me/incidents/open` as `userId`. */
export async function getOpenIncident(
  app: NestFastifyApplication,
  userId: string,
  token: TestTokenOptions = {},
) {
  return app.inject({
    method: 'GET',
    url: '/v1/me/incidents/open',
    headers: await authHeader(userId, token),
  });
}

/** `GET /v1/me/incidents` as `userId`; `query` is the raw query string (e.g. `limit=3`). */
export async function listRecentIncidents(app: NestFastifyApplication, userId: string, query = '') {
  return app.inject({
    method: 'GET',
    url: `/v1/me/incidents${query ? `?${query}` : ''}`,
    headers: await authHeader(userId),
  });
}

/**
 * Runs `select <call> as body` as `userId` in its own committed transaction, as PostgREST would
 * against the hosted database (session time zone UTC). E.g.
 * `callSqlAs(client, id, 'public.list_my_recent_incidents($1)', [3])`.
 */
export async function callSqlAs<T = unknown>(
  client: Client,
  userId: string,
  call: string,
  params: unknown[] = [],
): Promise<T> {
  await client.query('begin');
  try {
    await client.query(
      `select set_config('request.jwt.claim.sub', $1, true),
              set_config('request.jwt.claims', $2, true),
              set_config('TimeZone', 'UTC', true)`,
      [userId, JSON.stringify({ sub: userId, role: 'authenticated' })],
    );
    const { rows } = await client.query<{ body: T }>(`select ${call} as body`, params);
    await client.query('commit');
    return rows[0].body;
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}

/**
 * `mark_incident_safe` through the SQL function, as the resident. Its endpoint is API-100-19: until
 * then, tests that need a closed incident close it the way today's app does.
 */
export function markSafeViaSql(client: Client, userId: string, incidentId: unknown) {
  return callSqlAs<Record<string, unknown>>(client, userId, 'public.mark_incident_safe($1)', [
    incidentId,
  ]);
}

/** Row count of a parameterised `select count(*)::int as n ...`. */
export async function countRows(
  client: Client,
  sql: string,
  params: unknown[] = [],
): Promise<number> {
  const { rows } = await client.query<{ n: number }>(sql, params);
  return rows[0].n;
}
