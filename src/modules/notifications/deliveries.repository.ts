import { Injectable } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';

import { callerPhoneSql } from '../../common/policies';
import { DatabaseService } from '../../db/database.service';
import { AuditService, type AuditTransaction } from '../audit';
import type { Channel, SendErrorCode } from './channels/channel.types';
import { type DeliveryFinalRow, deliveryOutcomeAudit, finalOutcomeOf } from './delivery-audit';
import { pushTokenHash } from './device-input';

/**
 * The columns of a {@link DeliveryFinalRow}, returned by the status writes: the outcome
 * ({@link DeliveryFinalOutcome}) plus the incident and the outbox topic of the row (SCRUM-74 audit).
 */
const FINAL_RETURNING = sql`returning id::text as delivery_id,
                                      recipient_user_id::text as recipient_user_id, channel,
                                      status, error_code, attempts,
                                      incident_id::text as incident_id,
                                      (select o.topic
                                         from public.notification_outbox o
                                        where o.id = notification_deliveries.outbox_id) as topic`;

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

/**
 * SCRUM-67 (D73): a row that reached its final state (`sent` / `delivered` / `failed` / `skipped`),
 * as the worker logs it. Ids, codes and counts only: never a token, address, phone or email.
 */
export interface DeliveryFinalOutcome extends Record<string, unknown> {
  delivery_id: string;
  recipient_user_id: string;
  channel: Channel;
  status: Exclude<DeliveryStatus, 'queued'>;
  error_code: string | null;
  attempts: number;
}

/** What the sender needs for one delivery. The token and addresses never leave the worker. */
export interface DeliveryToSend extends Record<string, unknown> {
  id: string;
  status: DeliveryStatus;
  channel: Channel;
  /** The incident of the row (null for a test alert). */
  incident_id: string | null;
  recipient_user_id: string;
  device_id: string | null;
  topic: string;
  payload: Record<string, unknown>;
  push_provider: 'fcm' | 'apns' | null;
  push_token: string | null;
  phone: string | null;
  email: string | null;
  /** The recipient's `profiles.timezone` (D54: the time in the push text). */
  time_zone: string | null;
}

/**
 * `public.notification_deliveries` (migration 0007, spec §11.7). Every status write is guarded by
 * `status = 'queued'`, so a repeated job can never overwrite a final outcome.
 *
 * SCRUM-74 (D75): a row of an alert notice of an incident that becomes final gets its
 * `incident.delivery_outcome` audit row in the SAME transaction as that final status write
 * ({@link deliveryOutcomeAudit}): both commit or neither, and a repeated write (no longer `queued`,
 * or a fan-out row that already exists) returns no row, so there is exactly one audit row per row.
 */
@Injectable()
export class DeliveriesRepository {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  /**
   * One write in its own transaction with `synchronous_commit = off` (D25): the worker's bookkeeping
   * does not wait for its WAL flush, so a burst of deliveries does not compete with the SOS writes
   * for commit flushes. A crash can lose the last few status updates; the job is then retried
   * (BullMQ stalled-job recovery) and finds its row still `queued`: at worst one repeated push
   * (at-least-once). Domain writes (incidents, the outbox) keep the default.
   */
  private write<T extends Record<string, unknown> = Record<string, unknown>>(
    statement: SQL,
  ): Promise<T[]> {
    return this.database.db.transaction(async (tx) => {
      await tx.execute(sql`set local synchronous_commit = off`);
      return (await tx.execute<T>(statement)).rows as T[];
    });
  }

  /**
   * {@link write} of a statement returning {@link FINAL_RETURNING}: in the same transaction, one
   * `incident.delivery_outcome` audit row per returned row that is final and belongs to an alert
   * notice of an incident (SCRUM-74). Returns the rows as outcomes (without incident and topic).
   */
  private writeFinal(statement: SQL): Promise<DeliveryFinalOutcome[]> {
    return this.database.db.transaction(async (tx) => {
      await tx.execute(sql`set local synchronous_commit = off`);
      const rows = (await tx.execute<DeliveryFinalRow>(statement)).rows;
      await this.auditFinal(tx, rows);
      return rows.map(finalOutcomeOf);
    });
  }

  private async auditFinal(tx: AuditTransaction, rows: readonly DeliveryFinalRow[]): Promise<void> {
    for (const row of rows) {
      // The fan-out also returns the new rows it queued: not final yet.
      if ((row.status as string) === 'queued') continue;
      const entry = deliveryOutcomeAudit(row);
      if (entry) await this.audit.record(entry, tx);
    }
  }

  /**
   * Fan-out of one outbox row (API-100-47 AC2): one row per recipient x channel x device.
   * - push: one row per device of the recipient with a push token (not revoked); none → one
   *   `skipped` row `no_device`.
   * - sms / email: one row per recipient; no phone / email on the account → `skipped` `no_address`.
   *   The phone is the account's confirmed phone and the email the account's email, both from
   *   `public.users` (D47, D76; gap 21).
   * - a disabled channel → every row of it `skipped` `channel_disabled` (no adapter is called).
   * - a recipient who is no longer eligible → one `skipped` row `not_eligible` per channel.
   * `preferences` records the recipient's `alert_*_enabled` flags (recorded, not enforced, D4).
   * Idempotent (`on conflict do nothing`, unique per outbox, recipient, channel and device).
   * A `skipped` row is final at once (`final_at` = now, SCRUM-67); returns the skipped rows THIS call
   * inserted (a repeated run returns none), for the outcome log.
   */
  async fanOut(input: {
    outboxId: string;
    incidentId: string | null;
    /** SCRUM-35: the test alert of the rows (never together with `incidentId`). */
    testAlertId?: string | null;
    recipients: readonly DeliveryRecipient[];
    channels: readonly Channel[];
    enabled: Readonly<Record<Channel, boolean>>;
  }): Promise<DeliveryFinalOutcome[]> {
    if (input.recipients.length === 0 || input.channels.length === 0) return [];
    const inserted = await this.writeFinal(sql`
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
               nullif(btrim(${callerPhoneSql(sql`r.user_id`)}), '') is not null as has_phone,
               nullif(btrim(u.email::text), '') is not null as has_email
          from recipients r
          left join public.profiles p on p.id = r.user_id
          left join public.users u on u.id = r.user_id
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
        outbox_id, incident_id, test_alert_id, recipient_user_id, channel, device_id, status,
        error_code, preferences, final_at
      )
      select ${input.outboxId}::uuid, ${input.incidentId}::uuid,
             ${input.testAlertId ?? null}::uuid, t.user_id, t.channel, t.device_id,
             case when t.skip is null then 'queued' else 'skipped' end, t.skip, t.preferences,
             case when t.skip is not null then now() end
        from targets t
      on conflict do nothing
      ${FINAL_RETURNING}`);
    return inserted.filter((row) => row.status === 'skipped');
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
             d.incident_id::text as incident_id, d.recipient_user_id::text as recipient_user_id,
             o.topic, o.payload,
             case when dv.revoked_at is null then dv.push_provider end as push_provider,
             case when dv.revoked_at is null then dv.push_token end as push_token,
             nullif(btrim(${callerPhoneSql(sql`d.recipient_user_id`)}), '') as phone,
             nullif(btrim(u.email::text), '') as email,
             p.timezone as time_zone
        from public.notification_deliveries d
        join public.notification_outbox o on o.id = d.outbox_id
        left join public.user_devices dv on dv.id = d.device_id
        left join public.users u on u.id = d.recipient_user_id
        left join public.profiles p on p.id = d.recipient_user_id
       where d.id = ${id}::uuid`);
    return result.rows[0];
  }

  /**
   * `sent` / `delivered` with the provider's message id; `final_at` = `sent_at` (SCRUM-67). Returns
   * the final row, or undefined when it was not `queued` any more (nothing written).
   */
  async markSent(
    id: string,
    status: 'sent' | 'delivered',
    providerMessageId: string | null,
  ): Promise<DeliveryFinalOutcome | undefined> {
    const rows = await this.writeFinal(sql`
      update public.notification_deliveries
         set status = ${status}::text,
             provider_message_id = ${providerMessageId}::text,
             error_code = null,
             attempts = attempts + 1,
             sent_at = now(),
             final_at = now(),
             updated_at = now()
       where id = ${id}::uuid
         and status = 'queued'
      ${FINAL_RETURNING}`);
    return rows[0];
  }

  /**
   * A failed attempt. `final` writes `failed` with `final_at` = now (SCRUM-67); otherwise the row
   * stays `queued` (to be retried). Returns the row when it became final now.
   */
  async recordFailure(
    id: string,
    errorCode: SendErrorCode,
    final: boolean,
  ): Promise<DeliveryFinalOutcome | undefined> {
    const rows = await this.writeFinal(sql`
      update public.notification_deliveries
         set status = case when ${final}::boolean then 'failed' else 'queued' end,
             error_code = ${errorCode}::text,
             attempts = attempts + 1,
             final_at = case when ${final}::boolean then now() end,
             updated_at = now()
       where id = ${id}::uuid
         and status = 'queued'
      ${FINAL_RETURNING}`);
    return rows.find((row) => row.status === 'failed');
  }

  /** `skipped` with its reason and `final_at` = now (SCRUM-67); the row, when written now. */
  async markSkipped(id: string, reason: SkipReason): Promise<DeliveryFinalOutcome | undefined> {
    const rows = await this.writeFinal(sql`
      update public.notification_deliveries
         set status = 'skipped',
             error_code = ${reason}::text,
             final_at = now(),
             updated_at = now()
       where id = ${id}::uuid
         and status = 'queued'
      ${FINAL_RETURNING}`);
    return rows[0];
  }

  /**
   * AC4: the provider says the token is no longer valid. Cleared only while the device still holds
   * the token that failed (a token re-registered since is kept). D69 (gap 49): the same statement
   * keeps the token's SHA-256 in `push_token_invalid_hash` (never the token), so U1 can refuse it.
   */
  async clearPushToken(deviceId: string, token: string): Promise<void> {
    await this.write(sql`
      update public.user_devices
         set push_token = null,
             push_provider = null,
             push_token_updated_at = now(),
             push_token_invalid_hash = ${pushTokenHash(token)}::text
       where id = ${deviceId}::uuid
         and push_token = ${token}::text`);
  }
}
