import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import type { DeviceInput } from './auth-input';
import { type AuthTx, firstRow, newOpaqueToken, tokenDigest } from './auth-transaction';

/** `device_sessions.auth_method`. */
export type AuthMethod =
  'password' | 'email_link' | 'otp' | 'google' | 'apple' | 'recovery' | 'exchange';

/** `device_sessions.revoke_reason`. */
export type RevokeReason =
  'logout' | 'logout_all' | 'deleted' | 'refresh_token_reused' | 'idle' | 'password_reset';

/** Where a session was opened or refreshed from (logs never carry these). */
export interface ClientContext {
  ip: string | null;
  userAgent: string | null;
}

export interface Lifetimes {
  refreshDays: number;
  idleDays: number;
}

/** A refresh token just issued (in clear once, for the response). */
export interface IssuedRefresh {
  sessionId: string;
  refreshToken: string;
  /** Use-by: the earlier of the token's 30-day expiry and the 7-day idle limit (UTC text). */
  refreshExpiresAt: string;
}

/** A refresh token presented to `POST /v1/auth/refresh`, with its session, locked. */
export interface PresentedRefresh {
  token_id: string;
  session_id: string;
  user_id: string;
  token_used: boolean;
  token_revoked: boolean;
  token_expired: boolean;
  session_revoked: boolean;
  session_idle: boolean;
  user_disabled: boolean;
}

export interface SessionListEntry {
  id: string;
  platform: string | null;
  device_name: string | null;
  created_at: string;
  last_seen_at: string;
  current: boolean;
}

/**
 * `public.device_sessions` and `public.refresh_tokens` (migration 0008): per-device sessions with
 * rotating, single-use refresh tokens stored as SHA-256 digests (API-100-56). The token family of a
 * session is the session itself (`family_id` = session id).
 */
@Injectable()
export class SessionsRepository {
  /** Opens a session on `device` with its first refresh token. */
  async open(
    tx: AuthTx,
    userId: string,
    method: AuthMethod,
    device: DeviceInput,
    client: ClientContext,
    lifetimes: Lifetimes,
    exchangedFrom: string | null = null,
  ): Promise<IssuedRefresh> {
    const refreshToken = newOpaqueToken();
    const row = firstRow<{ session_id: string; expires: string }>(
      await tx.execute(sql`
        with s as (
          insert into public.device_sessions (
            user_id, device_id, installation_id, platform, device_name, app_version, auth_method,
            ip_last, user_agent, exchanged_supabase_session_id)
          values (
            ${userId}::uuid,
            (select d.id from public.user_devices d
              where d.user_id = ${userId}::uuid
                and d.installation_id = ${device.installation_id}::text),
            ${device.installation_id}::text, ${device.platform}, ${device.device_name}::text,
            ${device.app_version}, ${method}, ${client.ip}::inet, ${client.userAgent}::text,
            ${exchangedFrom}::uuid)
          returning id
        ), r as (
          insert into public.refresh_tokens (session_id, token_hash, family_id, expires_at)
          select s.id, ${tokenDigest(refreshToken)}, s.id,
                 now() + make_interval(days => ${lifetimes.refreshDays})
            from s
          returning session_id, expires_at
        )
        select r.session_id::text as session_id,
               to_jsonb(least(r.expires_at,
                              now() + make_interval(days => ${lifetimes.idleDays}))) #>> '{}'
                 as expires
          from r`),
    );
    if (!row) throw new Error('session not created');
    return { sessionId: row.session_id, refreshToken, refreshExpiresAt: row.expires };
  }

  /** Locks the refresh token presented and its session. Undefined when unknown. */
  async lockPresented(
    tx: AuthTx,
    token: string,
    idleDays: number,
  ): Promise<PresentedRefresh | undefined> {
    return firstRow<PresentedRefresh>(
      await tx.execute(sql`
        select rt.id::text as token_id, s.id::text as session_id, s.user_id::text as user_id,
               (rt.used_at is not null) as token_used,
               (rt.revoked_at is not null) as token_revoked,
               (rt.expires_at <= now()) as token_expired,
               (s.revoked_at is not null) as session_revoked,
               (s.last_refreshed_at <= now() - make_interval(days => ${idleDays})) as session_idle,
               (u.disabled_at is not null) as user_disabled
          from public.refresh_tokens rt
          join public.device_sessions s on s.id = rt.session_id
          join public.users u on u.id = s.user_id
         where rt.token_hash = ${tokenDigest(token)}
         for update of rt, s`),
    );
  }

  /** Marks `tokenId` used and issues its successor in the same session (rotation). */
  async rotate(
    tx: AuthTx,
    presented: PresentedRefresh,
    client: ClientContext,
    lifetimes: Lifetimes,
  ): Promise<IssuedRefresh> {
    await tx.execute(sql`
      update public.refresh_tokens set used_at = now() where id = ${presented.token_id}::uuid`);
    await tx.execute(sql`
      update public.device_sessions
         set last_refreshed_at = now(), last_seen_at = now(),
             ip_last = coalesce(${client.ip}::inet, ip_last),
             user_agent = coalesce(${client.userAgent}::text, user_agent)
       where id = ${presented.session_id}::uuid`);
    const refreshToken = newOpaqueToken();
    const row = firstRow<{ expires: string }>(
      await tx.execute(sql`
        insert into public.refresh_tokens (session_id, token_hash, family_id, parent_id, expires_at)
        values (${presented.session_id}::uuid, ${tokenDigest(refreshToken)},
                ${presented.session_id}::uuid, ${presented.token_id}::uuid,
                now() + make_interval(days => ${lifetimes.refreshDays}))
        returning to_jsonb(least(expires_at, now() + make_interval(days => ${lifetimes.idleDays})))
                  #>> '{}' as expires`),
    );
    return {
      sessionId: presented.session_id,
      refreshToken,
      refreshExpiresAt: row!.expires,
    };
  }

  /** Revokes a session and every refresh token of it. False when it was already revoked. */
  async revoke(tx: AuthTx, sessionId: string, reason: RevokeReason): Promise<boolean> {
    const result = await tx.execute(sql`
      update public.device_sessions
         set revoked_at = now(), revoke_reason = ${reason}
       where id = ${sessionId}::uuid and revoked_at is null`);
    await tx.execute(sql`
      update public.refresh_tokens set revoked_at = now()
       where session_id = ${sessionId}::uuid and revoked_at is null`);
    return (result.rowCount ?? 0) > 0;
  }

  /** Revokes every live session of a user, except `keep`. Returns how many. */
  async revokeAllOf(
    tx: AuthTx,
    userId: string,
    reason: RevokeReason,
    keep: string | null = null,
  ): Promise<number> {
    const result = await tx.execute(sql`
      update public.device_sessions
         set revoked_at = now(), revoke_reason = ${reason}
       where user_id = ${userId}::uuid and revoked_at is null
         and id is distinct from ${keep}::uuid`);
    await tx.execute(sql`
      update public.refresh_tokens rt set revoked_at = now()
        from public.device_sessions s
       where s.id = rt.session_id and s.user_id = ${userId}::uuid
         and s.id is distinct from ${keep}::uuid and rt.revoked_at is null`);
    return result.rowCount ?? 0;
  }

  /**
   * A live session of `userId` (locked), for logout / delete. Undefined when unknown, another
   * user's, or already revoked.
   */
  async lockLive(tx: AuthTx, sessionId: string, userId: string): Promise<boolean> {
    const row = firstRow<{ id: string }>(
      await tx.execute(sql`
        select id::text as id from public.device_sessions
         where id = ${sessionId}::uuid and user_id = ${userId}::uuid and revoked_at is null
         for update`),
    );
    return row !== undefined;
  }

  /** Clears the push token of the device of a session (its `device_id` or installation). */
  async clearPushTokenOfSession(tx: AuthTx, sessionId: string): Promise<void> {
    await tx.execute(sql`
      update public.user_devices d
         set push_token = null, push_provider = null, push_token_updated_at = now()
        from public.device_sessions s
       where s.id = ${sessionId}::uuid
         and d.user_id = s.user_id
         and (d.id = s.device_id or d.installation_id = s.installation_id)
         and d.push_token is not null`);
  }

  /** Clears the push token of every device of a user (sign-out everywhere). */
  async clearPushTokensOfUser(tx: AuthTx, userId: string): Promise<void> {
    await tx.execute(sql`
      update public.user_devices
         set push_token = null, push_provider = null, push_token_updated_at = now()
       where user_id = ${userId}::uuid and push_token is not null`);
  }

  /** Live sessions of a user (not revoked, not idle), most recently used first. */
  async listLive(
    tx: AuthTx,
    userId: string,
    currentSessionId: string | null,
    idleDays: number,
  ): Promise<SessionListEntry[]> {
    const result = await tx.execute(sql`
      select id::text as id, platform, device_name,
             to_jsonb(created_at) #>> '{}' as created_at,
             to_jsonb(last_seen_at) #>> '{}' as last_seen_at,
             (id = ${currentSessionId}::uuid) is true as current
        from public.device_sessions
       where user_id = ${userId}::uuid and revoked_at is null
         and last_refreshed_at > now() - make_interval(days => ${idleDays})
       order by last_seen_at desc, created_at desc, id`);
    return result.rows as unknown as SessionListEntry[];
  }
}
