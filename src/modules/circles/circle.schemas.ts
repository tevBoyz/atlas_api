import { z } from 'zod';

import { componentSchema } from '../../openapi/component-schema';
import { memberStatusSchema } from '../../openapi/schemas';

/**
 * Capacity (spec §7.0, `_circle_invite_capacity_json`): exactly these 5 integer keys. Owner excluded;
 * `pending_count` counts valid pending invites only (not canceled, not consumed, not expired).
 */
export const capacitySchema = componentSchema(
  'Capacity',
  z.object({
    limit: z.number().int().describe('Trusted-member slots, owner excluded (5).'),
    active_count: z.number().int().describe('Active members, owner excluded.'),
    pending_count: z
      .number()
      .int()
      .describe('Valid pending invites only: not canceled, not consumed, not expired.'),
    used: z.number().int().describe('`active_count + pending_count`.'),
    available: z.number().int().describe('`max(0, limit - used)`.'),
  }),
);

/** `safety_circles` as the app reads it (`fetchOwnCircle`, spec §7.8): exactly these 5 keys. */
export const safetyCircleSchema = componentSchema(
  'SafetyCircle',
  z.object({
    id: z.uuid(),
    owner_id: z.uuid(),
    name: z.string(),
    created_at: z.string(),
    updated_at: z.string(),
  }),
);

/**
 * One element of `list_circle_members` (spec §7.2). Every caller gets the first 8 keys; the circle
 * owner also gets the 6 contact/invite keys (always present for the owner, never for a member).
 * `invite_token` is never returned.
 */
export const circleMemberSchema = componentSchema(
  'CircleMember',
  z.object({
    member_id: z.uuid(),
    role: z.enum(['owner', 'member']),
    // Stored status; a pending invite past its expiry is `expired` (owner view only: members see
    // `active` rows only). Not described here so it stays a `$ref` to the shared MemberStatus enum.
    status: memberStatusSchema,
    display_name: z
      .string()
      .describe(
        "Active rows with a user: that user's current profile name (trimmed), else the stored name. Other rows: the stored invite name.",
      ),
    is_owner: z.boolean(),
    invited_at: z.string(),
    user_id: z.uuid().nullable(),
    avatar_url: z
      .string()
      .nullable()
      .describe(
        "Public URL of the row user's profile photo (`{SUPABASE_URL}/storage/v1/object/public/avatars/{path}`); null without a user or photo.",
      ),
    phone: z.string().nullable().optional().describe('Owner view only.'),
    email: z.string().nullable().optional().describe('Owner view only.'),
    relationship: z.string().nullable().optional().describe('Owner view only.'),
    invite_expires_at: z.string().nullable().optional().describe('Owner view only.'),
    invite_consumed_at: z.string().nullable().optional().describe('Owner view only.'),
    invite_canceled_at: z.string().nullable().optional().describe('Owner view only.'),
  }),
);

export const circleMemberListSchema = z.array(circleMemberSchema);

/** The body of `GET /v1/me/circle` (spec §11.3 C1). */
export const ownCircleSchema = componentSchema(
  'OwnCircle',
  z.object({
    circle: safetyCircleSchema.nullable().describe('Null when the caller owns no circle.'),
    members: circleMemberListSchema.describe(
      'Owner view of the member list (owner row first); empty when there is no circle.',
    ),
    capacity: capacitySchema.nullable().describe('Null when the caller owns no circle.'),
  }),
);

/**
 * `{circle_id}` of the circle routes (documentation). The route accepts what Postgres accepts as uuid
 * input; anything else is 422 `validation:invalid_request` on field `circle_id`.
 */
export const circleIdParamsSchema = z.object({
  circle_id: z.guid().describe('The circle id.'),
});
