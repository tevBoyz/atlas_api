import { Injectable } from '@nestjs/common';
import { type SQL, sql } from 'drizzle-orm';

import { normalizeE164Sql } from '../../common/policies';
import { DatabaseService } from '../../db/database.service';
import { type AuthTx, firstRow, runAuthTransaction } from './auth-transaction';

/**
 * Users of Supabase Auth → the API's own tables (API-100-58, spec §12.1): `auth.users` → `users`
 * (same ids, email lower-case, phone `+E.164`, confirmations, `created_at`, metadata),
 * `auth.identities` → `user_identities`, bcrypt `encrypted_password` → `user_credentials`
 * (`hash_algo = 'bcrypt'`, re-hashed to argon2id at the next sign-in).
 *
 * Idempotent and repeatable: a row already in `users` keeps everything the API owns (email, phone,
 * metadata); only a confirmation Supabase has and the API not yet is added. A credential the API
 * already re-hashed (argon2id) is never replaced; a bcrypt one follows a newer Supabase hash.
 * Conflicts are never fatal: an email or phone held by another user (or by an older account with
 * the same number) is left out and counted, so the run reports it.
 *
 * Used by the batch job (`npm run auth:migrate-users`) and, for one user at a time, just in time at
 * sign-up, sign-in, the session exchange and `GET /v1/me`, so an account created through the old app
 * after the last batch run is never duplicated. Never logs an email, a phone or a hash.
 */

/** Counts of one run (all numbers; no personal data). */
export interface MigrationReport {
  auth_users: number;
  skipped_anonymous: number;
  skipped_deleted: number;
  users_inserted: number;
  users_already_present: number;
  confirmations_added: number;
  credentials_inserted: number;
  credentials_updated: number;
  credentials_kept_argon2id: number;
  without_password: number;
  identities_inserted: number;
  auth_identities_table: boolean;
  conflicts: {
    missing_email: number;
    invalid_email: number;
    duplicate_email: number;
    invalid_phone: number;
    duplicate_phone: number;
  };
}

const BCRYPT_SQL = '^\\$2[aby]\\$[0-9]{2}\\$.{53}$';
const EMAIL_SQL = '^[^@\\s]+@[^@\\s]+$';
const E164_SQL = '^\\+[1-9][0-9]{7,14}$';

/** The Supabase users of a run: one id, or everyone. Anonymous and deleted users are left out. */
function sourceCte(filter: SQL): SQL {
  return sql`
    src as (
      select au.id, au.created_at, au.updated_at, au.email_confirmed_at, au.phone_confirmed_at,
             case when jsonb_typeof(au.raw_user_meta_data) = 'object'
                  then au.raw_user_meta_data else '{}'::jsonb end as metadata,
             nullif(lower(btrim(coalesce(au.email, ''))), '') as email_raw,
             ${normalizeE164Sql(sql`au.phone`)} as phone_raw
        from auth.users au
       where coalesce(au.is_anonymous, false) = false
         and au.deleted_at is null
         and ${filter}
    ),
    checked as (
      select s.*,
             case when s.email_raw ~ ${EMAIL_SQL} and length(s.email_raw) <= 254
                  then s.email_raw end as email_ok,
             case when s.phone_raw ~ ${E164_SQL} then s.phone_raw end as phone_ok
        from src s
    ),
    ranked as (
      select c.*,
             row_number() over (partition by c.email_ok order by c.created_at nulls last, c.id)
               as email_rank,
             -- spec rule 44's tie-break: a user with a usable email first, then the oldest.
             row_number() over (partition by c.phone_ok
                                order by (c.email_ok is null), c.created_at nulls last, c.id)
               as phone_rank
        from checked c
    ),
    resolved as (
      select r.*,
             case when r.email_ok is not null and r.email_rank = 1
                   and not exists (select 1 from public.users u
                                    where u.email = r.email_ok::extensions.citext and u.id <> r.id)
                  then r.email_ok end as email_new,
             case when r.phone_ok is not null and r.phone_rank = 1
                   and not exists (select 1 from public.users u
                                    where u.phone = r.phone_ok and u.id <> r.id)
                  then r.phone_ok end as phone_new
        from ranked r
    )`;
}

@Injectable()
export class LegacyUsers {
  private authUsersPresent?: Promise<boolean>;

  constructor(private readonly database: DatabaseService) {}

  /** True when `auth.users` exists (Supabase); a plain Postgres has nothing to migrate. */
  private hasAuthUsers(): Promise<boolean> {
    this.authUsersPresent ??= this.database
      .query<{ present: boolean }>(`select to_regclass('auth.users') is not null as present`)
      .then((rows) => rows[0]?.present === true)
      .catch(() => {
        this.authUsersPresent = undefined;
        return false;
      });
    return this.authUsersPresent;
  }

  /** JIT: the Supabase user of this email, when it is not in `users` yet. */
  async migrateByEmail(email: string): Promise<void> {
    if (!(await this.hasAuthUsers())) return;
    const rows = await this.database.query<{ id: string }>(
      `select au.id::text as id from auth.users au
        where au.email = $1
          and not exists (select 1 from public.users u where u.id = au.id)
          and not exists (select 1 from public.users u where u.email = $1::extensions.citext)
        limit 1`,
      [email],
    );
    if (rows[0]) await this.migrateById(rows[0].id);
  }

  /** JIT: the Supabase user of this phone (rule 44 tie-break), when it is not in `users` yet. */
  async migrateByPhone(phone: string): Promise<void> {
    if (!(await this.hasAuthUsers())) return;
    const rows = await this.database.query<{ id: string }>(
      `select au.id::text as id from auth.users au
        where au.phone in ($1, substr($1, 2))
          and not exists (select 1 from public.users u where u.id = au.id)
          and not exists (select 1 from public.users u where u.phone = $1)
        order by (nullif(btrim(coalesce(au.email, '')), '') is null), au.created_at nulls last
        limit 1`,
      [phone],
    );
    if (rows[0]) await this.migrateById(rows[0].id);
  }

  /** JIT: one Supabase user by id (no-op when already migrated and unchanged). */
  async migrateById(id: string): Promise<boolean> {
    if (!(await this.hasAuthUsers())) return false;
    const report = await runAuthTransaction(this.database, (tx) =>
      this.run(tx, sql`au.id = ${id}::uuid`),
    );
    return report.auth_users > 0;
  }

  /** The whole migration in the caller's transaction (the job commits or, dry run, rolls back). */
  async run(tx: AuthTx, filter: SQL = sql`true`): Promise<MigrationReport> {
    const counts = firstRow<Record<string, number>>(
      await tx.execute(sql`
        with ${sourceCte(filter)}
        select
          (select count(*)::int from auth.users au where ${filter}) as auth_users,
          (select count(*)::int from auth.users au
            where ${filter} and coalesce(au.is_anonymous, false)) as skipped_anonymous,
          (select count(*)::int from auth.users au
            where ${filter} and not coalesce(au.is_anonymous, false)
              and au.deleted_at is not null) as skipped_deleted,
          count(*) filter (where email_raw is null)::int as missing_email,
          count(*) filter (where email_raw is not null and email_ok is null)::int as invalid_email,
          count(*) filter (where email_ok is not null and email_new is null)::int as duplicate_email,
          count(*) filter (where phone_raw is not null and phone_ok is null)::int as invalid_phone,
          count(*) filter (where phone_ok is not null and phone_new is null)::int as duplicate_phone,
          count(*) filter (where exists (select 1 from public.users u where u.id = resolved.id))::int
            as users_already_present
          from resolved`),
    )!;

    const users = await tx.execute(sql`
      with ${sourceCte(filter)}
      insert into public.users (id, email, email_confirmed_at, phone, phone_confirmed_at,
                                created_at, updated_at, metadata)
      select r.id, r.email_new::extensions.citext, r.email_confirmed_at, r.phone_new,
             r.phone_confirmed_at, coalesce(r.created_at, now()), coalesce(r.updated_at, now()),
             r.metadata
        from resolved r
      on conflict (id) do update
         set email_confirmed_at = coalesce(public.users.email_confirmed_at,
                                           excluded.email_confirmed_at),
             phone_confirmed_at = coalesce(public.users.phone_confirmed_at,
                                           excluded.phone_confirmed_at),
             updated_at = now()
       where (public.users.email_confirmed_at is null and excluded.email_confirmed_at is not null
              and public.users.email is not null)
          or (public.users.phone_confirmed_at is null and excluded.phone_confirmed_at is not null
              and public.users.phone is not null)
      returning (xmax = 0) as inserted`);
    const userRows = users.rows as { inserted: boolean }[];

    const credentials = await tx.execute(sql`
      insert into public.user_credentials (user_id, password_hash, hash_algo, password_updated_at)
      select au.id, au.encrypted_password, 'bcrypt', coalesce(au.updated_at, now())
        from auth.users au
        join public.users u on u.id = au.id
       where ${filter}
         and coalesce(au.is_anonymous, false) = false and au.deleted_at is null
         and au.encrypted_password ~ ${BCRYPT_SQL}
      on conflict (user_id) do update
         set password_hash = excluded.password_hash,
             password_updated_at = excluded.password_updated_at
       where public.user_credentials.hash_algo = 'bcrypt'
         and public.user_credentials.password_hash <> excluded.password_hash
      returning (xmax = 0) as inserted`);
    const credentialRows = credentials.rows as { inserted: boolean }[];

    const credentialState = firstRow<{ kept: number; without: number }>(
      await tx.execute(sql`
        select count(*) filter (where c.hash_algo = 'argon2id' and au.encrypted_password ~ ${BCRYPT_SQL})::int as kept,
               count(*) filter (where c.user_id is null)::int as without
          from auth.users au
          join public.users u on u.id = au.id
          left join public.user_credentials c on c.user_id = au.id
         where ${filter}
           and coalesce(au.is_anonymous, false) = false and au.deleted_at is null`),
    )!;

    const hasIdentities =
      firstRow<{ present: boolean }>(
        await tx.execute(sql`select to_regclass('auth.identities') is not null as present`),
      )?.present === true;
    let identitiesInserted = 0;
    if (hasIdentities) identitiesInserted += await this.copyIdentities(tx, filter);
    // Every migrated user with an email / phone has that identity (as API sign-ups do).
    const own = await tx.execute(sql`
      insert into public.user_identities (user_id, provider, provider_subject, email, created_at)
      select u.id, p.provider, u.id::text, case when p.provider = 'email' then u.email end,
             coalesce(au.created_at, now())
        from auth.users au
        join public.users u on u.id = au.id
        cross join lateral (values ('email', u.email is not null), ('phone', u.phone is not null))
          as p(provider, applies)
       where ${filter} and p.applies
         and not exists (select 1 from public.user_identities i
                          where i.user_id = u.id and i.provider = p.provider)
      on conflict (provider, provider_subject) do nothing`);
    identitiesInserted += own.rowCount ?? 0;

    return {
      auth_users: counts.auth_users,
      skipped_anonymous: counts.skipped_anonymous,
      skipped_deleted: counts.skipped_deleted,
      users_inserted: userRows.filter((r) => r.inserted).length,
      users_already_present: counts.users_already_present,
      confirmations_added: userRows.filter((r) => !r.inserted).length,
      credentials_inserted: credentialRows.filter((r) => r.inserted).length,
      credentials_updated: credentialRows.filter((r) => !r.inserted).length,
      credentials_kept_argon2id: credentialState.kept,
      without_password: credentialState.without,
      identities_inserted: identitiesInserted,
      auth_identities_table: hasIdentities,
      conflicts: {
        missing_email: counts.missing_email,
        invalid_email: counts.invalid_email,
        duplicate_email: counts.duplicate_email,
        invalid_phone: counts.invalid_phone,
        duplicate_phone: counts.duplicate_phone,
      },
    };
  }

  /** `auth.identities` of Google / Apple / email / phone → `user_identities` (subject = provider id). */
  private async copyIdentities(tx: AuthTx, filter: SQL): Promise<number> {
    const hasProviderId =
      firstRow<{ present: boolean }>(
        await tx.execute(sql`
          select exists (select 1 from information_schema.columns
                          where table_schema = 'auth' and table_name = 'identities'
                            and column_name = 'provider_id') as present`),
      )?.present === true;
    const subject = hasProviderId
      ? sql`coalesce(nullif(i.provider_id, ''), i.identity_data ->> 'sub', au.id::text)`
      : sql`coalesce(i.identity_data ->> 'sub', i.id::text, au.id::text)`;
    const result = await tx.execute(sql`
      insert into public.user_identities (user_id, provider, provider_subject, email, created_at,
                                          last_sign_in_at)
      select au.id, i.provider,
             case when i.provider in ('email', 'phone') then au.id::text else ${subject} end,
             case when lower(btrim(coalesce(i.identity_data ->> 'email', ''))) ~ ${EMAIL_SQL}
                  then lower(btrim(i.identity_data ->> 'email'))::extensions.citext end,
             coalesce(i.created_at, au.created_at, now()), i.last_sign_in_at
        from auth.identities i
        join auth.users au on au.id = i.user_id
        join public.users u on u.id = au.id
       where ${filter} and i.provider in ('email', 'phone', 'google', 'apple')
      on conflict (provider, provider_subject) do nothing`);
    return result.rowCount ?? 0;
  }
}
