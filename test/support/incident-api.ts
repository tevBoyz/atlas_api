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
 * `POST /v1/incidents/{id}/mark-safe` as `userId` (API-100-19), with a fresh Idempotency-Key unless
 * one is given (`null` sends none).
 */
export async function markSafe(
  app: NestFastifyApplication,
  userId: string,
  incidentId: string,
  key: string | null = randomUUID(),
  token: TestTokenOptions = {},
) {
  return app.inject({
    method: 'POST',
    url: `/v1/incidents/${incidentId}/mark-safe`,
    headers: {
      ...(await authHeader(userId, token)),
      ...(key === null ? {} : { 'idempotency-key': key }),
    },
  });
}

/**
 * `mark_incident_safe` through the SQL function, as the resident, the way today's app closes an
 * alert. For tests that prove the API and the SQL function are interchangeable; anything about the
 * API's own behaviour uses {@link markSafe}.
 */
export function markSafeViaSql(client: Client, userId: string, incidentId: unknown) {
  return callSqlAs<Record<string, unknown>>(client, userId, 'public.mark_incident_safe($1)', [
    incidentId,
  ]);
}

/**
 * `POST /v1/incidents/{id}/locations` as `userId`. `body` is sent as is when it is a string (the exact
 * JSON text, e.g. with `1e400` or `"\u0000"` in it), else JSON-encoded.
 */
export async function attachLocation(
  app: NestFastifyApplication,
  userId: string,
  incidentId: string,
  body: unknown,
) {
  return app.inject({
    method: 'POST',
    url: `/v1/incidents/${incidentId}/locations`,
    headers: { ...(await authHeader(userId)), 'content-type': 'application/json' },
    payload: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** `PUT /v1/incidents/{id}/notes` as `userId`; a string body is sent as is. */
export async function setIncidentNotes(
  app: NestFastifyApplication,
  userId: string,
  incidentId: string,
  body: unknown,
) {
  return app.inject({
    method: 'PUT',
    url: `/v1/incidents/${incidentId}/notes`,
    headers: { ...(await authHeader(userId)), 'content-type': 'application/json' },
    payload: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** `POST /v1/incidents/{id}/renotify` as `userId` (no body, no Idempotency-Key). */
export async function renotifyAlert(
  app: NestFastifyApplication,
  userId: string,
  incidentId: string,
) {
  return app.inject({
    method: 'POST',
    url: `/v1/incidents/${incidentId}/renotify`,
    headers: await authHeader(userId),
  });
}

/** `GET /v1/config/live-location` as `userId`. */
export async function getLiveLocationConfig(app: NestFastifyApplication, userId: string) {
  return app.inject({
    method: 'GET',
    url: '/v1/config/live-location',
    headers: await authHeader(userId),
  });
}

/** A SQL call's outcome: its JSON, its `fn:code` (P0001), or the SQLSTATE of any other error. */
export type SqlOutcome =
  { ok: true; body: Record<string, unknown> } | { ok: false; code: string; sqlState: string };

/**
 * Calls an RPC the way PostgREST does: the request body (JSON text, as the app sent it) is read with
 * `json_to_record` into the function's parameter types, then the function runs as `userId` in its own
 * committed transaction (TimeZone UTC, as on the hosted database). `argColumns` are the record
 * columns in parameter order (body key and SQL type); `leading` are values placed before them (the
 * path id, as text: its uuid conversion happens in Postgres too).
 */
export async function callAsPostgrest(
  client: Client,
  userId: string,
  fn: string,
  leading: { value: string; type: string }[],
  argColumns: { key: string; type: string }[],
  body: string,
): Promise<SqlOutcome> {
  const lead = leading.map((arg, index) => `$${index + 2}::${arg.type}`);
  const args = [...lead, ...argColumns.map((col) => `r.${col.key}`)].join(', ');
  const record = argColumns.map((col) => `${col.key} ${col.type}`).join(', ');
  try {
    const result = await callSqlAs<Record<string, unknown>>(
      client,
      userId,
      `(select ${fn}(${args}) from json_to_record($1::json) as r(${record}))`,
      [body, ...leading.map((arg) => arg.value)],
    );
    return { ok: true, body: result };
  } catch (error) {
    const { code, message } = error as { code?: string; message?: string };
    return {
      ok: false,
      code: code === 'P0001' ? String(message) : `sqlstate:${code}`,
      sqlState: String(code),
    };
  }
}

/** `attach_incident_location` through {@link callAsPostgrest}, with the API's body keys. */
export function attachViaPostgrest(
  client: Client,
  userId: string,
  incidentId: string,
  body: string,
): Promise<SqlOutcome> {
  return callAsPostgrest(
    client,
    userId,
    'public.attach_incident_location',
    [{ value: incidentId, type: 'uuid' }],
    [
      { key: 'location_source', type: 'text' },
      { key: 'location_lat', type: 'double precision' },
      { key: 'location_lng', type: 'double precision' },
      { key: 'location_accuracy_m', type: 'double precision' },
      { key: 'location_captured_at', type: 'timestamptz' },
    ],
    body,
  );
}

/** `set_incident_notes` through {@link callAsPostgrest}, with the API's body key. */
export function setNotesViaPostgrest(
  client: Client,
  userId: string,
  incidentId: string,
  body: string,
): Promise<SqlOutcome> {
  return callAsPostgrest(
    client,
    userId,
    'public.set_incident_notes',
    [{ value: incidentId, type: 'uuid' }],
    [{ key: 'incident_notes', type: 'text' }],
    body,
  );
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

/** `GET /v1/incidents/{id}/delivery-counts` as `userId` (API-100-20). */
export async function getDeliveryCounts(
  app: NestFastifyApplication,
  userId: string,
  incidentId: string,
) {
  return app.inject({
    method: 'GET',
    url: `/v1/incidents/${incidentId}/delivery-counts`,
    headers: await authHeader(userId),
  });
}

/** `POST /v1/incidents/{id}/acknowledge` as `userId` (API-100-20; no body, no Idempotency-Key). */
export async function acknowledgeIncident(
  app: NestFastifyApplication,
  userId: string,
  incidentId: string,
) {
  return app.inject({
    method: 'POST',
    url: `/v1/incidents/${incidentId}/acknowledge`,
    headers: await authHeader(userId),
  });
}

/**
 * Runs `select <call>` as `userId` like {@link callSqlAs}, but returns the outcome instead of
 * throwing: the JSON, or the `fn:code` (P0001) / `sqlstate:<code>` of the error.
 */
export async function sqlOutcomeAs(
  client: Client,
  userId: string,
  call: string,
  params: unknown[] = [],
): Promise<SqlOutcome> {
  try {
    return {
      ok: true,
      body: await callSqlAs<Record<string, unknown>>(client, userId, call, params),
    };
  } catch (error) {
    const { code, message } = error as { code?: string; message?: string };
    return {
      ok: false,
      code: code === 'P0001' ? String(message) : `sqlstate:${code}`,
      sqlState: String(code),
    };
  }
}

/** `GET /v1/responder/incidents` as `userId` (API-100-21). */
export async function listResponderIncidents(app: NestFastifyApplication, userId: string) {
  return app.inject({
    method: 'GET',
    url: '/v1/responder/incidents',
    headers: await authHeader(userId),
  });
}

/** `GET /v1/incidents/{id}` as `userId` (API-100-21). */
export async function getIncidentDetails(
  app: NestFastifyApplication,
  userId: string,
  incidentId: string,
) {
  return app.inject({
    method: 'GET',
    url: `/v1/incidents/${incidentId}`,
    headers: await authHeader(userId),
  });
}

/** `GET /v1/incidents/{id}/events` as `userId` (API-100-22). */
export async function getIncidentEvents(
  app: NestFastifyApplication,
  userId: string,
  incidentId: string,
) {
  return app.inject({
    method: 'GET',
    url: `/v1/incidents/${incidentId}/events`,
    headers: await authHeader(userId),
  });
}

/**
 * `POST /v1/incidents/{id}/updates` as `userId` (SCRUM-44/59, D70), with a fresh Idempotency-Key
 * unless one is given.
 */
export async function sendIncidentUpdate(
  app: NestFastifyApplication,
  userId: string,
  incidentId: string,
  body: unknown,
  key: string = randomUUID(),
) {
  return app.inject({
    method: 'POST',
    url: `/v1/incidents/${incidentId}/updates`,
    headers: {
      ...(await authHeader(userId)),
      'idempotency-key': key,
      'content-type': 'application/json',
    },
    payload: JSON.stringify(body),
  });
}

/** `GET /v1/incidents/{id}/updates` as `userId` (SCRUM-44/59, D70). */
export async function listIncidentUpdates(
  app: NestFastifyApplication,
  userId: string,
  incidentId: string,
) {
  return app.inject({
    method: 'GET',
    url: `/v1/incidents/${incidentId}/updates`,
    headers: await authHeader(userId),
  });
}
