/**
 * Drizzle schema of the Atlas database (API-100-03). GENERATED: do not edit by hand.
 * Regenerate from a freshly baselined LOCAL database with `npm run db:introspect`.
 *
 * - Source of truth is SQL: db/baseline/ (Supabase migrations) + db/migrations/ (API-owned).
 *   Never use drizzle-kit generate/push; schema changes are plain SQL migrations.
 * - Triggers stay authoritative (updated_at, member capacity -> raw `circle_full`,
 *   activated_at). NEVER write `activatedAt` on safety_circle_members: the trigger only ignores
 *   client-chosen values for the anon/authenticated roles, and the API role is neither.
 * - RLS policies are intentionally omitted (authorization is enforced in code, AGENTS.md rule 5).
 * - `authUsers` is READ-ONLY: Supabase Auth owns auth.users.
 */
import {
  bigserial,
  boolean,
  check,
  date,
  doublePrecision,
  foreignKey,
  index,
  inet,
  integer,
  jsonb,
  pgSchema,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

const auth = pgSchema('auth');

/** auth.users (Supabase Auth). READ-ONLY subset used by the API (spec §4.1). */
export const authUsers = auth.table('users', {
  id: uuid().primaryKey().notNull(),
  email: varchar({ length: 255 }),
  /** Stored by GoTrue without the leading "+" in some cases: always normalize to E.164. */
  phone: text(),
  emailConfirmedAt: timestamp('email_confirmed_at', { withTimezone: true, mode: 'string' }),
  phoneConfirmedAt: timestamp('phone_confirmed_at', { withTimezone: true, mode: 'string' }),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }),
});

export const safetyCircles = pgTable(
  'safety_circles',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    ownerId: uuid('owner_id').notNull(),
    name: text().default('My Safety Circle').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.ownerId],
      foreignColumns: [profiles.id],
      name: 'safety_circles_owner_id_fkey',
    }).onDelete('cascade'),
    unique('safety_circles_owner_id_key').on(table.ownerId),
    check('safety_circles_name_nonempty', sql`char_length(TRIM(BOTH FROM name)) > 0`),
  ],
);

export const profiles = pgTable(
  'profiles',
  {
    id: uuid().primaryKey().notNull(),
    fullName: text('full_name').notNull(),
    dateOfBirth: date('date_of_birth').notNull(),
    gender: text(),
    avatarPath: text('avatar_path'),
    personalInfoCompletedAt: timestamp('personal_info_completed_at', {
      withTimezone: true,
      mode: 'string',
    }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    alertPushEnabled: boolean('alert_push_enabled').default(true).notNull(),
    alertEmailEnabled: boolean('alert_email_enabled').default(true).notNull(),
    alertSmsEnabled: boolean('alert_sms_enabled').default(true).notNull(),
    locationSharingEnabled: boolean('location_sharing_enabled').default(true).notNull(),
    hideProfileFromNonMembers: boolean('hide_profile_from_non_members').default(false).notNull(),
    appLanguage: text('app_language').default('en').notNull(),
    timezone: text().default('Africa/Banjul').notNull(),
    preferencesCompletedAt: timestamp('preferences_completed_at', {
      withTimezone: true,
      mode: 'string',
    }),
    preferredLanguage: text('preferred_language').default('en').notNull(),
    emergencyContactFullName: text('emergency_contact_full_name'),
    emergencyContactRelationship: text('emergency_contact_relationship'),
    emergencyContactPhone: text('emergency_contact_phone'),
    emergencyContactEmail: text('emergency_contact_email'),
    bloodType: text('blood_type'),
    allergies: text(),
    medicalConditions: text('medical_conditions'),
    emergencyPreferredLanguage: text('emergency_preferred_language'),
    emergencyInfoCompletedAt: timestamp('emergency_info_completed_at', {
      withTimezone: true,
      mode: 'string',
    }),
    emergencyNotes: text('emergency_notes'),
    emergencyNotesShareable: boolean('emergency_notes_shareable').default(false).notNull(),
    profileSetupCompletedAt: timestamp('profile_setup_completed_at', {
      withTimezone: true,
      mode: 'string',
    }),
    shareEmergencyContactFullName: boolean('share_emergency_contact_full_name')
      .default(false)
      .notNull(),
    shareEmergencyContactRelationship: boolean('share_emergency_contact_relationship')
      .default(false)
      .notNull(),
    shareEmergencyContactPhone: boolean('share_emergency_contact_phone').default(false).notNull(),
    shareEmergencyContactEmail: boolean('share_emergency_contact_email').default(false).notNull(),
    shareBloodType: boolean('share_blood_type').default(false).notNull(),
    shareAllergies: boolean('share_allergies').default(false).notNull(),
    shareMedicalConditions: boolean('share_medical_conditions').default(false).notNull(),
    shareEmergencyPreferredLanguage: boolean('share_emergency_preferred_language')
      .default(false)
      .notNull(),
    medicalInfoUpdatedAt: timestamp('medical_info_updated_at', {
      withTimezone: true,
      mode: 'string',
    }),
    sharePhone: boolean('share_phone').default(true).notNull(),
  },
  (table) => [
    index('profiles_emergency_info_completed_at_idx').using(
      'btree',
      table.emergencyInfoCompletedAt.asc().nullsLast(),
    ),
    index('profiles_personal_info_completed_at_idx').using(
      'btree',
      table.personalInfoCompletedAt.asc().nullsLast(),
    ),
    index('profiles_preferences_completed_at_idx').using(
      'btree',
      table.preferencesCompletedAt.asc().nullsLast(),
    ),
    index('profiles_profile_setup_completed_at_idx').using(
      'btree',
      table.profileSetupCompletedAt.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.id],
      foreignColumns: [authUsers.id],
      name: 'profiles_id_fkey',
    }).onDelete('cascade'),
    check('profiles_full_name_nonempty', sql`char_length(TRIM(BOTH FROM full_name)) > 0`),
    check(
      'profiles_gender_allowed',
      sql`(gender IS NULL) OR (gender = ANY (ARRAY['female'::text, 'male'::text, 'prefer_not_to_say'::text]))`,
    ),
    check('profiles_app_language_allowed', sql`app_language = 'en'::text`),
    check('profiles_timezone_allowed', sql`timezone = 'Africa/Banjul'::text`),
    check(
      'profiles_preferred_language_allowed',
      sql`preferred_language = ANY (ARRAY['en'::text, 'wo'::text, 'mnk'::text, 'ff'::text])`,
    ),
    check(
      'profiles_emergency_contact_relationship_allowed',
      sql`(emergency_contact_relationship IS NULL) OR (emergency_contact_relationship = ANY (ARRAY['spouse'::text, 'partner'::text, 'parent'::text, 'child'::text, 'sibling'::text, 'friend'::text, 'other'::text]))`,
    ),
    check(
      'profiles_blood_type_allowed',
      sql`(blood_type IS NULL) OR (blood_type = ANY (ARRAY['A+'::text, 'A-'::text, 'B+'::text, 'B-'::text, 'AB+'::text, 'AB-'::text, 'O+'::text, 'O-'::text, 'Unknown'::text]))`,
    ),
    check(
      'profiles_emergency_notes_length',
      sql`(emergency_notes IS NULL) OR (char_length(emergency_notes) <= 500)`,
    ),
  ],
);

export const loginLockouts = pgTable(
  'login_lockouts',
  {
    email: text().primaryKey().notNull(),
    failedAttempts: integer('failed_attempts').default(0).notNull(),
    lockedUntil: timestamp('locked_until', { withTimezone: true, mode: 'string' }),
    lastFailedAt: timestamp('last_failed_at', { withTimezone: true, mode: 'string' }),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
  },
  () => [check('login_lockouts_failed_attempts_nonneg', sql`failed_attempts >= 0`)],
);

export const incidentDeliveries = pgTable(
  'incident_deliveries',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    incidentId: uuid('incident_id').notNull(),
    memberId: uuid('member_id').notNull(),
    memberUserId: uuid('member_user_id').notNull(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true, mode: 'string' }),
    responseStatus: text('response_status'),
    responseAt: timestamp('response_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    index('incident_deliveries_incident_id_idx').using('btree', table.incidentId.asc().nullsLast()),
    index('incident_deliveries_member_user_id_idx').using(
      'btree',
      table.memberUserId.asc().nullsLast(),
    ),
    foreignKey({
      columns: [table.incidentId],
      foreignColumns: [incidents.id],
      name: 'incident_deliveries_incident_id_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.memberId],
      foreignColumns: [safetyCircleMembers.id],
      name: 'incident_deliveries_member_id_fkey',
    }).onDelete('cascade'),
    unique('incident_deliveries_incident_member_user_uidx').on(
      table.incidentId,
      table.memberUserId,
    ),
  ],
);

export const appConfig = pgTable('app_config', {
  key: text().primaryKey().notNull(),
  value: jsonb().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const incidentEvents = pgTable(
  'incident_events',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    incidentId: uuid('incident_id').notNull(),
    eventType: text('event_type').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    actorId: uuid('actor_id'),
    detail: jsonb().default({}).notNull(),
  },
  (table) => [
    index('incident_events_incident_occurred_idx').using(
      'btree',
      table.incidentId.asc().nullsLast(),
      table.occurredAt.asc().nullsLast(),
    ),
    uniqueIndex('incident_events_once_per_incident_uidx')
      .using('btree', table.incidentId.asc().nullsLast(), table.eventType.asc().nullsLast())
      .where(
        sql`(event_type = ANY (ARRAY['alert_sent'::text, 'location_sharing_started'::text, 'location_sharing_ended'::text, 'safe_recorded'::text, 'incident_closed'::text, 'closure_notified'::text]))`,
      ),
    foreignKey({
      columns: [table.incidentId],
      foreignColumns: [incidents.id],
      name: 'incident_events_incident_id_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.actorId],
      foreignColumns: [profiles.id],
      name: 'incident_events_actor_id_fkey',
    }).onDelete('set null'),
    check(
      'incident_events_type_allowed',
      sql`event_type = ANY (ARRAY['alert_sent'::text, 'renotified'::text, 'location_sharing_started'::text, 'location_sharing_ended'::text, 'safe_recorded'::text, 'incident_closed'::text, 'closure_notified'::text, 'status_update'::text, 'responder_acknowledged'::text, 'responder_status'::text])`,
    ),
    check('incident_events_detail_object', sql`jsonb_typeof(detail) = 'object'::text`),
  ],
);

export const incidents = pgTable(
  'incidents',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    residentId: uuid('resident_id').notNull(),
    circleId: uuid('circle_id'),
    status: text().notNull(),
    activatedAt: timestamp('activated_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    emergencyType: text('emergency_type').default('unspecified').notNull(),
    locationLat: doublePrecision('location_lat'),
    locationLng: doublePrecision('location_lng'),
    locationAccuracyM: doublePrecision('location_accuracy_m'),
    locationCapturedAt: timestamp('location_captured_at', { withTimezone: true, mode: 'string' }),
    locationSource: text('location_source'),
    cancelledAt: timestamp('cancelled_at', { withTimezone: true, mode: 'string' }),
    sentAt: timestamp('sent_at', { withTimezone: true, mode: 'string' }),
    sharePayload: jsonb('share_payload'),
    incidentNotes: text('incident_notes'),
    incidentNotesUpdatedAt: timestamp('incident_notes_updated_at', {
      withTimezone: true,
      mode: 'string',
    }),
    renotifiedAt: timestamp('renotified_at', { withTimezone: true, mode: 'string' }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'string' }),
    resolvedReason: text('resolved_reason'),
    autoClosed: boolean('auto_closed').default(false).notNull(),
    activityConfirmedAt: timestamp('activity_confirmed_at', { withTimezone: true, mode: 'string' }),
    locationSharingEndedAt: timestamp('location_sharing_ended_at', {
      withTimezone: true,
      mode: 'string',
    }),
    liveSharePayload: jsonb('live_share_payload'),
    liveShareUpdatedAt: timestamp('live_share_updated_at', { withTimezone: true, mode: 'string' }),
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    index('incidents_circle_id_idx')
      .using('btree', table.circleId.asc().nullsLast())
      .where(sql`(circle_id IS NOT NULL)`),
    uniqueIndex('incidents_one_open_per_resident_uidx')
      .using('btree', table.residentId.asc().nullsLast())
      .where(sql`(status = ANY (ARRAY['activating'::text, 'active'::text]))`),
    index('incidents_resident_id_idx').using('btree', table.residentId.asc().nullsLast()),
    index('incidents_resolved_at_resolved_idx')
      .using('btree', table.resolvedAt.asc().nullsLast())
      .where(sql`(status = 'resolved'::text)`),
    foreignKey({
      columns: [table.residentId],
      foreignColumns: [profiles.id],
      name: 'incidents_resident_id_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.circleId],
      foreignColumns: [safetyCircles.id],
      name: 'incidents_circle_id_fkey',
    }).onDelete('set null'),
    check(
      'incidents_status_allowed',
      sql`status = ANY (ARRAY['activating'::text, 'active'::text, 'cancelled'::text, 'resolved'::text, 'closed'::text])`,
    ),
    check(
      'incidents_location_source_allowed',
      sql`(location_source IS NULL) OR (location_source = ANY (ARRAY['current'::text, 'last_known'::text, 'unavailable'::text]))`,
    ),
    check(
      'incidents_location_shape',
      sql`((location_source IS NULL) AND (location_lat IS NULL) AND (location_lng IS NULL) AND (location_accuracy_m IS NULL) AND (location_captured_at IS NULL)) OR ((location_source = 'unavailable'::text) AND (location_lat IS NULL) AND (location_lng IS NULL) AND (location_accuracy_m IS NULL) AND (location_captured_at IS NULL)) OR ((location_source = ANY (ARRAY['current'::text, 'last_known'::text])) AND (location_lat IS NOT NULL) AND (location_lng IS NOT NULL) AND (location_captured_at IS NOT NULL) AND (location_lat >= ('-90'::integer)::double precision) AND (location_lat <= (90)::double precision) AND (location_lng >= ('-180'::integer)::double precision) AND (location_lng <= (180)::double precision) AND ((location_accuracy_m IS NULL) OR (location_accuracy_m >= (0)::double precision)) AND ((location_source = 'last_known'::text) OR (location_accuracy_m IS NOT NULL)))`,
    ),
    check(
      'incidents_share_payload_object',
      sql`(share_payload IS NULL) OR (jsonb_typeof(share_payload) = 'object'::text)`,
    ),
    check(
      'incidents_incident_notes_length',
      sql`(incident_notes IS NULL) OR (char_length(incident_notes) <= 250)`,
    ),
    check(
      'incidents_resolved_reason_check',
      sql`(resolved_reason IS NULL) OR (resolved_reason = ANY (ARRAY['safe'::text, 'ended'::text]))`,
    ),
    check(
      'incidents_resolved_shape_check',
      sql`((status = ANY (ARRAY['resolved'::text, 'closed'::text])) AND (resolved_at IS NOT NULL) AND (resolved_reason IS NOT NULL)) OR ((status <> ALL (ARRAY['resolved'::text, 'closed'::text])) AND (resolved_at IS NULL) AND (resolved_reason IS NULL) AND (auto_closed = false))`,
    ),
    check(
      'incidents_emergency_type_allowed',
      sql`emergency_type = ANY (ARRAY['medical'::text, 'domestic_violence'::text, 'fire'::text, 'burglary'::text, 'other'::text, 'unspecified'::text])`,
    ),
    check(
      'incidents_location_sharing_ended_shape',
      sql`(location_sharing_ended_at IS NULL) OR (status = ANY (ARRAY['resolved'::text, 'closed'::text]))`,
    ),
    check(
      'incidents_closed_shape',
      sql`((status = 'closed'::text) = (closed_at IS NOT NULL)) AND ((status <> 'closed'::text) OR (resolved_reason = ANY (ARRAY['safe'::text, 'ended'::text])))`,
    ),
  ],
);

export const safetyCircleMembers = pgTable(
  'safety_circle_members',
  {
    id: uuid().defaultRandom().primaryKey().notNull(),
    circleId: uuid('circle_id').notNull(),
    role: text().notNull(),
    status: text().notNull(),
    displayName: text('display_name').notNull(),
    relationship: text(),
    phone: text(),
    email: text(),
    userId: uuid('user_id'),
    invitedAt: timestamp('invited_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    inviteToken: text('invite_token'),
    inviteExpiresAt: timestamp('invite_expires_at', { withTimezone: true, mode: 'string' }),
    inviteConsumedAt: timestamp('invite_consumed_at', { withTimezone: true, mode: 'string' }),
    inviteCanceledAt: timestamp('invite_canceled_at', { withTimezone: true, mode: 'string' }),
    activatedAt: timestamp('activated_at', { withTimezone: true, mode: 'string' }),
    endedAt: timestamp('ended_at', { withTimezone: true, mode: 'string' }),
  },
  (table) => [
    index('safety_circle_members_circle_id_idx').using('btree', table.circleId.asc().nullsLast()),
    uniqueIndex('safety_circle_members_circle_phone_uidx')
      .using('btree', table.circleId.asc().nullsLast(), table.phone.asc().nullsLast())
      .where(sql`(phone IS NOT NULL)`),
    uniqueIndex('safety_circle_members_circle_user_uidx')
      .using('btree', table.circleId.asc().nullsLast(), table.userId.asc().nullsLast())
      .where(sql`(user_id IS NOT NULL)`),
    uniqueIndex('safety_circle_members_invite_token_uidx')
      .using('btree', table.inviteToken.asc().nullsLast())
      .where(sql`(invite_token IS NOT NULL)`),
    uniqueIndex('safety_circle_members_one_owner_uidx')
      .using('btree', table.circleId.asc().nullsLast())
      .where(sql`(role = 'owner'::text)`),
    index('safety_circle_members_phone_list_idx')
      .using('btree', table.phone.asc().nullsLast())
      .where(sql`((phone IS NOT NULL) AND (role = 'member'::text))`),
    index('safety_circle_members_user_id_idx')
      .using('btree', table.userId.asc().nullsLast())
      .where(sql`(user_id IS NOT NULL)`),
    foreignKey({
      columns: [table.circleId],
      foreignColumns: [safetyCircles.id],
      name: 'safety_circle_members_circle_id_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [authUsers.id],
      name: 'safety_circle_members_user_id_fkey',
    }).onDelete('set null'),
    check(
      'safety_circle_members_pending_invite_token',
      sql`(role <> 'member'::text) OR (status <> 'pending'::text) OR ((invite_token IS NOT NULL) AND (char_length(invite_token) >= 32) AND (invite_expires_at IS NOT NULL))`,
    ),
    check(
      'safety_circle_members_role_allowed',
      sql`role = ANY (ARRAY['owner'::text, 'member'::text])`,
    ),
    check(
      'safety_circle_members_status_allowed',
      sql`status = ANY (ARRAY['pending'::text, 'active'::text, 'declined'::text, 'removed'::text, 'left'::text])`,
    ),
    check(
      'safety_circle_members_display_name_nonempty',
      sql`char_length(TRIM(BOTH FROM display_name)) > 0`,
    ),
    check(
      'safety_circle_members_relationship_allowed',
      sql`(relationship IS NULL) OR (relationship = ANY (ARRAY['spouse'::text, 'partner'::text, 'parent'::text, 'child'::text, 'sibling'::text, 'friend'::text, 'other'::text]))`,
    ),
    check(
      'safety_circle_members_phone_e164',
      sql`(phone IS NULL) OR (phone ~ '^\+[1-9][0-9]{7,14}$'::text)`,
    ),
    check(
      'safety_circle_members_owner_shape',
      sql`((role = 'owner'::text) AND (status = 'active'::text) AND (user_id IS NOT NULL)) OR (role = 'member'::text)`,
    ),
    check(
      'safety_circle_members_activated_shape',
      sql`((status = 'active'::text) AND (activated_at IS NOT NULL)) OR ((status <> 'active'::text) AND (activated_at IS NULL))`,
    ),
    check(
      'safety_circle_members_ended_shape',
      sql`(status = ANY (ARRAY['removed'::text, 'left'::text])) = (ended_at IS NOT NULL)`,
    ),
  ],
);

export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial({ mode: 'bigint' }).primaryKey().notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    actorUserId: uuid('actor_user_id'),
    actorSessionId: uuid('actor_session_id'),
    action: text().notNull(),
    targetType: text('target_type'),
    targetId: uuid('target_id'),
    ip: inet(),
    requestId: text('request_id'),
    detail: jsonb().default({}).notNull(),
  },
  (table) => [
    index('audit_log_actor_idx')
      .using('btree', table.actorUserId.asc().nullsLast(), table.occurredAt.asc().nullsLast())
      .where(sql`(actor_user_id IS NOT NULL)`),
    index('audit_log_occurred_at_idx').using('btree', table.occurredAt.asc().nullsLast()),
    index('audit_log_target_idx')
      .using(
        'btree',
        table.targetType.asc().nullsLast(),
        table.targetId.asc().nullsLast(),
        table.occurredAt.asc().nullsLast(),
      )
      .where(sql`(target_id IS NOT NULL)`),
    check('audit_log_action_check', sql`length(btrim(action)) > 0`),
    check('audit_log_detail_check', sql`jsonb_typeof(detail) = 'object'::text`),
  ],
);

export const idempotencyKeys = pgTable(
  'idempotency_keys',
  {
    userId: uuid('user_id').notNull(),
    key: text().notNull(),
    method: text().notNull(),
    path: text().notNull(),
    requestHash: text('request_hash').notNull(),
    status: text().notNull(),
    responseStatus: integer('response_status'),
    responseBody: jsonb('response_body'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' })
      .defaultNow()
      .notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
  },
  (table) => [
    index('idempotency_keys_expires_at_idx').using('btree', table.expiresAt.asc().nullsLast()),
    primaryKey({ columns: [table.userId, table.key], name: 'idempotency_keys_pkey' }),
    check(
      'idempotency_keys_status_check',
      sql`status = ANY (ARRAY['in_progress'::text, 'completed'::text])`,
    ),
  ],
);
