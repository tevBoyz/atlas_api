import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import type { Database } from '../../db';
import { type DeviceRegistration, pushTokenHash } from './device-input';

/** The open transaction of a device write. */
export type DeviceTransaction = Pick<Database, 'execute'>;

/**
 * Advisory-lock namespace of push-token moves (`pg_advisory_xact_lock(ns, hashtext(token))`): two
 * registrations of one token run one after the other, so the move never meets the unique index.
 */
const PUSH_TOKEN_LOCK_NAMESPACE = 4401;

/**
 * `public.user_devices` (migration 0005, spec §11.7). Push tokens only ever travel as query
 * parameters of these statements; errors that could carry them are replaced by the service.
 */
@Injectable()
export class DevicesRepository {
  /**
   * U1: upsert on `(user_id, installation_id)`, `last_seen_at = now()`. With a token, the token is
   * first cleared from any other row (of any user) holding it. `push` undefined keeps the stored
   * token; null clears it.
   *
   * D69 (gap 49): this row is locked first; a token whose SHA-256 equals the row's
   * `push_token_invalid_hash` (the provider answered `unregistered` for it) is refused: nothing about
   * the token changes (the row keeps no token). Storing any other token clears the hash. Returns the
   * row id, whether the token was refused and whether a token is stored now.
   */
  async register(
    tx: DeviceTransaction,
    userId: string,
    installationId: string,
    input: DeviceRegistration,
  ): Promise<{ id: string; refused: boolean; stored: boolean }> {
    let push = input.push;
    let refused = false;
    if (push) {
      // The row lock orders this write after a concurrent `unregistered` clear of the same row.
      const current = await tx.execute<{ push_token_invalid_hash: string | null }>(sql`
        select push_token_invalid_hash
          from public.user_devices
         where user_id = ${userId}::uuid and installation_id = ${installationId}::text
         for update`);
      const deadHash = current.rows[0]?.push_token_invalid_hash ?? null;
      if (deadHash !== null && deadHash === pushTokenHash(push.token)) {
        refused = true;
        push = undefined;
      }
    }
    if (push) {
      await tx.execute(sql`
        select pg_advisory_xact_lock(${PUSH_TOKEN_LOCK_NAMESPACE}::int, hashtext(${push.token}::text))`);
      await tx.execute(sql`
        update public.user_devices
           set push_token = null,
               push_provider = null,
               push_token_updated_at = now()
         where push_token = ${push.token}::text
           and not (user_id = ${userId}::uuid and installation_id = ${installationId}::text)`);
    }
    const given = push !== undefined;
    const provider = push?.provider ?? null;
    const token = push?.token ?? null;
    // [TZ]: left out keeps the stored zone.
    const zoneGiven = input.time_zone !== undefined;
    const zone = input.time_zone ?? null;
    const result = await tx.execute<{ id: string; stored: boolean }>(sql`
      insert into public.user_devices as d (
        user_id, installation_id, platform, app_version,
        push_provider, push_token, push_token_updated_at, last_seen_at, time_zone
      )
      values (
        ${userId}::uuid, ${installationId}::text, ${input.platform}::text, ${input.app_version}::text,
        ${provider}::text, ${token}::text,
        case when ${token}::text is not null then now() end,
        now(), ${zone}::text
      )
      on conflict (user_id, installation_id) do update
         set platform = excluded.platform,
             app_version = excluded.app_version,
             last_seen_at = now(),
             revoked_at = null,
             time_zone = case when ${zoneGiven}::boolean then excluded.time_zone
                              else d.time_zone end,
             push_provider = case when ${given}::boolean then excluded.push_provider
                                  else d.push_provider end,
             push_token = case when ${given}::boolean then excluded.push_token
                               else d.push_token end,
             push_token_updated_at =
               case when ${given}::boolean
                         and (d.push_token is distinct from excluded.push_token
                              or d.push_provider is distinct from excluded.push_provider)
                    then now()
                    else d.push_token_updated_at end,
             push_token_invalid_hash =
               case when ${token}::text is not null then null
                    else d.push_token_invalid_hash end
      returning d.id::text as id, d.push_token is not null as stored`);
    const row = result.rows[0];
    return { id: row.id, refused, stored: row.stored };
  }

  /**
   * Links the caller's own-auth session (API-100-56) to this device row, so signing out of that
   * session clears this device's push token. Nothing for a Supabase token (no session row).
   */
  async linkSession(
    tx: DeviceTransaction,
    userId: string,
    sessionId: string,
    deviceId: string,
  ): Promise<void> {
    await tx.execute(sql`
      update public.device_sessions
         set device_id = ${deviceId}::uuid
       where id = ${sessionId}::uuid and user_id = ${userId}::uuid
         and device_id is distinct from ${deviceId}::uuid`);
  }

  /** U2: clears the token of the caller's installation. False when there was none to clear. */
  async clearPushToken(
    tx: DeviceTransaction,
    userId: string,
    installationId: string,
  ): Promise<boolean> {
    const result = await tx.execute(sql`
      update public.user_devices
         set push_token = null,
             push_provider = null,
             push_token_updated_at = now()
       where user_id = ${userId}::uuid
         and installation_id = ${installationId}::text
         and push_token is not null`);
    return (result.rowCount ?? 0) > 0;
  }
}
