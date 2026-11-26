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
