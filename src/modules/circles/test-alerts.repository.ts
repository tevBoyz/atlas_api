import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import type { Database } from '../../db';
import type { TestAlertRateSettings } from './test-alert-settings';
import type { RecipientDeliveryCounts } from './test-alert-status';

/** A transaction of the test-alert writes and reads (UTC, set by the service). */
export type TestAlertTransaction = Pick<Database, 'execute'>;

/** The owner's circle, locked for the send. */
export interface OwnerCircle {
  circle_id: string;
  /** The owner's profile name, trimmed; null when blank. */
  owner_name: string | null;
}

/** The send rate-limit verdict (D66). */
export interface RateVerdict {
  limited: boolean;
  reason: 'interval' | 'daily_limit' | null;
  /** When the next test is allowed (UTC JSON text), null when not limited. */
  next_allowed_at: string | null;
  retry_after_seconds: number;
}

/** A stored test alert, as `POST /v1/me/circle/test-alerts` answers it. */
export interface SentTestAlert {
  id: string;
  created_at: string;
  recipient_count: number;
}

/** The owner's view of one test alert, before the per-member states are derived. */
export interface OwnerTestAlertRow {
  id: string;
  circle_id: string;
  created_at: string;
  recipient_count: number;
  recipients: (RecipientDeliveryCounts & {
    /** D79: the recipient's member row id in the test's circle (never a user id). */
    handle: string | null;
    display_name: string | null;
    delivered_at: string | null;
  })[];
}

/** A recipient's view of a test alert. */
export interface MemberTestAlertRow {
  id: string;
  owner_name: string | null;
  created_at: string;
  seen_at: string | null;
}

/**
 * `circle_test_alerts` and `circle_test_alert_receipts` (migration 0018, SCRUM-35). Every read and
 * write runs inside the service's transaction (TimeZone UTC, so JSON times end in `+00:00`). Nothing
 * here reads or writes an incident table.
 */
@Injectable()
export class TestAlertsRepository {
  /**
   * The caller's own circle, its row locked `FOR UPDATE` so two sends of the same owner run one
   * after the other (the rate limit counts the first one's row). Undefined when the caller owns no
   * circle.
   */
  async lockOwnerCircle(
    tx: TestAlertTransaction,
    ownerId: string,
  ): Promise<OwnerCircle | undefined> {
    const result = await tx.execute<OwnerCircle & Record<string, unknown>>(sql`
      select c.id::text as circle_id, nullif(btrim(p.full_name), '') as owner_name
        from public.safety_circles c
        left join public.profiles p on p.id = c.owner_id
       where c.owner_id = ${ownerId}::uuid
         for update of c`);
    return result.rows[0];
  }

  /**
   * D66 recipients: the circle's ACTIVE members with an account, the owner excluded. Never a
   * pending, declined, removed or left row.
   */
  async activeRecipients(tx: TestAlertTransaction, circleId: string): Promise<string[]> {
    const result = await tx.execute<{ user_id: string }>(sql`
      select distinct m.user_id::text as user_id
        from public.safety_circle_members m
       where m.circle_id = ${circleId}::uuid
         and m.role = 'member'
         and m.status = 'active'
         and m.user_id is not null
       order by 1`);
    return result.rows.map((row) => row.user_id);
  }

  /**
   * D66 rate limit of one owner: at most one test per `min_interval_minutes` and at most `daily_max`
   * in any 24 hours (rolling). `next_allowed_at` is the later of the two limits.
   */
  async rateVerdict(
    tx: TestAlertTransaction,
    ownerId: string,
    settings: TestAlertRateSettings,
  ): Promise<RateVerdict> {
    const result = await tx.execute<{
      next_allowed_at: string | null;
      retry_after_seconds: number | null;
      daily: boolean;
    }>(sql`
      with mine as (
        select t.created_at
          from public.circle_test_alerts t
         where t.owner_id = ${ownerId}::uuid
           and t.created_at > now() - interval '24 hours'
      ),
      limits as (
        select (select max(created_at) from mine)
                 + make_interval(mins => ${settings.min_interval_minutes}::integer) as by_interval,
               case when (select count(*) from mine) >= ${settings.daily_max}::integer
                    then (select created_at from mine order by created_at desc
                           offset ${settings.daily_max - 1}::integer limit 1)
                         + interval '24 hours'
               end as by_daily
      ),
      verdict as (
        select greatest(l.by_interval, l.by_daily) as next_at,
               l.by_daily is not null and l.by_daily > now() as daily
          from limits l
      )
      select case when v.next_at > now()
                  then jsonb_build_object('t', v.next_at) ->> 't' end as next_allowed_at,
             case when v.next_at > now()
                  then ceil(extract(epoch from (v.next_at - now())))::integer end
               as retry_after_seconds,
             v.daily
        from verdict v`);
    const row = result.rows[0];
    if (!row.next_allowed_at) {
      return { limited: false, reason: null, next_allowed_at: null, retry_after_seconds: 0 };
    }
    return {
      limited: true,
      reason: row.daily ? 'daily_limit' : 'interval',
      next_allowed_at: row.next_allowed_at,
      retry_after_seconds: Math.max(1, row.retry_after_seconds ?? 1),
    };
  }

  /** Stores the test alert and one receipt per recipient. */
  async insert(
    tx: TestAlertTransaction,
    input: { circleId: string; ownerId: string; recipients: readonly string[] },
  ): Promise<SentTestAlert> {
    const result = await tx.execute<SentTestAlert & Record<string, unknown>>(sql`
      insert into public.circle_test_alerts (circle_id, owner_id, recipient_count)
      values (${input.circleId}::uuid, ${input.ownerId}::uuid, ${input.recipients.length}::integer)
      returning id::text as id,
                jsonb_build_object('t', created_at) ->> 't' as created_at,
                recipient_count`);
    const sent = result.rows[0];
    await tx.execute(sql`
      insert into public.circle_test_alert_receipts (test_alert_id, member_user_id)
      select ${sent.id}::uuid, r.value::uuid
        from jsonb_array_elements_text(${JSON.stringify(input.recipients)}::jsonb) as r`);
    return { id: sent.id, created_at: sent.created_at, recipient_count: sent.recipient_count };
  }

  /** The owner's latest test alert id (D68: only the latest is shown), or undefined. */
  async latestId(tx: TestAlertTransaction, ownerId: string): Promise<string | undefined> {
    const result = await tx.execute<{ id: string }>(sql`
      select t.id::text as id
        from public.circle_test_alerts t
       where t.owner_id = ${ownerId}::uuid
       order by t.created_at desc, t.id desc
       limit 1`);
    return result.rows[0]?.id;
  }

  /**
   * The owner's view of one of their test alerts with each recipient's delivery counts (D68).
   * Undefined when the id is not a test of this owner.
   */
  async ownerView(
    tx: TestAlertTransaction,
    ownerId: string,
    testAlertId: string,
  ): Promise<OwnerTestAlertRow | undefined> {
    const result = await tx.execute<{ view: OwnerTestAlertRow }>(sql`
      select jsonb_build_object(
               'id', t.id,
               'circle_id', t.circle_id,
               'created_at', t.created_at,
               'recipient_count', t.recipient_count,
               'recipients', coalesce((
                 select jsonb_agg(to_jsonb(per) - 'user_id'
                                  order by lower(coalesce(per.display_name, '')), per.user_id)
                   from (
                     select r.member_user_id as user_id,
                            (select hm.id
                               from public.safety_circle_members hm
                              where hm.circle_id = t.circle_id
                                and hm.user_id = r.member_user_id
                              order by (hm.status = 'active') desc, hm.updated_at desc
                              limit 1) as handle,
                            r.seen_at,
                            coalesce(
                              nullif(btrim(p.full_name), ''),
                              (select m.display_name
                                 from public.safety_circle_members m
                                where m.circle_id = t.circle_id
                                  and m.user_id = r.member_user_id
                                order by (m.status = 'active') desc, m.updated_at desc
                                limit 1)
                            ) as display_name,
                            count(d.id)::integer as rows,
                            (count(d.id) filter (where d.status in ('sent', 'delivered')))::integer
                              as accepted,
                            min(d.sent_at) filter (where d.status in ('sent', 'delivered'))
                              as delivered_at,
                            (count(d.id) filter (where d.status = 'queued'))::integer as queued,
                            coalesce(bool_or(d.status = 'failed'
                              and d.error_code not in ('unregistered', 'invalid_recipient')), false)
                              as provider_error,
                            coalesce(bool_or(d.status = 'failed'
                              and d.error_code in ('unregistered', 'invalid_recipient')), false)
                              as invalid_token,
                            coalesce(bool_or(d.status = 'skipped'
                              and d.error_code in ('no_device', 'no_address')), false) as no_device,
                            coalesce(bool_or(d.status = 'skipped'
                              and d.error_code = 'channel_disabled'), false) as channel_disabled,
                            coalesce(bool_or(d.status = 'skipped'
                              and d.error_code = 'not_eligible'), false) as not_eligible
                       from public.circle_test_alert_receipts r
                       left join public.profiles p on p.id = r.member_user_id
                       left join public.notification_deliveries d
                              on d.test_alert_id = r.test_alert_id
                             and d.recipient_user_id = r.member_user_id
                             and d.channel = 'push'
                      where r.test_alert_id = t.id
                      group by r.member_user_id, r.seen_at, p.full_name
                   ) per
               ), '[]'::jsonb)
             ) as view
        from public.circle_test_alerts t
       where t.id = ${testAlertId}::uuid
         and t.owner_id = ${ownerId}::uuid`);
    return result.rows[0]?.view;
  }

  /**
   * A recipient's view of a test alert: the caller has a receipt AND is still an active member of
   * the test's circle. Anyone else (owner, pending, removed, left, outsider, unknown id) gets none.
   */
  async memberView(
    tx: TestAlertTransaction,
    memberId: string,
    testAlertId: string,
  ): Promise<MemberTestAlertRow | undefined> {
    const result = await tx.execute<{ view: MemberTestAlertRow }>(sql`
      select jsonb_build_object(
               'id', t.id,
               'owner_name', nullif(btrim(p.full_name), ''),
               'created_at', t.created_at,
               'seen_at', r.seen_at
             ) as view
        from public.circle_test_alerts t
        join public.circle_test_alert_receipts r
          on r.test_alert_id = t.id
         and r.member_user_id = ${memberId}::uuid
        left join public.profiles p on p.id = t.owner_id
       where t.id = ${testAlertId}::uuid
         and ${memberStillActive(memberId)}`);
    return result.rows[0]?.view;
  }

  /** Sets `seen_at` once (a repeat keeps the first time). True when the caller is a recipient. */
  async markSeen(tx: TestAlertTransaction, memberId: string, testAlertId: string): Promise<void> {
    await tx.execute(sql`
      update public.circle_test_alert_receipts r
         set seen_at = now()
        from public.circle_test_alerts t
       where r.test_alert_id = ${testAlertId}::uuid
         and r.member_user_id = ${memberId}::uuid
         and r.seen_at is null
         and t.id = r.test_alert_id
         and ${memberStillActive(memberId)}`);
  }
}

/** `t` (the test alert) belongs to a circle where the member is still an active member. */
function memberStillActive(memberId: string) {
  return sql`exists (
    select 1 from public.safety_circle_members m
     where m.circle_id = t.circle_id
       and m.user_id = ${memberId}::uuid
       and m.role = 'member'
       and m.status = 'active')`;
}
