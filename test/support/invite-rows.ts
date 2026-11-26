import { randomUUID } from 'node:crypto';

import type { Client } from 'pg';

import { errorOf } from './circle-api';
import { fakeInviteToken, type Queryable } from './fixtures';

/**
 * Member rows in any invite state and the row checks of the invitee operations (API-100-29/30). Rows are written as the migration role (the triggers still run); `activated_at`
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
 * A membership that ended: gone (remove deletes a pending or declined row) or kept as history (D44: status `removed` / `left`, `ended_at`
 * set, no token, not active). Either way it is no membership any more.
 */
export async function expectMembershipGone(q: Queryable, id: string): Promise<void> {
  const row = await memberRow(q, id);
  if (row === undefined) return;
  expect(row).toMatchObject({ invite_token: null, activated_at: null });
  expect(['removed', 'left']).toContain(row.status);
  expect(row.ended_at).not.toBeNull();
}

export interface ApiReply {
  statusCode: number;
  body: string;
  json: <T>() => T;
}

export interface CallWithRows {
  /** The API's error code (`fn:code`) when it refused, else undefined. */
  apiError?: string;
  /** The parsed answer when it succeeded. */
  body?: unknown;
  reply: ApiReply;
  /** Ids of rows of `circleIds` this call ended as history (`removed` / `left`, D44). */
  endedNow: string[];
}

/**
 * Runs one API call and reports its answer and which member rows of `circleIds` it ended (D44:
 * remove / leave keep the row as `removed` / `left`). A 5xx fails at once with its body.
 */
export async function callWithRows(
  client: Client,
  options: { callerId: string; circleIds: string[]; api: () => Promise<ApiReply> },
): Promise<CallWithRows> {
  const ended = async () =>
    new Set(
      (
        await client.query<{ id: string }>(
          `select id::text from public.safety_circle_members
            where circle_id = any($1::uuid[]) and status in ('removed', 'left')`,
          [options.circleIds],
        )
      ).rows.map((r) => r.id),
    );
  const before = await ended();
  const reply = await options.api();
  if (reply.statusCode >= 500)
    throw new Error(`The API answered ${reply.statusCode} ${reply.body}`);
  const after = await ended();
  return {
    apiError: reply.statusCode >= 400 ? errorOf(reply).code : undefined,
    body: reply.statusCode < 300 && reply.body ? (JSON.parse(reply.body) as unknown) : undefined,
    reply,
    endedNow: [...after].filter((id) => !before.has(id)).sort(),
  };
}
