import { z } from 'zod';

import { componentSchema } from '../../openapi/component-schema';
import { emergencyTypeSchema, incidentStatusSchema } from '../../openapi/schemas';

/**
 * SCRUM-82 (View Emergency Activity Log), decision D72: `GET /v1/me/activity`. The request query, the
 * entry shape and the paging cursor.
 */

export const ACTIVITY_CATEGORIES = ['all', 'mine', 'circle'] as const;
export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number];

export const ACTIVITY_DEFAULT_LIMIT = 30;
export const ACTIVITY_MAX_LIMIT = 50;

/** A base-10 integer with an optional sign: what a client sends for an `integer` parameter. */
const DECIMAL_INTEGER = /^[+-]?\d+$/;
/** The cursor's alphabet (base64url without padding) and a generous length cap. */
const CURSOR_TEXT = /^[A-Za-z0-9_-]{1,200}$/;

/**
 * `?category=&before=&limit=`. Field order = check order: a bad `category`, then a bad `before`,
 * then a bad `limit` is 422 `validation:invalid_request` with `details.field` naming it (the value is
 * never echoed). A repeated parameter (an array) is refused the same way. Other parameters are
 * ignored. `before` is only checked for its alphabet here; its content is checked by
 * {@link decodeActivityCursor}, also 422 with field `before`.
 */
export const activityQuerySchema = z.object({
  category: z
    .enum(ACTIVITY_CATEGORIES)
    .optional()
    .describe(
      '"all" (default): the caller\'s own alerts and their circle alerts together; "mine": only alerts the caller raised (My Emergencies); "circle": only alerts of others in circles the caller is an active member of, inside the access window (Circle Alerts).',
    ),
  before: z
    .string()
    .regex(CURSOR_TEXT)
    .optional()
    .describe(
      'The `next_cursor` of the previous page, unchanged (opaque). Missing = the newest entries.',
    ),
  limit: z
    .preprocess(
      (value) => (typeof value === 'string' && DECIMAL_INTEGER.test(value) ? Number(value) : value),
      z.int().min(1).max(ACTIVITY_MAX_LIMIT),
    )
    .optional()
    .describe(
      `How many entries to return, 1-${ACTIVITY_MAX_LIMIT}. Default ${ACTIVITY_DEFAULT_LIMIT}. Anything else is 422.`,
    ),
});

export type ActivityQuery = z.output<typeof activityQuerySchema>;

/** The position of an entry in the list order (`occurred_at` desc, then `id` desc). */
export interface ActivityCursor {
  /** `occurred_at` in UTC with microseconds: `YYYY-MM-DDTHH:MM:SS.ffffffZ`. */
  occurredAt: string;
  /** The event id (lowercase uuid). */
  id: string;
}

const CURSOR_AT = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3})\d{3}Z$/;
const CURSOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The cursor of an entry: base64url (no padding) of `<occurred_at>|<id>`, both exactly as the list
 * query writes them. Opaque to the app.
 */
export function encodeActivityCursor(cursor: ActivityCursor): string {
  return Buffer.from(`${cursor.occurredAt}|${cursor.id}`, 'utf8').toString('base64url');
}

/**
 * Reads a cursor written by {@link encodeActivityCursor}; undefined for anything else (wrong
 * alphabet, not the two parts, a time that is not a real instant, an id that is not a lowercase
 * uuid). Strict: re-encoding the result gives back exactly `value`.
 */
export function decodeActivityCursor(value: string): ActivityCursor | undefined {
  if (!CURSOR_TEXT.test(value)) return undefined;
  const text = Buffer.from(value, 'base64url').toString('utf8');
  const parts = text.split('|');
  if (parts.length !== 2) return undefined;
  const [occurredAt, id] = parts;
  const at = CURSOR_AT.exec(occurredAt);
  if (!at || !CURSOR_ID.test(id)) return undefined;
  const instant = new Date(`${at[1]}Z`);
  // A real instant: no day 31 in a 30-day month, no hour 24 (Date would roll it over).
  if (Number.isNaN(instant.getTime()) || instant.toISOString() !== `${at[1]}Z`) return undefined;
  const cursor = { occurredAt, id };
  return encodeActivityCursor(cursor) === value ? cursor : undefined;
}

/**
 * What an entry stands for (D72). My Emergencies (own alerts): `emergency_initiated`,
 * `location_shared`, `acknowledged` / `responding` / `unable` (any member), `ended`. Circle Alerts:
 * `alert_received`, `acknowledged` / `responding` / `unable` (the caller's own only),
 * `status_update`, `ended`.
 */
export const ACTIVITY_KINDS = [
  'emergency_initiated',
  'alert_received',
  'location_shared',
  'acknowledged',
  'responding',
  'unable',
  'status_update',
  'ended',
] as const;

export const activityIncidentSchema = componentSchema(
  'ActivityIncident',
  z.object({
    id: z.uuid().describe('The alert (open it with the existing incident reads).'),
    status: incidentStatusSchema.describe(
      "The alert's CURRENT state (active, resolved, closed), not the state at the entry's time.",
    ),
    emergency_type: emergencyTypeSchema,
    resident_name: z
      .string()
      .nullable()
      .describe(
        "Circle entries: the resident's profile name, trimmed ('' when unknown). Null on the caller's own alerts.",
      ),
    circle_name: z
      .string()
      .nullable()
      .describe("Circle entries: the Safety Circle's name. Null on the caller's own alerts."),
  }),
);

export const activityEntrySchema = componentSchema(
  'ActivityEntry',
  z.object({
    id: z
      .uuid()
      .describe('The underlying incident event id: unique, use it to drop duplicates when paging.'),
    kind: z
      .enum(ACTIVITY_KINDS)
      .describe(
        'emergency_initiated (own alert sent; Sent), alert_received (a circle alert reached the caller; Received), location_shared (own alert, live location started; Active), acknowledged / responding / unable (a member acknowledged or set their response: on own alerts any member, on circle alerts the caller only), status_update (circle alerts: an update from the resident; detail.preset or detail.text), ended (once per alert: marked safe, or closed automatically; detail.reason).',
      ),
    category: z
      .enum(['mine', 'circle'])
      .describe('"mine" = an alert the caller raised; "circle" = a circle alert of someone else.'),
    occurred_at: z.string().describe('Server time of the event (timestamptz).'),
    incident: activityIncidentSchema,
    actor_name: z
      .string()
      .nullable()
      .describe(
        'Who did it, by display name (D71): the resident, or the member for acknowledged / responding / unable. Null when nobody did (an automatic close).',
      ),
    detail: z
      .object({
        preset: z
          .enum(['situation_worsening', 'help_is_here'])
          .nullable()
          .optional()
          .describe('status_update: the quick update, or null for a text update.'),
        text: z
          .string()
          .nullable()
          .optional()
          .describe('status_update: the free text (1-250 characters), or null for a preset.'),
        reason: z
          .enum(['safe', 'ended'])
          .optional()
          .describe(
            'ended: "safe" (the resident marked safe) or "ended" (closed automatically after inactivity).',
          ),
      })
      .nullable()
      .describe(
        'status_update: {preset, text}; ended: {reason}; null for every other kind. Never location, medical or contact data.',
      ),
  }),
);

export const activityPageSchema = componentSchema(
  'ActivityPage',
  z.object({
    entries: z
      .array(activityEntrySchema)
      .describe('Newest first: occurred_at descending, then id descending.'),
    next_cursor: z
      .string()
      .nullable()
      .describe('Pass as `before` for the next (older) page; null when there is no more.'),
  }),
);
