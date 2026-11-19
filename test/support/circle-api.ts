import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { authHeader } from '../../src/testing/test-tokens';

/**
 * Circle routes (API-100-24/25) and their SQL counterparts, for integration and parity tests.
 * `userId: null` sends no token.
 */
const headersFor = async (userId: string | null) => (userId ? await authHeader(userId) : {});

/** `GET /v1/me/circle` (C1). */
export async function getOwnCircle(app: NestFastifyApplication, userId: string | null) {
  return app.inject({ method: 'GET', url: '/v1/me/circle', headers: await headersFor(userId) });
}

/** `GET /v1/me/circle/capacity` (C2). */
export async function getCapacity(app: NestFastifyApplication, userId: string | null) {
  return app.inject({
    method: 'GET',
    url: '/v1/me/circle/capacity',
    headers: await headersFor(userId),
  });
}

/** `GET /v1/circles/{circle_id}/members` (C3). `circleId` is put in the path as is. */
export async function listMembers(
  app: NestFastifyApplication,
  userId: string | null,
  circleId: string,
) {
  return app.inject({
    method: 'GET',
    url: `/v1/circles/${circleId}/members`,
    headers: await headersFor(userId),
  });
}

export interface SqlCallOptions {
  /**
   * The request `Host` header PostgREST would pass (`request.headers`), which `_avatars_public_url`
   * turns into `https://<host>/storage/v1/object/public/avatars/...`. Without it the SQL returns the
   * bare path (direct SQL).
   */
  host?: string;
}

/**
 * Runs `select <call> as body` as `userId` (role `authenticated`, JWT claims, `TimeZone` UTC) in its
 * own committed transaction, as PostgREST does on the hosted project.
 */
export async function sqlAs<T = unknown>(
  client: Client,
  userId: string,
  call: string,
  params: unknown[] = [],
  options: SqlCallOptions = {},
): Promise<T> {
  await client.query('begin');
  try {
    await client.query(
      `select set_config('request.jwt.claim.sub', $1, true),
              set_config('request.jwt.claims', $2, true),
              set_config('request.headers', $3, true),
              set_config('TimeZone', 'UTC', true)`,
      [
        userId,
        JSON.stringify({ sub: userId, role: 'authenticated' }),
        JSON.stringify(options.host ? { host: options.host } : {}),
      ],
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
 * The SQL function's error message (`fn:code`) when `sqlAs` raises, else `undefined` (no error). For
 * asserting the SQL side of an error case.
 */
export async function sqlErrorAs(
  client: Client,
  userId: string,
  call: string,
  params: unknown[] = [],
): Promise<string | undefined> {
  try {
    await sqlAs(client, userId, call, params);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

/**
 * The app's own-circle read through RLS, as PostgREST runs it for
 * `from('safety_circles').select().eq('owner_id', uid).maybeSingle()`: `row_to_json` of the row
 * (column order), as the `authenticated` role in UTC. Null when there is none.
 */
export async function ownCircleViaRls(
  client: Client,
  userId: string,
): Promise<Record<string, unknown> | null> {
  await client.query('begin');
  try {
    await client.query(
      `select set_config('request.jwt.claim.sub', $1, true),
              set_config('request.jwt.claims', $2, true),
              set_config('TimeZone', 'UTC', true)`,
      [userId, JSON.stringify({ sub: userId, role: 'authenticated' })],
    );
    await client.query('set local role authenticated');
    const { rows } = await client.query<{ body: Record<string, unknown> }>(
      'select row_to_json(c) as body from public.safety_circles c where c.owner_id = $1',
      [userId],
    );
    return rows[0]?.body ?? null;
  } finally {
    await client.query('rollback');
  }
}

/** The envelope's error object of a reply. */
export function errorOf(reply: { json: <T>() => T }): { code: string; details: unknown } {
  return reply.json<{ error: { code: string; details: unknown } }>().error;
}
