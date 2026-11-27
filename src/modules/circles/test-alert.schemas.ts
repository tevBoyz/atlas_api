import { z } from 'zod';

import { componentSchema } from '../../openapi/component-schema';
import { TEST_ALERT_FAILURE_REASONS, TEST_ALERT_MEMBER_STATES } from './test-alert-status';

/** `{id}` of the test-alert routes (SCRUM-35). */
export const testAlertIdParamsSchema = z.object({
  id: z.guid().describe('The test alert id.'),
});

/** `POST /v1/me/circle/test-alerts` 201 (D66): the test was submitted (not yet delivered). */
export const testAlertSentSchema = componentSchema(
  'TestAlertSent',
  z.object({
    id: z.uuid(),
    created_at: z.string().describe('When the test was sent (UTC).'),
    recipient_count: z
      .number()
      .int()
      .describe('How many active members it was sent to (pending members are never included).'),
  }),
);

export const testAlertMemberStateSchema = componentSchema(
  'TestAlertMemberState',
  z.enum(TEST_ALERT_MEMBER_STATES),
);

export const testAlertFailureReasonSchema = componentSchema(
  'TestAlertFailureReason',
  z.enum(TEST_ALERT_FAILURE_REASONS),
);

/** One recipient in the owner's status (D68). */
export const testAlertRecipientSchema = componentSchema(
  'TestAlertRecipient',
  z.object({
    handle: z
      .uuid()
      .nullable()
      .describe(
        "D79 (replaces user_id): the recipient's member row id in the circle (CircleMember.handle); null once they hold no row there.",
      ),
    display_name: z
      .string()
      .nullable()
      .describe('The member current profile name (trimmed), else the name on their member row.'),
    status: testAlertMemberStateSchema,
    failure_reason: testAlertFailureReasonSchema
      .nullable()
      .describe(
        'Set only when `status` is `failed`: `no_device`, `invalid_token`, `provider_error`, `channel_disabled` or `not_eligible`.',
      ),
    delivered_at: z
      .string()
      .nullable()
      .describe('When the push provider first accepted it for one of the member devices.'),
    seen_at: z.string().nullable().describe('When the member opened it in Atlas.'),
  }),
);

/** The owner's status of one test alert (D68). */
export const testAlertStatusSchema = componentSchema(
  'TestAlertStatus',
  z.object({
    id: z.uuid(),
    circle_id: z.uuid(),
    created_at: z.string(),
    recipient_count: z.number().int(),
    delivered_count: z.number().int().describe('Members whose push the provider accepted.'),
    seen_count: z.number().int().describe('Members who opened it in Atlas.'),
    failed_count: z.number().int(),
    pending_count: z
      .number()
      .int()
      .describe('Per member, exclusive: the four counts add up to `recipient_count`.'),
    recipients: z
      .array(testAlertRecipientSchema)
      .describe(
        'Every recipient, by name. `status`: `pending` (not sent yet or being retried), `delivered` (the push provider accepted it), `seen` (the member opened it in Atlas), `failed` (see `failure_reason`).',
      ),
  }),
);

/** `GET /v1/me/circle/test-alerts/latest` (D68). */
export const latestTestAlertSchema = componentSchema(
  'LatestTestAlert',
  z.object({
    test_alert: testAlertStatusSchema
      .nullable()
      .describe('Null when the caller never sent a test alert.'),
  }),
);

/** A recipient's view of a test alert (D68). */
export const memberTestAlertSchema = componentSchema(
  'MemberTestAlert',
  z.object({
    id: z.uuid(),
    owner_name: z
      .string()
      .nullable()
      .describe('The circle owner current profile name (trimmed); null when blank.'),
    created_at: z.string().describe('When the owner sent the test (UTC).'),
    is_test: z.boolean().describe('Always true: a test, never an emergency.'),
    seen_at: z.string().nullable().describe('When the caller opened it; null until then.'),
  }),
);
