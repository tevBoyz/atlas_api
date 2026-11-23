import { randomUUID } from 'node:crypto';

import type { Client } from 'pg';

import { errorOf, sqlRolledBack } from './circle-api';
import { fakeInviteToken, type Queryable } from './fixtures';

/**
 * Member rows in any invite state and the API ↔ SQL comparison of the invitee operations
 * (API-100-29/30). Rows are written as the migration role (the triggers still run); `activated_at`
 * is never written here.
 */
type Body = Record<string, unknown>;

export interface MemberRowOptions {
  name?: string;
  /** E.164 phone of a phone invite; null (default) = link invite. */
  phone?: string | null;
  status?: 'pending' | 'declined' | 'active';
  /** SQL for `invited_at` (default `now()`). */
  invitedSql?: string;
  /** SQL for `invite_expires_at` (default `now() + 7 days`); `null` for a row without one. */
  expiresSql?: string;
  canceled?: boolean;
  consumed?: boolean;
  userId?: string | null;
}

export interface MemberRow {
  id: string;
  token: string;
}

/** One member row with its own token. */
export async function insertMember(
  q: Queryable,
  circleId: string,
  options: MemberRowOptions = {},
): Promise<MemberRow> {
  const id = randomUUID();
  const token = fakeInviteToken();
  await q.query(
    `insert into public.safety_circle_members (id, circle_id, role, status, display_name,
       relationship, phone, user_id, invite_token, invited_at, invite_expires_at,
       invite_canceled_at, invite_consumed_at)
     values ($1, $2, 'member', $3, $4, 'friend', $5, $6, $7, ${options.invitedSql ?? 'now()'},
             ${options.expiresSql ?? "now() + interval '7 days'"},
             case when $8::boolean then now() end, case when $9::boolean then now() end)`,
    [
      id,
      circleId,
      options.status ?? 'pending',
      options.name ?? 'Row Name',
      options.phone ?? null,
      options.userId ?? null,
      token,
      options.canceled ?? false,
      options.consumed ?? false,
    ],
  );
  return { id, token };
}

/** An expired pending row (invited 10 days ago, expired 3 days ago). */
export const insertExpiredMember = (
  q: Queryable,
  circleId: string,
  options: MemberRowOptions = {},
) =>
  insertMember(q, circleId, {
    invitedSql: "now() - interval '10 days'",
    expiresSql: "now() - interval '3 days'",
    ...options,
  });

/**
 * Rows the capacity trigger would refuse (a circle already over 5, as the SQL scripts build it):
 * the trigger is disabled for this one statement batch only, inside a transaction.
 */
export async function insertOverCapacity(
  client: Client,
  circleId: string,
  rows: MemberRowOptions[],
): Promise<MemberRow[]> {
  await client.query('begin');
  try {
    await client.query(
      'alter table public.safety_circle_members disable trigger safety_circle_members_enforce_capacity',
    );
    const created: MemberRow[] = [];
    for (const row of rows) created.push(await insertMember(client, circleId, row));
    await client.query(
      'alter table public.safety_circle_members enable trigger safety_circle_members_enforce_capacity',
    );
    await client.query('commit');
    return created;
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}

/** The stored row of `id` (all columns). */
export async function memberRow(q: Queryable, id: string): Promise<Body> {
  return (await q.query<Body>('select * from public.safety_circle_members where id = $1', [id]))
    .rows[0];
}

/**
 * SCRUM-81 (D45): `GET /v1/me/joined-circles` adds `active_incident_id` to each element (additive,
 * not in `list_my_joined_circles`). Returns the elements without it, after checking each had it.
 */
export function withoutActiveIncidentId(body: unknown): unknown {
  if (!Array.isArray(body)) return body;
  return body.map((element: Record<string, unknown>) => {
    expect(element).toHaveProperty('active_incident_id');
    const rest = { ...element };
    delete rest.active_incident_id;
    return rest;
  });
}

/**
 * SCRUM-33 (D46): `GET /v1/me/invites` adds `owner_avatar_url` to each element (additive, not in
 * `list_my_circle_invites`). Returns the elements without it, after checking each had it.
 */
export function withoutOwnerAvatarUrl(body: unknown): unknown {
  if (!Array.isArray(body)) return body;
  return body.map((element: Record<string, unknown>) => {
    expect(element).toHaveProperty('owner_avatar_url');
    const rest = { ...element };
    delete rest.owner_avatar_url;
    return rest;
  });
}

/**
 * A membership that ended: gone (the SQL remove / leave deletes the row; the API deletes a pending
 * or declined row too) or kept by the API as history (D44: status `removed` / `left`, `ended_at`
 * set, no token, not active). Either way it is no membership any more.
 */
export async function expectMembershipGone(q: Queryable, id: string): Promise<void> {
  const row = await memberRow(q, id);
  if (row === undefined) return;
  expect(row).toMatchObject({ invite_token: null, activated_at: null });
  expect(['removed', 'left']).toContain(row.status);
  expect(row.ended_at).not.toBeNull();
}

/**
 * Every row of a circle, comparable across two runs of the same call: values, and whether the call
 * wrote each timestamp (at or after `cutoff`, taken just before the call).
 */
function circleRowsQuery(circleIds: string[], cutoff: string) {
  return {
    statement: `select m.id::text as id, m.circle_id::text as circle_id, m.role, m.status,
        m.display_name, m.relationship, m.phone, m.user_id::text as user_id, m.invite_token,
        m.invited_at::text as invited_at, m.invite_expires_at::text as invite_expires_at,
        m.invite_consumed_at is null as not_consumed,
        m.invite_consumed_at >= $2::timestamptz as consumed_now,
        m.invite_canceled_at is null as not_canceled,
        m.invite_canceled_at >= $2::timestamptz as canceled_now,
        m.activated_at is null as not_activated,
        m.activated_at >= $2::timestamptz as activated_now,
        m.activated_at = m.invite_consumed_at as activated_at_consume,
        m.updated_at >= $2::timestamptz as updated_now
      from public.safety_circle_members m
     where m.circle_id = any($1::uuid[])
     order by m.id`,
    params: [circleIds, cutoff],
  };
}

export interface ApiReply {
  statusCode: number;
  body: string;
  json: <T>() => T;
}

export interface SqlComparison {
  /** The SQL function's `fn:code`, or undefined when it answered. */
  sqlError?: string;
  sqlBody?: unknown;
  reply: ApiReply;
  /** Ids of rows the API ended as history where the SQL deleted them (D44 option only). */
  endedByApi?: string[];
}

/**
 * Runs the SQL function as `callerId` (rolled back), then the API call on the same state, and
 * requires the same answer (JSON text, i.e. keys, key order, nulls and values; or the same
 * `fn:code`) and the same rows of `circleIds` afterwards (values and which timestamps were written).
 * `host` is the Host header PostgREST would pass (avatar URLs).
 */
export async function compareWithSql(
  client: Client,
  options: {
    callerId: string;
    sqlCall: string;
    params: unknown[];
    circleIds: string[];
    api: () => Promise<ApiReply>;
    host?: string;
    /**
     * D44 (deliberate divergence, SCRUM-30/31): the SQL remove / leave DELETES an active member row;
     * the API keeps it as history (`removed` / `left`). With this set, API-side rows that are ended
     * and absent on the SQL side are left out of the row comparison and returned in
     * {@link SqlComparison.endedByApi} (the caller asserts their shape). Every other row, and the
     * SQL side itself, is compared as before.
     */
    endedHistoryDivergence?: boolean;
    /**
     * Additive API-only fields (e.g. SCRUM-81's `active_incident_id`, D45) are removed from the
     * API body by this before the text comparison; the rest must match the SQL exactly.
     */
    apiOnlyFields?: (body: unknown) => unknown;
  },
): Promise<SqlComparison> {
  const cutoff = (await client.query<{ t: string }>('select clock_timestamp()::text as t')).rows[0]
    .t;
  const rows = circleRowsQuery(options.circleIds, cutoff);
  const sqlSide = await sqlRolledBack<Body, Body>(
    client,
    options.callerId,
    options.sqlCall,
    options.params,
    rows,
    { host: options.host },
  );
  const reply = await options.api();
  if (sqlSide.error !== undefined) {
    if (reply.statusCode < 400) {
      throw new Error(
        `SQL raised ${sqlSide.error}; the API answered ${reply.statusCode} ${reply.body}`,
      );
    }
    if (errorOf(reply).code !== sqlSide.error) {
      throw new Error(`SQL raised ${sqlSide.error}; the API answered ${errorOf(reply).code}`);
    }
  } else if (reply.statusCode >= 300) {
    throw new Error(`SQL answered; the API answered ${reply.statusCode} ${reply.body}`);
  } else {
    const apiText = options.apiOnlyFields
      ? JSON.stringify(options.apiOnlyFields(JSON.parse(reply.body)))
      : reply.body;
    if (apiText !== JSON.stringify(sqlSide.body)) {
      throw new Error(`Bodies differ:\n  api ${apiText}\n  sql ${JSON.stringify(sqlSide.body)}`);
    }
  }
  let after = (await client.query<Body>(rows.statement, rows.params)).rows;
  const endedByApi: string[] = [];
  if (options.endedHistoryDivergence) {
    const sqlIds = new Set((sqlSide.rows ?? []).map((row) => row.id));
    after = after.filter((row) => {
      const divergent = (row.status === 'removed' || row.status === 'left') && !sqlIds.has(row.id);
      if (divergent) endedByApi.push(row.id as string);
      return !divergent;
    });
  }
  expectSameRows(after, sqlSide.rows ?? []);
  return { sqlError: sqlSide.error, sqlBody: sqlSide.body, reply, endedByApi };
}

function expectSameRows(api: Body[], sql: Body[]): void {
  const text = (rows: Body[]) => JSON.stringify(rows);
  if (text(api) !== text(sql)) {
    throw new Error(`Rows differ:\n  api ${text(api)}\n  sql ${text(sql)}`);
  }
}
