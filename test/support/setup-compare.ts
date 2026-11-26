import type { Client } from 'pg';

import { errorOf } from './circle-api';
import type { ApiReply } from './invite-rows';

/**
 * `POST /v1/me/profile/complete` (API-100-36) and its effects, reduced to a snapshot a test can
 * assert exactly:
 * - the owner's circle (name, created now or not) and every member row of it, owner first;
 * - row ids: kept as is for rows that existed before, `new` for rows the call created;
 * - invite tokens: `kept` (same as before), `new` (a fresh token) or null;
 * - timestamps: `now` when the call wrote them (at or after the cutoff taken just before the call),
 *   else their stored text; `activated_at` also says whether it equals `invited_at` (trigger time
 *   of a new owner row);
 * - the profile's `profile_setup_completed_at` (`now` or its kept text) and `updated_at` written;
 */
type Body = Record<string, unknown>;

export interface SetupSnapshot {
  circle: Body | null;
  members: Body[];
  profile: Body;
}

const SNAPSHOT_SQL = `
  select jsonb_build_object(
    'circle', (
      select jsonb_build_object('id', c.id, 'name', c.name, 'created_now', c.created_at >= $2::timestamptz)
        from public.safety_circles c where c.owner_id = $1::uuid),
    'profile', (
      select jsonb_build_object(
               'setup_completed_at', p.profile_setup_completed_at::text,
               'setup_now', p.profile_setup_completed_at >= $2::timestamptz,
               'updated_now', p.updated_at >= $2::timestamptz)
        from public.profiles p where p.id = $1::uuid),
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', m.id, 'role', m.role, 'status', m.status, 'display_name', m.display_name,
               'relationship', m.relationship, 'phone', m.phone, 'email', m.email,
               'user_id', m.user_id, 'invite_token', m.invite_token,
               'invited_at', m.invited_at::text, 'invited_now', m.invited_at >= $2::timestamptz,
               'expires_at', m.invite_expires_at::text,
               'expires_in_7_days', m.invite_expires_at >= $2::timestamptz + interval '7 days',
               'canceled_at', m.invite_canceled_at::text, 'consumed_at', m.invite_consumed_at::text,
               'activated_at', m.activated_at::text,
               'activated_now', m.activated_at >= $2::timestamptz,
               'activated_at_invited_at', m.activated_at = m.invited_at,
               'updated_now', m.updated_at >= $2::timestamptz)
             order by m.role desc, m.phone nulls first, m.display_name, m.id)
        from public.safety_circle_members m
        join public.safety_circles c on c.id = m.circle_id
       where c.owner_id = $1::uuid), '[]'::jsonb)
  ) as snap`;

interface Before {
  circleId: string | null;
  ids: Set<string>;
  tokens: Map<string, string | null>;
  setupCompletedAt: string | null;
}

async function before(client: Client, ownerId: string): Promise<Before> {
  const rows = (
    await client.query<{ id: string; token: string | null; circle_id: string }>(
      `select m.id::text, m.invite_token as token, c.id::text as circle_id
         from public.safety_circle_members m
         join public.safety_circles c on c.id = m.circle_id
        where c.owner_id = $1`,
      [ownerId],
    )
  ).rows;
  const circle = (
    await client.query<{ id: string }>(
      'select id::text from public.safety_circles where owner_id = $1',
      [ownerId],
    )
  ).rows[0];
  const setup = (
    await client.query<{ t: string | null }>(
      'select profile_setup_completed_at::text as t from public.profiles where id = $1',
      [ownerId],
    )
  ).rows[0];
  return {
    circleId: circle?.id ?? null,
    ids: new Set(rows.map((r) => r.id)),
    tokens: new Map(rows.map((r) => [r.id, r.token])),
    setupCompletedAt: setup?.t ?? null,
  };
}

function normalize(raw: SetupSnapshot, prior: Before): SetupSnapshot {
  const circle = raw.circle
    ? {
        ...raw.circle,
        id: raw.circle.id === prior.circleId ? raw.circle.id : 'new',
      }
    : null;
  const members = raw.members.map((m) => {
    const id = m.id as string;
    const existed = prior.ids.has(id);
    const token = m.invite_token as string | null;
    const out: Body = {
      ...m,
      id: existed ? id : 'new',
      invite_token:
        token === null ? null : existed && prior.tokens.get(id) === token ? 'kept' : 'new',
    };
    if (m.invited_now) out.invited_at = 'now';
    if (m.invited_now || m.expires_in_7_days) out.expires_at = m.expires_at ? 'now+7d' : null;
    if (m.activated_now) out.activated_at = 'now';
    return out;
  });
  const profile = raw.profile
    ? {
        ...raw.profile,
        setup_completed_at: raw.profile.setup_now ? 'now' : raw.profile.setup_completed_at,
      }
    : raw.profile;
  return { circle, members, profile };
}

export interface SetupRun {
  /** The error code when the API refused (4xx), else undefined. */
  apiError?: string;
  apiBody?: Body;
  /** The normalized snapshot of the effects. */
  snapshot: SetupSnapshot;
  reply: ApiReply;
}

/**
 * Runs the API's setup for `ownerId` and returns its answer and its effects, normalized (see the
 * file comment) so a test can assert exactly what was created, kept or refreshed.
 */
export async function runSetup(
  client: Client,
  ownerId: string,
  api: () => Promise<ApiReply>,
): Promise<SetupRun> {
  const prior = await before(client, ownerId);
  const cutoff = (await client.query<{ t: string }>('select clock_timestamp()::text as t')).rows[0]
    .t;
  const reply = await api();
  if (reply.statusCode >= 500)
    throw new Error(`The API answered ${reply.statusCode} ${reply.body}`);
  const apiSnap = (await client.query<{ snap: SetupSnapshot }>(SNAPSHOT_SQL, [ownerId, cutoff]))
    .rows[0].snap;
  return {
    apiError: reply.statusCode >= 400 ? errorOf(reply).code : undefined,
    apiBody: reply.statusCode === 200 ? reply.json<Body>() : undefined,
    snapshot: normalize(apiSnap, prior),
    reply,
  };
}
