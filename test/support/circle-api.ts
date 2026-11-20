import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Client } from 'pg';

import { authHeader } from '../../src/testing/test-tokens';

/**
 * Circle routes (API-100-24/25/31/32) and their SQL counterparts, for integration and parity tests.
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

export interface InviteCallOptions {
  /** Sent as `Idempotency-Key`. */
  idempotencyKey?: string;
}

async function postJson(
  app: NestFastifyApplication,
  userId: string | null,
  url: string,
  body: unknown,
  options: InviteCallOptions = {},
) {
  return app.inject({
    method: 'POST',
    url,
    headers: {
      ...(await headersFor(userId)),
      ...(options.idempotencyKey ? { 'idempotency-key': options.idempotencyKey } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}

/** `POST /v1/me/circle/invites/phone` (I1). */
export function invitePhone(
  app: NestFastifyApplication,
  userId: string | null,
  body: unknown,
  options: InviteCallOptions = {},
) {
  return postJson(app, userId, '/v1/me/circle/invites/phone', body, options);
}

/** `POST /v1/me/circle/invites/phone/batch` (I2). */
export function inviteBatch(
  app: NestFastifyApplication,
  userId: string | null,
  body: unknown,
  options: InviteCallOptions = {},
) {
  return postJson(app, userId, '/v1/me/circle/invites/phone/batch', body, options);
}

/** `POST /v1/me/circle/invites/link` (I3). `body` undefined sends no body at all. */
export function createInviteLink(
  app: NestFastifyApplication,
  userId: string | null,
  body: unknown,
  options: InviteCallOptions = {},
) {
  return postJson(app, userId, '/v1/me/circle/invites/link', body, options);
}

/** `POST /v1/me/circle/invites/{member_id}/resend` (I4). */
export function resendInvite(app: NestFastifyApplication, userId: string | null, memberId: string) {
  return postJson(app, userId, `/v1/me/circle/invites/${memberId}/resend`, undefined);
}

/** `POST /v1/me/circle/invites/{member_id}/cancel` (I5). */
export function cancelInvite(app: NestFastifyApplication, userId: string | null, memberId: string) {
  return postJson(app, userId, `/v1/me/circle/invites/${memberId}/cancel`, undefined);
}

/**
 * The invitee routes (API-100-29/30). `token` is URL-encoded into the path; pass `{ raw: true }` to
 * put it in the path exactly as given (e.g. `%20`).
 */
export interface TokenPathOptions {
  raw?: boolean;
}
const tokenPath = (token: string, options: TokenPathOptions) =>
  options.raw ? token : encodeURIComponent(token);

/** `GET /v1/invites/{token}/status` (I6). Public: no token is sent unless `userId` is given. */
export async function lookupInvite(
  app: NestFastifyApplication,
  token: string,
  options: TokenPathOptions & { userId?: string; headers?: Record<string, string> } = {},
) {
  return app.inject({
    method: 'GET',
    url: `/v1/invites/${tokenPath(token, options)}/status`,
    headers: { ...(await headersFor(options.userId ?? null)), ...(options.headers ?? {}) },
  });
}

/** `POST /v1/invites/{token}/preview` (I7). */
export function previewInvite(
  app: NestFastifyApplication,
  userId: string | null,
  token: string,
  options: TokenPathOptions = {},
) {
  return postJson(app, userId, `/v1/invites/${tokenPath(token, options)}/preview`, undefined);
}

/** `POST /v1/invites/{token}/accept` (I8). */
export function acceptInvite(
  app: NestFastifyApplication,
  userId: string | null,
  token: string,
  options: TokenPathOptions = {},
) {
  return postJson(app, userId, `/v1/invites/${tokenPath(token, options)}/accept`, undefined);
}

/** `POST /v1/invites/{token}/decline` (I9). */
export function declineInvite(
  app: NestFastifyApplication,
  userId: string | null,
  token: string,
  options: TokenPathOptions = {},
) {
  return postJson(app, userId, `/v1/invites/${tokenPath(token, options)}/decline`, undefined);
}

/** `GET /v1/me/invites` (I10, `list_my_circle_invites`). */
export async function listMyInvites(app: NestFastifyApplication, userId: string | null) {
  return app.inject({ method: 'GET', url: '/v1/me/invites', headers: await headersFor(userId) });
}

/** `GET /v1/me/joined-circles` (C6, `list_my_joined_circles`). */
export async function listJoinedCircles(app: NestFastifyApplication, userId: string | null) {
  return app.inject({
    method: 'GET',
    url: '/v1/me/joined-circles',
    headers: await headersFor(userId),
  });
}

/** `DELETE /v1/circles/{circle_id}/members/{member_id}` (C4, `remove_circle_member`). */
export async function removeMember(
  app: NestFastifyApplication,
  userId: string | null,
  circleId: string,
  memberId: string,
) {
  return app.inject({
    method: 'DELETE',
    url: `/v1/circles/${circleId}/members/${memberId}`,
    headers: await headersFor(userId),
  });
}

/** `POST /v1/circles/{circle_id}/leave` (C5, `leave_safety_circle`). */
export function leaveCircle(app: NestFastifyApplication, userId: string | null, circleId: string) {
  return postJson(app, userId, `/v1/circles/${circleId}/leave`, undefined);
}

/**
 * Runs `select <call> as body` as `userId` like {@link sqlAs}, then reads `inspect` (as the
 * migration role, same transaction) and ROLLS BACK: the SQL function's answer and its effect for a
 * state the API is then called on. `error` is the `fn:code` when the function raised.
 */
export async function sqlRolledBack<T = unknown, R = unknown>(
  client: Client,
  userId: string,
  call: string,
  params: unknown[] = [],
  inspect?: { statement: string; params?: unknown[] },
  options: SqlCallOptions = {},
): Promise<{ body?: T; error?: string; rows?: R[] }> {
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
    await client.query('savepoint call');
    let body: T | undefined;
    let error: string | undefined;
    try {
      body = (await client.query<{ body: T }>(`select ${call} as body`, params)).rows[0].body;
    } catch (caught) {
      error = (caught as Error).message;
      await client.query('rollback to savepoint call');
    }
    const rows = inspect
      ? (await client.query<R & Record<string, unknown>>(inspect.statement, inspect.params ?? []))
          .rows
      : undefined;
    return { body, error, rows };
  } finally {
    await client.query('rollback');
  }
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
