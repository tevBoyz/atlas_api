import { z } from 'zod';

import { componentSchema } from '../../openapi/component-schema';
import { inviteLookupStatusSchema } from '../../openapi/schemas';

/**
 * Contract schemas of the owner invite routes (API-100-26/27/28, spec §7.0, §7.2, §11.3 I1-I5). The
 * request schemas document the body; the routes parse it themselves (`invite-input.ts`) so that the
 * SQL functions' checks and codes stay in the functions' order.
 */

const relationshipSchema = z
  .enum(['spouse', 'partner', 'parent', 'child', 'sibling', 'friend', 'other'])
  .describe('Spec §4.4: one of the 7 relationship values.');

/** `POST /v1/me/circle/invites/phone` (`invite_circle_member_by_phone`). */
export const phoneInviteRequestSchema = z.object({
  display_name: z.string().describe('Trimmed (spaces); must not be empty.'),
  phone: z.string().describe('Strict E.164 after trimming (spaces): `^\\+[1-9][0-9]{7,14}$`.'),
  relationship: relationshipSchema
    .nullable()
    .optional()
    .describe('Null or blank: none (an existing row keeps its own). Else one of the 7 values.'),
});

/** One person of a batch invite. */
export const batchInviteItemSchema = componentSchema(
  'BatchInviteItem',
  z.object({
    phone: z
      .string()
      .describe('Trimmed; 8-15 digits starting 1-9 get a leading `+`; then strict E.164.'),
    display_name: z.string(),
  }),
);

/** `POST /v1/me/circle/invites/phone/batch` (`invite_circle_members_by_phone`). */
export const batchInviteRequestSchema = z.object({
  invites: z
    .array(batchInviteItemSchema)
    .describe('Processed in array order, in one transaction. Not an array → `invalid_invites`.'),
});

/** `POST /v1/me/circle/invites/link` (`create_circle_invite_link`). */
export const linkInviteRequestSchema = z.object({
  display_name: z.string().nullable().optional().describe('Missing or blank: `Invited member`.'),
});

/** MemberInvitePayload (spec §7.0, `_circle_invite_payload`). */
export const memberInvitePayloadSchema = componentSchema(
  'MemberInvitePayload',
  z.object({
    member_id: z.uuid(),
    circle_id: z.uuid(),
    status: z.string().describe('Stored status of the row: `pending`.'),
    display_name: z.string(),
    relationship: z.string().nullable(),
    phone: z.string().nullable().describe('Null for a link invite.'),
    invite_token: z.string().describe('64 lowercase hex characters; single use; 7-day expiry.'),
    invite_url: z.string().describe('`INVITE_URL_BASE` + `invite_token`.'),
    invited_at: z.string(),
    invite_expires_at: z.string().nullable(),
    resent: z.boolean().describe('True when an existing row was refreshed (same `member_id`).'),
  }),
);

export const batchInviteSkippedSchema = componentSchema(
  'BatchInviteSkipped',
  z.object({
    phone: z.string(),
    reason: z.enum(['already_active', 'already_pending']),
    member_id: z.uuid(),
    display_name: z.string(),
  }),
);

export const batchInviteNotCreatedSchema = componentSchema(
  'BatchInviteNotCreated',
  z.object({
    phone: z.string().nullable(),
    reason: z.enum([
      'invalid_invite',
      'invalid_phone',
      'invalid_display_name',
      'circle_full',
      'duplicate_membership',
    ]),
    display_name: z.string().nullable(),
  }),
);

/** The body of `invite_circle_members_by_phone`. */
export const batchInviteResultSchema = componentSchema(
  'BatchInviteResult',
  z.object({
    created: z
      .array(memberInvitePayloadSchema)
      .describe('New rows (`resent: false`) and refreshed expired/declined rows (`resent: true`).'),
    skipped: z.array(batchInviteSkippedSchema),
    not_created: z.array(batchInviteNotCreatedSchema),
    available_after: z.number().int().describe('Free slots after the batch (Capacity.available).'),
  }),
);

/** The body of `cancel_circle_invite`. */
export const canceledInviteSchema = componentSchema(
  'CanceledInvite',
  z.object({
    member_id: z.uuid(),
    circle_id: z.uuid(),
    status: z.literal('canceled'),
    owner_name: z.string().nullable().describe("The owner row's stored display name."),
  }),
);

/** `{token}` of the invitee routes (API-100-29/30, spec §11.3 I6-I9). */
export const inviteTokenParamsSchema = z.object({
  token: z
    .string()
    .describe(
      'The invite token (64 lowercase hex characters), trimmed (spaces). Blank or unknown: `not_found`. A secret: never logged (the log line carries the route template only).',
    ),
});

/** The body of `lookup_circle_invite` (spec §7.3): status only, never a name, phone or id. */
export const inviteLookupSchema = componentSchema(
  'InviteLookup',
  z.object({
    status: inviteLookupStatusSchema,
    invite_expires_at: z.string().nullable().describe('Null when the token is not found.'),
  }),
);

/** The body of `preview_circle_invite` (spec §7.3). */
export const invitePreviewSchema = componentSchema(
  'InvitePreview',
  z.object({
    status: z
      .enum([
        'pending',
        'expired',
        'consumed',
        'canceled',
        'not_found',
        'own_circle',
        'already_member',
        'circle_full',
      ])
      .describe(
        'Lookup status, or the display statuses `own_circle`, `already_member`, `circle_full`.',
      ),
    invite_expires_at: z.string().nullable(),
    member_id: z.uuid().nullable().describe('Only when the row is shown.'),
    circle_id: z.uuid().nullable().describe('Only when the row is shown.'),
    owner_name: z
      .string()
      .nullable()
      .describe("Only when the owner is shown: the owner row's stored display name."),
    invited_at: z.string().nullable().describe('Only when the row is shown.'),
    claimed: z
      .boolean()
      .nullable()
      .describe(
        'True when the invitation is (now) bound to the caller. Null where the SQL function returns null (e.g. the owner previewing an unclaimed invitation).',
      ),
    recipient_ok: z.boolean().describe('The caller may accept this invitation (spec rule 18).'),
    owner_avatar_url: z
      .string()
      .nullable()
      .describe("Only when the owner is shown: the owner's public avatar URL, or null."),
  }),
);

/** The body of `accept_circle_invite` (spec §7.3). */
export const acceptedInviteSchema = componentSchema(
  'AcceptedInvite',
  z.object({
    circle_id: z.uuid(),
    member_id: z.uuid(),
    status: z.literal('active'),
    owner_name: z.string().nullable().describe("The owner row's stored display name."),
  }),
);

/** The body of `decline_circle_invite` (spec §7.3). */
export const declinedInviteSchema = componentSchema(
  'DeclinedInvite',
  z.object({
    circle_id: z.uuid(),
    member_id: z.uuid(),
    status: z.literal('declined'),
    owner_name: z.string().nullable().describe("The owner row's stored display name."),
  }),
);

/** `{member_id}` of resend and cancel (documentation; non-uuid input is 422 on `member_id`). */
export const memberIdParamsSchema = z.object({
  member_id: z.guid().describe('The invite (member row) id.'),
});
