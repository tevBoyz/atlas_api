-- Phase 7 stage 7.1a (D36, D37): the foreign keys of `profiles.id`, `safety_circle_members.user_id`
-- and `user_devices.user_id` point at the API's own `public.users` instead of `auth.users`, so an
-- account created by API sign-up or by a first Google / Apple sign-in (no `auth.users` row) can
-- write its profile, its circle rows and its devices.
--
-- Order:
-- 1. `api_ensure_user_row(id)`: moves ONE `auth.users` row into `public.users` when that id is not
--    there yet, with the rules of the user migration (D34): email `lower(btrim())` when usable,
--    phone `+E.164` when strict, an email or phone another user already holds left out; metadata,
--    confirmations and `created_at` copied; a bcrypt `encrypted_password` becomes a `bcrypt`
--    credential; an `email` / `phone` identity for the email / phone kept. A user Supabase marked
--    deleted gets a disabled row. Never writes `auth.users`; never changes an existing row.
-- 2. Back-fill: every `auth.users` id not yet in `public.users`, oldest first (a usable email
--    first, as rule 44), so no existing row breaks the new foreign keys. Counts are raised as a
--    NOTICE (numbers only). Run `npm run auth:migrate-users` before this migration on a database
--    with Supabase users: the batch also copies Google / Apple identities (`auth.identities`).
-- 3. The three foreign keys are dropped and added again with the SAME names (the API maps
--    `profiles_id_fkey` and the device write's 23503 to its error codes) and the same delete rules,
--    referencing `public.users (id)`.
-- 4. Compatibility for the old SQL functions (D37): until the Supabase app paths are retired, a row
--    can still be written for a user that exists only in `auth.users` (the SQL behaviour tests and
--    the parity suites create their users there, as today's app did). A BEFORE INSERT / UPDATE
--    trigger on each of the three tables runs `api_ensure_user_row` for the referenced id first, so
--    such a write keeps working. An id in neither table still fails the foreign key (23503).
--
-- Additive apart from the approved repoint (D36): two functions, three triggers, the constraints
-- re-created. Re-runnable on a fresh database after the baseline. The functions are SECURITY
-- DEFINER (the SQL functions write profiles and members as `authenticated`, which has no access to
-- `public.users`) with an empty search_path, and nobody but the owner may call them.

create or replace function public.api_ensure_user_row(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  au record;
  v_email text;
  v_phone text;
begin
  if p_id is null or exists (select 1 from public.users u where u.id = p_id) then
    return false;
  end if;
  if to_regclass('auth.users') is null then
    return false;
  end if;

  select a.id, a.email, a.phone, a.encrypted_password, a.email_confirmed_at, a.phone_confirmed_at,
         a.created_at, a.updated_at, a.deleted_at,
         case when jsonb_typeof(a.raw_user_meta_data) = 'object'
              then a.raw_user_meta_data else '{}'::jsonb end as metadata
    into au
    from auth.users a
   where a.id = p_id;
  if not found then
    return false;
  end if;

  v_email := nullif(lower(btrim(coalesce(au.email, ''))), '');
  if v_email is not null
     and (v_email !~ '^[^@\s]+@[^@\s]+$' or length(v_email) > 254
          or exists (select 1 from public.users u where u.email = v_email::extensions.citext)) then
    v_email := null;
  end if;

  -- `_normalize_e164` (spec rule 18): trimmed `+E.164` kept, 8-15 digits get a `+`.
  v_phone := nullif(btrim(coalesce(au.phone, '')), '');
  if v_phone is not null and v_phone ~ '^[1-9][0-9]{7,14}$' then
    v_phone := '+' || v_phone;
  end if;
  if v_phone is not null
     and (v_phone !~ '^\+[1-9][0-9]{7,14}$'
          or exists (select 1 from public.users u where u.phone = v_phone)) then
    v_phone := null;
  end if;

  insert into public.users (id, email, email_confirmed_at, phone, phone_confirmed_at, created_at,
                            updated_at, disabled_at, metadata)
  values (au.id, v_email::extensions.citext, au.email_confirmed_at, v_phone, au.phone_confirmed_at,
          coalesce(au.created_at, now()), coalesce(au.updated_at, now()), au.deleted_at,
          au.metadata)
  on conflict do nothing;
  if not found then
    -- A concurrent move of the same id (or, very rarely, of the same email / phone): nothing more.
    return exists (select 1 from public.users u where u.id = p_id);
  end if;

  if au.encrypted_password ~ '^\$2[aby]\$[0-9]{2}\$.{53}$' then
    insert into public.user_credentials (user_id, password_hash, hash_algo, password_updated_at)
    values (au.id, au.encrypted_password, 'bcrypt', coalesce(au.updated_at, now()))
    on conflict (user_id) do nothing;
  end if;

  insert into public.user_identities (user_id, provider, provider_subject, email, created_at)
  select au.id, p.provider, au.id::text,
         case when p.provider = 'email' then v_email::extensions.citext end,
         coalesce(au.created_at, now())
    from (values ('email', v_email is not null), ('phone', v_phone is not null))
           as p(provider, applies)
   where p.applies
  on conflict (provider, provider_subject) do nothing;

  return true;
end;
$$;

comment on function public.api_ensure_user_row(uuid) is
  'Phase 7 (D37): moves one auth.users row into public.users (D34 rules) when its id is missing there. Never writes auth.users. Internal: owner only.';

revoke all on function public.api_ensure_user_row(uuid) from public;
revoke all on function public.api_ensure_user_row(uuid) from anon;
revoke all on function public.api_ensure_user_row(uuid) from authenticated;

-- ---------------------------------------------------------------------------
-- 2. Back-fill (before the new foreign keys are checked)
-- ---------------------------------------------------------------------------

do $$
declare
  v_missing integer := 0;
  v_moved integer := 0;
  v_id uuid;
begin
  if to_regclass('auth.users') is null then
    raise notice 'users back-fill: no auth.users table, nothing to move';
    return;
  end if;
  for v_id in
    execute $q$
      select a.id from auth.users a
       where not exists (select 1 from public.users u where u.id = a.id)
       order by (nullif(btrim(coalesce(a.email, '')), '') is null), a.created_at nulls last, a.id
    $q$
  loop
    v_missing := v_missing + 1;
    if public.api_ensure_user_row(v_id) then
      v_moved := v_moved + 1;
    end if;
  end loop;
  raise notice 'users back-fill: % auth.users rows missing from users, % moved', v_missing, v_moved;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. The foreign keys, repointed (same names, same delete rules)
-- ---------------------------------------------------------------------------

alter table public.profiles
  drop constraint if exists profiles_id_fkey,
  add constraint profiles_id_fkey
    foreign key (id) references public.users (id) on delete cascade;

alter table public.safety_circle_members
  drop constraint if exists safety_circle_members_user_id_fkey,
  add constraint safety_circle_members_user_id_fkey
    foreign key (user_id) references public.users (id) on delete set null;

alter table public.user_devices
  drop constraint if exists user_devices_user_id_fkey,
  add constraint user_devices_user_id_fkey
    foreign key (user_id) references public.users (id) on delete cascade;

-- ---------------------------------------------------------------------------
-- 4. Compatibility trigger for rows of users that exist only in auth.users (D37)
-- ---------------------------------------------------------------------------

create or replace function public.api_ensure_user_row_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- TG_ARGV[0]: the column that references public.users (id or user_id).
  perform public.api_ensure_user_row((to_jsonb(new) ->> tg_argv[0])::uuid);
  return new;
end;
$$;

comment on function public.api_ensure_user_row_trigger() is
  'Phase 7 (D37): before a profiles / safety_circle_members / user_devices write, moves a user that exists only in auth.users into public.users, so the foreign key holds. Internal.';

revoke all on function public.api_ensure_user_row_trigger() from public;
revoke all on function public.api_ensure_user_row_trigger() from anon;
revoke all on function public.api_ensure_user_row_trigger() from authenticated;

create or replace trigger profiles_ensure_user_row
  before insert or update of id on public.profiles
  for each row
  execute function public.api_ensure_user_row_trigger('id');

create or replace trigger safety_circle_members_ensure_user_row
  before insert or update of user_id on public.safety_circle_members
  for each row
  when (new.user_id is not null)
  execute function public.api_ensure_user_row_trigger('user_id');

create or replace trigger user_devices_ensure_user_row
  before insert or update of user_id on public.user_devices
  for each row
  execute function public.api_ensure_user_row_trigger('user_id');
