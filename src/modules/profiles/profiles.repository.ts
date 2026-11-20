import { Injectable } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';

import { aliasColumn, profileSelf } from '../../common/policies';
import type { Database } from '../../db/database.service';
import { type AvatarUrlBase, avatarUrlSql } from '../circles/circles.repository';
import type { PersonalInfoInput } from './profile-input';
import { SHARE_FLAGS } from './profile.schemas';

/** Anything that runs SQL: the pool, an open transaction or one of its savepoints. */
export type ProfilesExecutor = Pick<Database, 'execute'>;

/** The open transaction of a profile write (SQL and the audit row). */
export type ProfileTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Profile (spec §4.2 + `avatar_url`), built by Postgres in the table's column order. */
export type ProfileJson = Record<string, unknown> & {
  id: string;
  avatar_path: string | null;
  avatar_url: string | null;
};

/**
 * Every `profiles` column of spec §4.2, in the table's column order (`attnum`, which is the order of
 * PostgREST's `select *` the app reads today). `test/int/profiles-read.int-spec.ts` checks the list
 * against the live table.
 */
export const PROFILE_COLUMNS = [
  'id',
  'full_name',
  'date_of_birth',
  'gender',
  'avatar_path',
  'personal_info_completed_at',
  'created_at',
  'updated_at',
  'alert_push_enabled',
  'alert_email_enabled',
  'alert_sms_enabled',
  'location_sharing_enabled',
  'hide_profile_from_non_members',
  'app_language',
  'timezone',
  'preferences_completed_at',
  'preferred_language',
  'emergency_contact_full_name',
  'emergency_contact_relationship',
  'emergency_contact_phone',
  'emergency_contact_email',
  'blood_type',
  'allergies',
  'medical_conditions',
  'emergency_preferred_language',
  'emergency_info_completed_at',
  'emergency_notes',
  'emergency_notes_shareable',
  'profile_setup_completed_at',
  'share_emergency_contact_full_name',
  'share_emergency_contact_relationship',
  'share_emergency_contact_phone',
  'share_emergency_contact_email',
  'share_blood_type',
  'share_allergies',
  'share_medical_conditions',
  'share_emergency_preferred_language',
] as const;

/**
 * The Profile JSON of the row `alias` (a `profiles` alias): `json_build_object` (json, so keys keep
 * this order) of every column, then `avatar_url` ({@link avatarUrlSql}, as `_avatars_public_url`).
 * Timestamps are the UTC text of the transaction's `TimeZone`; `date_of_birth` is `YYYY-MM-DD`.
 */
export function profileJsonSql(alias: string, avatars: AvatarUrlBase): SQL {
  const pairs = PROFILE_COLUMNS.map((column) => sql.raw(`'${column}', ${alias}.${column}`));
  return sql`json_build_object(
    ${sql.join(pairs, sql`, `)},
    'avatar_url', ${avatarUrlSql(aliasColumn(alias, 'avatar_path'), avatars)}
  )`;
}

/**
 * The SQL of the profile routes (API-100-34/35/37). Every statement is limited to the caller's own
 * row by `profile.self` (spec §11.4): there is no way to name another user's profile. Writes lock
 * only that row (the UPDATE / the upsert's row lock), as the app's direct table writes did.
 */
@Injectable()
export class ProfilesRepository {
  /** Timestamps in JSON as UTC text (`...+00:00`), as the hosted project's sessions write them. */
  async useUtcTimestamps(tx: ProfilesExecutor): Promise<void> {
    await tx.execute(sql`select set_config('TimeZone', 'UTC', true)`);
  }

  /** The caller's Profile; undefined when there is no row. */
  async read(
    tx: ProfilesExecutor,
    callerId: string,
    avatars: AvatarUrlBase,
  ): Promise<ProfileJson | undefined> {
    const result = await tx.execute<{ body: ProfileJson }>(sql`
      select ${profileJsonSql('p', avatars)} as body
        from public.profiles p
       where ${self('p', callerId)}`);
    return result.rows[0]?.body;
  }

  /**
   * P9: the caller's row locked `FOR UPDATE`; its current `avatar_path` (null without a photo).
   * Undefined when there is no row.
   */
  async lockAvatarPath(tx: ProfilesExecutor, callerId: string): Promise<string | null | undefined> {
    const result = await tx.execute<{ avatar_path: string | null }>(sql`
      select p.avatar_path
        from public.profiles p
       where ${self('p', callerId)}
         for update`);
    return result.rows.length === 0 ? undefined : result.rows[0].avatar_path;
  }

  /** The database's current date in UTC (= Africa/Banjul, spec §5.1), `YYYY-MM-DD`. */
  async today(tx: ProfilesExecutor): Promise<string> {
    const result = await tx.execute<{ today: string }>(
      sql`select (now() at time zone 'UTC')::date::text as today`,
    );
    return result.rows[0].today;
  }

  /**
   * P2: the app's `upsertPersonalInfo` (UPSERT on `id`) with the server owning the completion time:
   * creates the row (table defaults for everything else) or updates the four fields;
   * `personal_info_completed_at` keeps its first value (`now()` when null). `gender` / `avatar_path`
   * `undefined` keep the stored value (null on a new row). Locks the caller's row only.
   */
  async upsertPersonalInfo(
    tx: ProfilesExecutor,
    callerId: string,
    input: PersonalInfoInput,
    avatars: AvatarUrlBase,
  ): Promise<ProfileJson> {
    const keep = (column: string, value: string | null | undefined) =>
      value === undefined ? sql.raw(`p.${column}`) : sql`excluded.${sql.raw(column)}`;
    const result = await tx.execute<{ body: ProfileJson }>(sql`
      insert into public.profiles as p (
        id, full_name, date_of_birth, gender, avatar_path, personal_info_completed_at
      )
      values (
        ${callerId}::uuid, ${input.fullName}, ${input.dateOfBirth}::date,
        ${input.gender ?? null}::text, ${input.avatarPath ?? null}::text, now()
      )
      on conflict (id) do update
         set full_name = excluded.full_name,
             date_of_birth = excluded.date_of_birth,
             gender = ${keep('gender', input.gender)},
             avatar_path = ${keep('avatar_path', input.avatarPath)},
             personal_info_completed_at = coalesce(p.personal_info_completed_at, now())
       where ${self('p', callerId)}
      returning ${profileJsonSql('p', avatars)} as body`);
    return result.rows[0].body;
  }

  /**
   * One UPDATE of the caller's row: `values` (column → value, column names are constants of the
   * input parsers) and, when given, `completedColumn = coalesce(completedColumn, now())` (the first
   * value is kept: Settings edits never reset it). Undefined when the caller has no row.
   */
  async update(
    tx: ProfilesExecutor,
    callerId: string,
    values: Record<string, string | boolean | null>,
    completedColumn: CompletionColumn | undefined,
    avatars: AvatarUrlBase,
  ): Promise<ProfileJson | undefined> {
    const assignments = Object.entries(values).map(([column, value]) => {
      if (!WRITABLE_COLUMNS.has(column)) throw new Error(`profiles.${column} is not writable here`);
      return typeof value === 'boolean'
        ? sql`${sql.identifier(column)} = ${value}::boolean`
        : sql`${sql.identifier(column)} = ${value}::text`;
    });
    if (completedColumn) {
      assignments.push(
        sql`${sql.identifier(completedColumn)} = coalesce(${sql.raw(`p.${completedColumn}`)}, now())`,
      );
    }
    if (assignments.length === 0) return this.read(tx, callerId, avatars);
    const result = await tx.execute<{ body: ProfileJson }>(sql`
      update public.profiles as p
         set ${sql.join(assignments, sql`, `)}
       where ${self('p', callerId)}
      returning ${profileJsonSql('p', avatars)} as body`);
    return result.rows[0]?.body;
  }
}

/** The completion timestamps the server sets (never a client value). */
export type CompletionColumn = 'emergency_info_completed_at' | 'preferences_completed_at';

/**
 * Columns the profile writes may set from a request. Never `id`, `created_at`, `updated_at` (its
 * trigger), a completion timestamp or `profile_setup_completed_at` (spec §4.2 note, API-100-35 AC6).
 */
export const WRITABLE_COLUMNS: ReadonlySet<string> = new Set([
  'avatar_path',
  'alert_push_enabled',
  'alert_email_enabled',
  'alert_sms_enabled',
  'location_sharing_enabled',
  'hide_profile_from_non_members',
  'app_language',
  'timezone',
  'preferred_language',
  'emergency_contact_full_name',
  'emergency_contact_relationship',
  'emergency_contact_phone',
  'emergency_contact_email',
  'blood_type',
  'allergies',
  'medical_conditions',
  'emergency_preferred_language',
  'emergency_notes',
  ...SHARE_FLAGS,
]);

/** `profile.self` on the alias `alias`: the row is the caller's own. */
export function self(alias: string, callerId: string): SQL {
  return profileSelf.where({ profileId: aliasColumn(alias, 'id'), callerId });
}
