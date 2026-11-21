import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';

import { type AuthTx, firstRow } from './auth-transaction';
import type { HashAlgorithm, StoredHash } from './password-hasher';

/** `User` of spec §11.3 A17. Timestamps are UTC text (the transaction sets `TimeZone`). */
export interface UserJson {
  id: string;
  email: string | null;
  phone: string | null;
  email_confirmed_at: string | null;
  phone_confirmed_at: string | null;
  created_at: string;
  identities: { provider: string; created_at: string }[];
}

/** What sign-in code needs to know about a user row. */
export interface UserRow {
  id: string;
  email: string | null;
  phone: string | null;
  email_confirmed: boolean;
  phone_confirmed: boolean;
  disabled: boolean;
}

export type IdentityProvider = 'email' | 'phone' | 'google' | 'apple';

const USER_COLUMNS = sql`u.id::text as id, u.email::text as email, u.phone,
  (u.email_confirmed_at is not null) as email_confirmed,
  (u.phone_confirmed_at is not null) as phone_confirmed,
  (u.disabled_at is not null) as disabled`;

/**
 * `public.users`, `user_credentials` and `user_identities` (migration 0008). Every statement runs in
 * the caller's transaction; secrets travel only as query parameters.
 */
@Injectable()
export class UsersRepository {
  async byId(tx: AuthTx, id: string, lock = false): Promise<UserRow | undefined> {
    return firstRow<UserRow>(
      await tx.execute(
        lock
          ? sql`select ${USER_COLUMNS} from public.users u where u.id = ${id}::uuid for update`
          : sql`select ${USER_COLUMNS} from public.users u where u.id = ${id}::uuid`,
      ),
    );
  }

  /** By email (citext: case-insensitive). */
  async byEmail(tx: AuthTx, email: string): Promise<UserRow | undefined> {
    return firstRow<UserRow>(
      await tx.execute(
        sql`select ${USER_COLUMNS} from public.users u where u.email = ${email}::extensions.citext`,
      ),
    );
  }

  async byPhone(tx: AuthTx, phone: string): Promise<UserRow | undefined> {
    return firstRow<UserRow>(
      await tx.execute(sql`select ${USER_COLUMNS} from public.users u where u.phone = ${phone}`),
    );
  }

  async phoneTaken(tx: AuthTx, phone: string): Promise<boolean> {
    const row = firstRow<{ taken: boolean }>(
      await tx.execute(
        sql`select exists (select 1 from public.users where phone = ${phone}) as taken`,
      ),
    );
    return row?.taken === true;
  }

  /**
   * A new user. Returns the id, or undefined when a unique email or phone conflicts (a concurrent
   * sign-up of the same address: the caller decides).
   */
  async insert(
    tx: AuthTx,
    values: {
      id?: string;
      email: string | null;
      phone: string | null;
      emailConfirmed?: boolean;
      metadata: Record<string, unknown>;
    },
  ): Promise<string | undefined> {
    const row = firstRow<{ id: string }>(
      await tx.execute(sql`
        insert into public.users (id, email, phone, email_confirmed_at, metadata)
        values (coalesce(${values.id ?? null}::uuid, gen_random_uuid()),
                ${values.email}::extensions.citext, ${values.phone}::text,
                case when ${values.emailConfirmed === true}::boolean then now() end,
                ${JSON.stringify(values.metadata)}::jsonb)
        on conflict do nothing
        returning id::text as id`),
    );
    return row?.id;
  }

  async confirmEmail(tx: AuthTx, userId: string): Promise<boolean> {
    const row = firstRow<{ newly: boolean }>(
      await tx.execute(sql`
        update public.users
           set email_confirmed_at = coalesce(email_confirmed_at, now()),
               updated_at = now()
         where id = ${userId}::uuid
        returning (email_confirmed_at = now()) as newly`),
    );
    return row?.newly === true;
  }

  async confirmPhone(tx: AuthTx, userId: string): Promise<void> {
    await tx.execute(sql`
      update public.users
         set phone_confirmed_at = coalesce(phone_confirmed_at, now()), updated_at = now()
       where id = ${userId}::uuid`);
  }

  async credentialOf(tx: AuthTx, userId: string): Promise<StoredHash | undefined> {
    const row = firstRow<{ hash: string; algo: HashAlgorithm }>(
      await tx.execute(sql`
        select password_hash as hash, hash_algo as algo
          from public.user_credentials where user_id = ${userId}::uuid`),
    );
    return row ? { hash: row.hash, algo: row.algo } : undefined;
  }

  /** Sets (or replaces) the password hash. */
  async setCredential(tx: AuthTx, userId: string, stored: StoredHash): Promise<void> {
    await tx.execute(sql`
      insert into public.user_credentials (user_id, password_hash, hash_algo, password_updated_at)
      values (${userId}::uuid, ${stored.hash}, ${stored.algo}, now())
      on conflict (user_id) do update
         set password_hash = excluded.password_hash,
             hash_algo = excluded.hash_algo,
             password_updated_at = now()`);
  }

  /** Replaces a hash only while it is still the one that was verified (bcrypt → argon2id). */
  async rehashCredential(
    tx: AuthTx,
    userId: string,
    previous: StoredHash,
    next: StoredHash,
  ): Promise<boolean> {
    const result = await tx.execute(sql`
      update public.user_credentials
         set password_hash = ${next.hash}, hash_algo = ${next.algo}
       where user_id = ${userId}::uuid
         and password_hash = ${previous.hash}
         and hash_algo = ${previous.algo}`);
    return (result.rowCount ?? 0) > 0;
  }

  /** Adds an identity; nothing when `(provider, subject)` exists. */
  async addIdentity(
    tx: AuthTx,
    userId: string,
    provider: IdentityProvider,
    subject: string,
    email: string | null,
  ): Promise<void> {
    await tx.execute(sql`
      insert into public.user_identities (user_id, provider, provider_subject, email, last_sign_in_at)
      values (${userId}::uuid, ${provider}, ${subject}, ${email}::extensions.citext, now())
      on conflict (provider, provider_subject) do nothing`);
  }

  /** The user of an external identity, with the identity marked as just used. */
  async userOfIdentity(
    tx: AuthTx,
    provider: IdentityProvider,
    subject: string,
  ): Promise<string | undefined> {
    const row = firstRow<{ user_id: string }>(
      await tx.execute(sql`
        update public.user_identities
           set last_sign_in_at = now()
         where provider = ${provider} and provider_subject = ${subject}
        returning user_id::text as user_id`),
    );
    return row?.user_id;
  }

  /** `User` JSON (spec §11.3 A17) of one user. */
  async userJson(tx: AuthTx, userId: string): Promise<UserJson | undefined> {
    const row = firstRow<{ user: UserJson }>(
      await tx.execute(sql`
        select jsonb_build_object(
                 'id', u.id,
                 'email', u.email::text,
                 'phone', u.phone,
                 'email_confirmed_at', u.email_confirmed_at,
                 'phone_confirmed_at', u.phone_confirmed_at,
                 'created_at', u.created_at,
                 'identities', coalesce((
                   select jsonb_agg(jsonb_build_object('provider', i.provider,
                                                       'created_at', i.created_at)
                                    order by i.created_at, i.provider)
                     from public.user_identities i
                    where i.user_id = u.id), '[]'::jsonb)
               ) as "user"
          from public.users u
         where u.id = ${userId}::uuid`),
    );
    return row?.user;
  }
}
