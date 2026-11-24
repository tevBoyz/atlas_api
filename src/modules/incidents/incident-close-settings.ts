import { sql } from 'drizzle-orm';

import type { IncidentTransaction } from './incidents.repository';

/** `app_config` `incident_close_after_minutes` when missing or not > 0 (SCRUM-63, D62). */
export const DEFAULT_INCIDENT_CLOSE_AFTER_MINUTES = 30;
/** `app_config` `incident_auto_close_after_hours` when missing or not > 0 (SCRUM-63, D62). */
export const DEFAULT_INCIDENT_AUTO_CLOSE_AFTER_HOURS = 24;

/** The two close settings of the sweeper (D62). */
export interface IncidentCloseSettings {
  /** Resolved (Safe) -> Closed this many minutes after mark safe (`resolved_at`). */
  close_after_minutes: number;
  /** Active -> Closed (`ended`, `auto_closed`) after this many hours without activity. */
  auto_close_after_hours: number;
}

/**
 * Reads the two close settings from `app_config` on every sweep (no restart needed to change them),
 * with the read pattern of the live-location settings (`LiveLocationConfigService`): a value counts
 * only when it is a JSON number, `(value #>> '{}')::integer`; missing, another JSON type, or <= 0 falls
 * back to 30 minutes / 24 hours.
 *
 * IMPORTANT (operators): store both as whole numbers (for example `30`, `24`). A decimal such as
 * `0.5` or a value above 2147483647 makes the cast raise: that sweep fails (logged) and nothing is
 * closed until the value is fixed, the same rule as the live-location settings.
 */
export async function readIncidentCloseSettings(
  tx: IncidentTransaction,
): Promise<IncidentCloseSettings> {
  const result = await tx.execute<{ minutes: number | null; hours: number | null }>(sql`
    select (select case
                     when jsonb_typeof(c.value) = 'number' then (c.value #>> '{}')::integer
                     else null
                   end
              from public.app_config c
             where c.key = 'incident_close_after_minutes') as minutes,
           (select case
                     when jsonb_typeof(c.value) = 'number' then (c.value #>> '{}')::integer
                     else null
                   end
              from public.app_config c
             where c.key = 'incident_auto_close_after_hours') as hours`);
  const row = result.rows[0];
  return {
    close_after_minutes: positiveOr(row.minutes, DEFAULT_INCIDENT_CLOSE_AFTER_MINUTES),
    auto_close_after_hours: positiveOr(row.hours, DEFAULT_INCIDENT_AUTO_CLOSE_AFTER_HOURS),
  };
}

function positiveOr(value: number | null, fallback: number): number {
  return value === null || value <= 0 ? fallback : value;
}
