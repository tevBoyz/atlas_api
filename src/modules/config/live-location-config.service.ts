import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { DatabaseService } from '../../db/database.service';
import {
  DEFAULT_LIVE_LOCATION_INTERVAL_SECONDS,
  DEFAULT_LIVE_LOCATION_STALE_THRESHOLD_SECONDS,
  type LiveLocationConfig,
} from './live-location-config.schemas';

/**
 * `get_live_location_config()` (final definition: baseline migration 20261023110000). Each value is
 * read with the function's own expression, `case when jsonb_typeof(value) = 'number' then
 * (value #>> '{}')::integer end`, so "a number" means exactly what it means there: a JSON string,
 * boolean, null, object or array falls back; a JSON number whose text is not an integer (`12.5`,
 * `12.0`) or is out of int4 range makes Postgres raise, as the function does (the API answers 500).
 * Then missing or ≤ 0 → 12 / 45. Any valid token; nothing is written.
 *
 * IMPORTANT (operators): `live_location_interval_seconds` and `live_location_stale_threshold_seconds`
 * in `app_config` MUST be stored as whole numbers (for example `12`, `45`). A decimal such as `12.5`
 * or `12.0`, or a value above 2147483647, makes this read crash (500 `internal:error`), exactly like
 * the SQL function it replaces, and the app then falls back to its own built-in timing. Kept on
 * purpose for parity (Dawit, 2026-11-19).
 */
@Injectable()
export class LiveLocationConfigService {
  constructor(private readonly database: DatabaseService) {}

  async get(): Promise<LiveLocationConfig> {
    const result = await this.database.db.execute<{
      interval_seconds: number | null;
      stale_threshold_seconds: number | null;
    }>(sql`
      select (select case
                       when jsonb_typeof(c.value) = 'number' then (c.value #>> '{}')::integer
                       else null
                     end
                from public.app_config c
               where c.key = 'live_location_interval_seconds') as interval_seconds,
             (select case
                       when jsonb_typeof(c.value) = 'number' then (c.value #>> '{}')::integer
                       else null
                     end
                from public.app_config c
               where c.key = 'live_location_stale_threshold_seconds') as stale_threshold_seconds`);
    const row = result.rows[0];
    return {
      interval_seconds: positiveOr(row.interval_seconds, DEFAULT_LIVE_LOCATION_INTERVAL_SECONDS),
      stale_threshold_seconds: positiveOr(
        row.stale_threshold_seconds,
        DEFAULT_LIVE_LOCATION_STALE_THRESHOLD_SECONDS,
      ),
    };
  }
}

/** `if v is null or v <= 0 then v := fallback`. */
function positiveOr(value: number | null, fallback: number): number {
  return value === null || value <= 0 ? fallback : value;
}
