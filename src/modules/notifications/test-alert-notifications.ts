import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DatabaseService } from '../../db/database.service';
import type { OutboxTopicHandler } from '../../jobs/job-workers';
import type { OutboxRow } from '../../jobs/outbox';
import { type Channel, TEST_ALERT_TOPIC } from './channels/channel.types';
import { DeliveryPlanner } from './deliveries.service';

/**
 * The channels of a test alert (SCRUM-35, D67, plan assumption 2): push only. SMS is on hold
 * (Twilio) and email has no sending domain yet; the in-app part is the `circle.test_alert` socket
 * event the API sends at once.
 */
export const TEST_ALERT_CHANNELS: readonly Channel[] = ['push'];

/**
 * Worker side of a test alert (SCRUM-35, D67): the `circle.test_alert` outbox row becomes one
 * `notification_deliveries` row per recipient x device, each pointing at the test alert
 * (`test_alert_id`; `incident_id` stays null: a test is never an incident). Each recipient is
 * checked again at fan-out time: still an ACTIVE (non-owner) member of the test's circle; one who is
 * not (removed or left in the meantime) is recorded `skipped` `not_eligible`. Preferences are recorded
 * on the rows but not enforced (as an SOS, D4: the test checks that a real alert would arrive). A
 * test alert that no longer exists (its circle was deleted) produces no rows.
 */
@Injectable()
export class TestAlertNotificationsHandler implements OutboxTopicHandler {
  readonly topics = [TEST_ALERT_TOPIC] as const;

  constructor(
    private readonly database: DatabaseService,
    private readonly planner: DeliveryPlanner,
  ) {}

  async handle(row: OutboxRow): Promise<void> {
    const testAlertId = row.aggregate_id;
    const raw = row.payload.recipient_user_ids;
    const recipients = Array.isArray(raw)
      ? raw.filter((id): id is string => typeof id === 'string')
      : [];
    if (!testAlertId || recipients.length === 0) return;

    const result = await this.database.db.execute<{ user_id: string; eligible: boolean }>(sql`
      select r.user_id::text as user_id,
             exists (
               select 1
                 from public.circle_test_alerts t
                 join public.safety_circle_members m on m.circle_id = t.circle_id
                where t.id = ${testAlertId}::uuid
                  and m.user_id = r.user_id
                  and m.role = 'member'
                  and m.status = 'active'
             ) as eligible
        from (select distinct value::uuid as user_id
                from jsonb_array_elements_text(${JSON.stringify(recipients)}::jsonb)) as r
       where exists (select 1 from public.circle_test_alerts t where t.id = ${testAlertId}::uuid)`);
    if (result.rows.length === 0) return;
    await this.planner.fanOut(row, null, result.rows, TEST_ALERT_CHANNELS, testAlertId);
  }
}
