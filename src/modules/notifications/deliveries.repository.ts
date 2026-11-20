import { Injectable } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';

import { DatabaseService } from '../../db/database.service';
import type { Channel, SendErrorCode } from './channels/channel.types';

/** Why a delivery was not attempted (`status = 'skipped'`). */
export const SKIP_REASONS = [
  'channel_disabled',
  'no_device',
  'no_address',
  'not_eligible',
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export type DeliveryStatus = 'queued' | 'sent' | 'delivered' | 'failed' | 'skipped';

/** A recipient of an outbox row. `eligible: false` records one `not_eligible` row per channel. */
export interface DeliveryRecipient {
  user_id: string;
  eligible: boolean;
}

/** What the sender needs for one delivery. The token and addresses never leave the worker. */
export interface DeliveryToSend extends Record<string, unknown> {
  id: string;
  status: DeliveryStatus;
  channel: Channel;
  device_id: string | null;
  topic: string;
  payload: Record<string, unknown>;
  push_provider: 'fcm' | 'apns' | null;
  push_token: string | null;
  phone: string | null;
  email: string | null;
}

/**
 * `public.notification_deliveries` (migration 0007, spec §11.7). Every status write is guarded by
 * `status = 'queued'`, so a repeated job can never overwrite a final outcome.
 */
@Injectable()
export class DeliveriesRepository {
  constructor(private readonly database: DatabaseService) {}

  /**
   * One write in its own transaction with `synchronous_commit = off` (D25): the worker's bookkeeping
   * does not wait for its WAL flush, so a burst of deliveries does not compete with the SOS writes
   * for commit flushes. A crash can lose the last few status updates; the job is then retried
   * (BullMQ stalled-job recovery) and finds its row still `queued`: at worst one repeated push
   * (at-least-once). Domain writes (incidents, the outbox) keep the default.
   */
  private write(statement: SQL): Promise<unknown> {
    return this.database.db.transaction(async (tx) => {
      await tx.execute(sql`set local synchronous_commit = off`);
      return tx.execute(statement);
    });
  }

  /**
   * Fan-out of one outbox row (API-100-47 AC2): one row per recipient x channel x device.
   * - push: one row per device of the recipient with a push token (not revoked); none → one
   *   `skipped` row `no_device`.
   * - sms / email: one row per recipient; no phone / email on the account → `skipped` `no_address`.
   * - a disabled channel → every row of it `skipped` `channel_disabled` (no adapter is called).
   * - a recipient who is no longer eligible → one `skipped` row `not_eligible` per channel.
   * `preferences` records the recipient's `alert_*_enabled` flags (recorded, not enforced, D4).
   * Idempotent (`on conflict do nothing`, unique per outbox, recipient, channel and device).
   */
  async fanOut(input: {
    outboxId: string;
    incidentId: string | null;
    recipients: readonly DeliveryRecipient[];
    channels: readonly Channel[];
    enabled: Readonly<Record<Channel, boolean>>;
  }): Promise<void> {
    if (input.recipients.length === 0 || input.channels.length === 0) return;
    await this.write(sql`
      with recipients as (
        select distinct on (r.user_id) r.user_id, r.eligible
          from jsonb_to_recordset(${JSON.stringify(input.recipients)}::jsonb)
                 as r(user_id uuid, eligible boolean)
         order by r.user_id, r.eligible desc
      ),
      channels as (
        select c.channel
          from jsonb_array_elements_text(${JSON.stringify(input.channels)}::jsonb) as c(channel)
      ),
      enabled as (
        select ${input.enabled.push}::boolean as push,
               ${input.enabled.sms}::boolean as sms,
               ${input.enabled.email}::boolean as email
      ),
      people as (
        select r.user_id,
               r.eligible,
               coalesce(
                 jsonb_build_object(
                   'alert_push_enabled', p.alert_push_enabled,
                   'alert_sms_enabled', p.alert_sms_enabled,
                   'alert_email_enabled', p.alert_email_enabled
                 ),
                 '{}'::jsonb
               ) as preferences,
               nullif(btrim(u.phone), '') is not null as has_phone,
               nullif(btrim(u.email), '') is not null as has_email
          from recipients r
          left join public.profiles p on p.id = r.user_id
          left join auth.users u on u.id = r.user_id
      ),
      devices as (
        select d.user_id, d.id
          from public.user_devices d
          join people pe on pe.user_id = d.user_id and pe.eligible
         where d.push_token is not null
           and d.revoked_at is null
      ),
      targets as (
        -- push, one row per device
        select pe.user_id, 'push'::text as channel, dv.id as device_id,
               case when not e.push then 'channel_disabled' end as skip, pe.preferences
          from people pe
          join devices dv on dv.user_id = pe.user_id
          cross join enabled e
         where pe.eligible and exists (select 1 from channels c where c.channel = 'push')
        union all
        -- push, no device
        select pe.user_id, 'push', null,
               case when not e.push then 'channel_disabled' else 'no_device' end, pe.preferences
          from people pe
          cross join enabled e
         where pe.eligible
           and exists (select 1 from channels c where c.channel = 'push')
           and not exists (select 1 from devices dv where dv.user_id = pe.user_id)
        union all
        -- sms
        select pe.user_id, 'sms', null,
               case when not e.sms then 'channel_disabled'
                    when not pe.has_phone then 'no_address' end,
               pe.preferences
          from people pe
          cross join enabled e
         where pe.eligible and exists (select 1 from channels c where c.channel = 'sms')
        union all
        -- email
        select pe.user_id, 'email', null,
               case when not e.email then 'channel_disabled'
                    when not pe.has_email then 'no_address' end,
               pe.preferences
          from people pe
          cross join enabled e
         where pe.eligible and exists (select 1 from channels c where c.channel = 'email')
        union all
        -- no longer eligible: one row per channel
        select pe.user_id, c.channel, null, 'not_eligible', pe.preferences
          from people pe
          cross join channels c
         where not pe.eligible
      )
      insert into public.notification_deliveries (
        outbox_id, incident_id, recipient_user_id, channel, device_id, status, error_code,
        preferences
      )
      select ${input.outboxId}::uuid, ${input.incidentId}::uuid, t.user_id, t.channel, t.device_id,
             case when t.skip is null then 'queued' else 'skipped' end, t.skip, t.preferences
        from targets t
      on conflict do nothing`);
  }

  /** The `queued` rows of an outbox row (after fan-out; also those of an earlier partial run). */
  async queuedIds(outboxId: string): Promise<{ id: string; channel: Channel }[]> {
    const result = await this.database.db.execute<{ id: string; channel: Channel }>(sql`
      select d.id::text as id, d.channel
        from public.notification_deliveries d
       where d.outbox_id = ${outboxId}::uuid
         and d.status = 'queued'
       order by d.queued_at, d.id`);
    return result.rows;
  }

  async loadForSend(id: string): Promise<DeliveryToSend | undefined> {
    const result = await this.database.db.execute<DeliveryToSend>(sql`
      select d.id::text as id, d.status, d.channel, d.device_id::text as device_id,
             o.topic, o.payload,
             case when dv.revoked_at is null then dv.push_provider end as push_provider,
             case when dv.revoked_at is null then dv.push_token end as push_token,
             nullif(btrim(u.phone), '') as phone,
             nullif(btrim(u.email), '') as email
        from public.notification_deliveries d
        join public.notification_outbox o on o.id = d.outbox_id
        left join public.user_devices dv on dv.id = d.device_id
        left join auth.users u on u.id = d.recipient_user_id
       where d.id = ${id}::uuid`);
    return result.rows[0];
  }

  /** `sent` / `delivered` with the provider's message id. */
  async markSent(
    id: string,
    status: 'sent' | 'delivered',
    providerMessageId: string | null,
  ): Promise<void> {
    await this.write(sql`
      update public.notification_deliveries
         set status = ${status}::text,
             provider_message_id = ${providerMessageId}::text,
             error_code = null,
             attempts = attempts + 1,
             sent_at = now(),
             updated_at = now()
       where id = ${id}::uuid
         and status = 'queued'`);
  }

  /** A failed attempt. `final` writes `failed`; otherwise the row stays `queued` (to be retried). */
  async recordFailure(id: string, errorCode: SendErrorCode, final: boolean): Promise<void> {
    await this.write(sql`
      update public.notification_deliveries
         set status = case when ${final}::boolean then 'failed' else 'queued' end,
             error_code = ${errorCode}::text,
             attempts = attempts + 1,
             updated_at = now()
       where id = ${id}::uuid
         and status = 'queued'`);
  }

  async markSkipped(id: string, reason: SkipReason): Promise<void> {
    await this.write(sql`
      update public.notification_deliveries
         set status = 'skipped',
             error_code = ${reason}::text,
             updated_at = now()
       where id = ${id}::uuid
         and status = 'queued'`);
  }

  /**
   * AC4: the provider says the token is no longer valid. Cleared only while the device still holds
   * the token that failed (a token re-registered since is kept).
   */
  async clearPushToken(deviceId: string, token: string): Promise<void> {
    await this.write(sql`
      update public.user_devices
         set push_token = null,
             push_provider = null,
             push_token_updated_at = now()
       where id = ${deviceId}::uuid
         and push_token = ${token}::text`);
  }
}
