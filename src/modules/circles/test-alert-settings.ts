import { sql } from 'drizzle-orm';

import type { Database } from '../../db';

/** `app_config` `circle_test_alert_min_interval_minutes` when missing or not > 0 (SCRUM-35, D66). */
export const DEFAULT_TEST_ALERT_MIN_INTERVAL_MINUTES = 5;
/** `app_config` `circle_test_alert_daily_max` when missing or not > 0 (SCRUM-35, D66). */
export const DEFAULT_TEST_ALERT_DAILY_MAX = 10;

/** The send rate limit of test alerts, per owner (D66). */
export interface TestAlertRateSettings {
  /** At most one test per this many minutes. */
  min_interval_minutes: number;
  /** At most this many tests in any 24 hours. */
  daily_max: number;
}

/**
 * Reads the two rate-limit settings from `app_config` on every send (no restart needed to change
 * them), with the read pattern of the close settings (D62): a value counts only when it is a JSON
 * number; missing, another JSON type, or <= 0 falls back to 5 minutes / 10 per 24 hours. Store whole
 * numbers.
 */
export async function readTestAlertRateSettings(
  tx: Pick<Database, 'execute'>,
): Promise<TestAlertRateSettings> {
  const result = await tx.execute<{ minutes: number | null; daily: number | null }>(sql`
    select (select case
                     when jsonb_typeof(c.value) = 'number' then (c.value #>> '{}')::integer
                     else null
                   end
              from public.app_config c
             where c.key = 'circle_test_alert_min_interval_minutes') as minutes,
           (select case
                     when jsonb_typeof(c.value) = 'number' then (c.value #>> '{}')::integer
                     else null
                   end
              from public.app_config c
             where c.key = 'circle_test_alert_daily_max') as daily`);
  const row = result.rows[0];
  return {
    min_interval_minutes: positiveOr(row.minutes, DEFAULT_TEST_ALERT_MIN_INTERVAL_MINUTES),
    daily_max: positiveOr(row.daily, DEFAULT_TEST_ALERT_DAILY_MAX),
  };
}

function positiveOr(value: number | null, fallback: number): number {
  return value === null || value <= 0 ? fallback : value;
}
