import { z } from 'zod';

import { componentSchema } from '../../openapi/component-schema';

/**
 * Contract schemas of the profile routes (API-100-34 to 37, spec §4.2, §11.3 P1-P9). The request
 * schemas document the bodies; the routes parse them themselves (`profile-input.ts`) so that the
 * checks run in the documented field order and each failure keeps its own `profiles:*` code.
 */

const timestamp = () => z.string().nullable();

/** Spec §5.1 enums, published once each (one Dart class). */
export const genderSchema = componentSchema(
  'Gender',
  z.enum(['female', 'male', 'prefer_not_to_say']),
);
export const relationshipSchema = componentSchema(
  'Relationship',
  z.enum(['spouse', 'partner', 'parent', 'child', 'sibling', 'friend', 'other']),
);
export const bloodTypeSchema = componentSchema(
  'BloodType',
  z.enum(['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', 'Unknown']),
);
export const preferredLanguageSchema = componentSchema(
  'PreferredLanguage',
  z.enum(['en', 'wo', 'mnk', 'ff']),
);

/** One allergy or medical condition (SCRUM-21, D51). */
export const medicalItemSchema = componentSchema(
  'MedicalItem',
  z.object({
    id: z.uuid(),
    text: z
      .string()
      .describe('1-100 characters, trimmed (an item from the old free text may be longer).'),
    updated_at: z.string().describe('When the item was added or last edited.'),
  }),
);

/**
 * Profile (spec §4.2 + `avatar_url`): every `profiles` column, in the table's column order (as the
 * app's `select *` returns them today), then `avatar_url`. Only ever the caller's own row.
 */
export const profileSchema = componentSchema(
  'Profile',
  z.object({
    id: z.uuid(),
    full_name: z.string(),
    date_of_birth: z.string().describe('`YYYY-MM-DD`.'),
    gender: genderSchema.nullable(),
    avatar_path: z
      .string()
      .nullable()
      .describe('Object path in the `avatars` bucket, e.g. `{uid}/avatar-{uuid}.jpg`.'),
    personal_info_completed_at: timestamp().describe(
      'Set by the server the first time Personal Info is saved; never reset.',
    ),
    created_at: z.string(),
    updated_at: z.string(),
    alert_push_enabled: z.boolean(),
    alert_email_enabled: z.boolean(),
    alert_sms_enabled: z.boolean(),
    location_sharing_enabled: z.boolean(),
    hide_profile_from_non_members: z.boolean(),
    app_language: z.literal('en'),
    timezone: z.literal('Africa/Banjul'),
    preferences_completed_at: timestamp().describe(
      'Set by the server the first time Preferences are saved; never reset.',
    ),
    preferred_language: preferredLanguageSchema,
    emergency_contact_full_name: z.string().nullable(),
    emergency_contact_relationship: relationshipSchema.nullable(),
    emergency_contact_phone: z.string().nullable(),
    emergency_contact_email: z.string().nullable(),
    blood_type: bloodTypeSchema.nullable(),
    allergies: z
      .string()
      .nullable()
      .describe('The allergy items joined with ", " (kept for old readers); use `allergy_items`.'),
    medical_conditions: z
      .string()
      .nullable()
      .describe(
        'The medical-condition items joined with ", " (kept for old readers); use `medical_condition_items`.',
      ),
    emergency_preferred_language: z.string().nullable(),
    emergency_info_completed_at: timestamp().describe(
      'Set by the server the first time Emergency Info is saved; never reset.',
    ),
    emergency_notes: z.string().nullable(),
    emergency_notes_shareable: z.boolean(),
    profile_setup_completed_at: timestamp().describe(
      'Set by `POST /v1/me/profile/complete` (first success wins).',
    ),
    share_emergency_contact_full_name: z.boolean(),
    share_emergency_contact_relationship: z.boolean(),
    share_emergency_contact_phone: z.boolean(),
    share_emergency_contact_email: z.boolean(),
    share_blood_type: z.boolean(),
    share_allergies: z.boolean(),
    share_medical_conditions: z.boolean(),
    share_emergency_preferred_language: z.boolean(),
    medical_info_updated_at: timestamp().describe(
      'When the medical info last changed: an allergy or condition added, edited or deleted, or the blood type changed (SCRUM-21). Null before the first change.',
    ),
    avatar_url: z
      .string()
      .nullable()
      .describe(
        'Public URL of `avatar_path`: `{SUPABASE_URL}/storage/v1/object/public/avatars/{avatar_path}`; null without a photo.',
      ),
    allergy_items: z
      .array(medicalItemSchema)
      .describe('The allergies, oldest first (SCRUM-21, D51).'),
    medical_condition_items: z
      .array(medicalItemSchema)
      .describe('The medical conditions, oldest first (SCRUM-21, D51).'),
  }),
);

/** `PUT /v1/me/profile/personal-info` (P2). */
export const personalInfoRequestSchema = z.object({
  full_name: z.string().describe('Trimmed; must not be empty (`profiles:invalid_full_name`).'),
  date_of_birth: z
    .string()
    .describe(
      '`YYYY-MM-DD`, a real date not after today (Africa/Banjul = UTC) (`profiles:invalid_date_of_birth`).',
    ),
  gender: genderSchema
    .nullable()
    .optional()
    .describe('Null clears it; left out keeps the stored value (null on a new profile).'),
  avatar_path: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Null clears it; left out keeps the stored value. Else an object path in the caller's own folder: `{uid}/<name>` (`profiles:invalid_avatar_path`).",
    ),
});

/** The 8 `share_*` flags plus `emergency_notes_shareable` (SCRUM-24/25). */
export const SHARE_FLAGS = [
  'emergency_notes_shareable',
  'share_emergency_contact_full_name',
  'share_emergency_contact_relationship',
  'share_emergency_contact_phone',
  'share_emergency_contact_email',
  'share_blood_type',
  'share_allergies',
  'share_medical_conditions',
  'share_emergency_preferred_language',
] as const;

export type ShareFlag = (typeof SHARE_FLAGS)[number];

const optionalText = (what: string) =>
  z
    .string()
    .nullable()
    .optional()
    .describe(`${what} Trimmed; blank or left out is stored as null.`);

/** `PUT /v1/me/profile/emergency-info` (P3). */
export const emergencyInfoRequestSchema = z.object({
  emergency_contact_full_name: z
    .string()
    .describe('Trimmed; must not be empty (`profiles:invalid_emergency_contact_full_name`).'),
  // Not described here so it stays a `$ref` to the shared Relationship enum (`profiles:invalid_relationship`).
  emergency_contact_relationship: relationshipSchema,
  emergency_contact_phone: z
    .string()
    .describe(
      'Strict E.164 after trimming: `^\\+[1-9][0-9]{7,14}$` (`profiles:invalid_phone`). The server adds no country code.',
    ),
  emergency_contact_email: optionalText('An email address (`profiles:invalid_email`).'),
  blood_type: bloodTypeSchema
    .nullable()
    .optional()
    .describe('Blank or left out: null (`profiles:invalid_blood_type`).'),
  allergies: z
    .string()
    .nullable()
    .optional()
    .describe(
      'Ignored since SCRUM-21 (D51): use `POST /v1/me/profile/allergies` and its item routes.',
    ),
  medical_conditions: z
    .string()
    .nullable()
    .optional()
    .describe(
      'Ignored since SCRUM-21 (D51): use `POST /v1/me/profile/medical-conditions` and its item routes.',
    ),
  emergency_preferred_language: optionalText('Free text.'),
  location_sharing_enabled: z.boolean(),
  emergency_notes: optionalText('At most 500 characters (`profiles:emergency_notes_too_long`).'),
  emergency_notes_shareable: z.boolean(),
  share_emergency_contact_full_name: z.boolean(),
  share_emergency_contact_relationship: z.boolean(),
  share_emergency_contact_phone: z.boolean(),
  share_emergency_contact_email: z.boolean(),
  share_blood_type: z.boolean(),
  share_allergies: z.boolean(),
  share_medical_conditions: z.boolean(),
  share_emergency_preferred_language: z.boolean(),
});

/** `POST` / `PATCH` of an allergy or medical condition (SCRUM-21, D51). */
export const medicalItemRequestSchema = z.object({
  text: z
    .string()
    .describe(
      'Trimmed; 1-100 characters (`profiles:invalid_medical_item`); not the same as another item of the list, ignoring case (`profiles:duplicate_medical_item`).',
    ),
});

/** The `{item_id}` of an allergy or medical condition. */
export const medicalItemParamsSchema = z.object({
  item_id: z
    .guid()
    .describe(
      "The item id. Another user's item, or one of the other list, is `medical_item_not_found`.",
    ),
});

/** `PUT /v1/me/profile/preferences` (P4). */
export const preferencesRequestSchema = z.object({
  alert_push_enabled: z.boolean(),
  alert_email_enabled: z.boolean(),
  alert_sms_enabled: z.boolean(),
  location_sharing_enabled: z.boolean(),
  hide_profile_from_non_members: z.boolean(),
  app_language: z.literal('en').describe('`profiles:invalid_app_language`.'),
  timezone: z.literal('Africa/Banjul').describe('`profiles:invalid_timezone`.'),
  // A `$ref` to the shared PreferredLanguage enum (`profiles:invalid_preferred_language`).
  preferred_language: preferredLanguageSchema,
});

/** `PATCH /v1/me/profile/sharing-flags` (P5): any subset of the 9 flags. */
export const sharingFlagsRequestSchema = z.object(
  Object.fromEntries(SHARE_FLAGS.map((flag) => [flag, z.boolean().optional()])) as Record<
    ShareFlag,
    z.ZodOptional<z.ZodBoolean>
  >,
);

/** `PATCH /v1/me/profile/location-sharing` (P6). */
export const locationSharingRequestSchema = z.object({
  enabled: z.boolean(),
});

/** The body of `complete_profile_setup()` (spec §7.1, §11.3 P7), in the function's jsonb order. */
export const profileSetupResultSchema = componentSchema(
  'ProfileSetupResult',
  z.object({
    circle_id: z.uuid().nullable().describe('Null while location sharing is off (no circle yet).'),
    member_id: z.uuid().nullable().describe("The emergency contact's member row."),
    member_status: z
      .enum(['pending', 'active', 'declined'])
      .nullable()
      .describe(
        "The contact row's stored status: `declined` when it was left unchanged because the circle is full.",
      ),
    location_sharing_enabled: z.boolean(),
    profile_setup_completed_at: z.string().describe('First completion time; never moves.'),
  }),
);

/** `POST /v1/me/avatar/upload-url` (P8). */
export const avatarUploadUrlRequestSchema = z.object({
  content_type: z
    .enum(['image/jpeg', 'image/png', 'image/webp'])
    .describe('`profiles:invalid_content_type` otherwise.'),
  content_length: z
    .number()
    .int()
    .positive()
    .describe('Bytes; at most 5,242,880 (`profiles:file_too_large`).'),
});

export const avatarUploadUrlSchema = componentSchema(
  'AvatarUploadUrl',
  z.object({
    upload_url: z.string().describe('Send the photo bytes here once, before `expires_at`.'),
    method: z.literal('PUT'),
    headers: z
      .record(z.string(), z.string())
      .describe('Headers to send with the upload (`content-type`).'),
    object_path: z
      .string()
      .describe('`{uid}/avatar-{uuid}.{jpg|png|webp}`: pass it to `PUT /v1/me/profile/avatar`.'),
    expires_at: z.string().describe('ISO-8601 UTC time after which the upload URL is refused.'),
  }),
);

/** `PUT /v1/me/profile/avatar` (P9). */
export const setAvatarRequestSchema = z.object({
  object_path: z
    .string()
    .nullable()
    .describe(
      "An uploaded object in the caller's own folder (`{uid}/...`), or null to remove the photo.",
    ),
});
