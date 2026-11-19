import { z } from 'zod';

import { componentSchema } from '../../openapi/component-schema';

/** Spec rule 35: the defaults when a key is missing, not a JSON number, or ≤ 0. */
export const DEFAULT_LIVE_LOCATION_INTERVAL_SECONDS = 12;
export const DEFAULT_LIVE_LOCATION_STALE_THRESHOLD_SECONDS = 45;

/** `get_live_location_config()`: `{interval_seconds, stale_threshold_seconds}`. */
export const liveLocationConfigSchema = componentSchema(
  'LiveLocationConfig',
  z.object({
    interval_seconds: z
      .number()
      .int()
      .describe('Seconds between location uploads while an alert is active (default 12).'),
    stale_threshold_seconds: z
      .number()
      .int()
      .describe('A fix older than this many seconds is shown as stale (default 45).'),
  }),
);

export type LiveLocationConfig = z.output<typeof liveLocationConfigSchema>;
