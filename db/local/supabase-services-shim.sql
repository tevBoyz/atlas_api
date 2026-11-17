-- LOCAL DEVELOPMENT ONLY (API-100-03). Never run against a hosted database.
--
-- Why: the supabase/postgres image ships the Supabase roles, the realtime publication and the
-- *initial* auth schema only. On a real Supabase project the GoTrue (Auth) and storage-api
-- services migrate their own schemas at startup. This repo runs Postgres + Redis only, so this
-- file adds the subset of those service-owned objects the 37 baseline migrations and 7 SQL tests
-- rely on, in the shape the services leave them:
--   - auth.users: phone / phone_confirmed_at / email_confirmed_at (+ generated confirmed_at) and
--     the other columns GoTrue adds (GoTrue migration 20210710035447_alter_users and later).
--   - auth.uid() / auth.role() / auth.email() / auth.jwt(): GoTrue's current definitions (read
--     both request.jwt.claim.* and request.jwt.claims).
--   - storage.buckets / storage.objects / storage.foldername(): storage-api's tables (subset of
--     columns), RLS enabled on objects.
--
-- How: docker-compose.yml mounts this file into the image's init folder as
-- /docker-entrypoint-initdb.d/migrations/99999999999999_atlas_local_shim.sql, so it runs once,
-- as supabase_admin, when the database volume is first created. Re-create the volume
-- ("docker compose down -v") after changing it.

-- ---------------------------------------------------------------------------
-- auth.users (GoTrue)
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select from information_schema.columns
     where table_schema = 'auth' and table_name = 'users' and column_name = 'email_confirmed_at'
  ) then
    alter table auth.users rename column confirmed_at to email_confirmed_at;
  end if;
  if exists (
    select from information_schema.columns
     where table_schema = 'auth' and table_name = 'users' and column_name = 'email_change_token'
  ) then
    alter table auth.users rename column email_change_token to email_change_token_new;
  end if;
end $$;

alter table auth.users
  add column if not exists phone text null unique default null,
  add column if not exists phone_confirmed_at timestamptz null default null,
  add column if not exists phone_change text null default '',
  add column if not exists phone_change_token varchar(255) null default '',
  add column if not exists phone_change_sent_at timestamptz null default null,
  add column if not exists email_change_token_current varchar(255) null default '',
  add column if not exists email_change_confirm_status smallint null default 0,
  add column if not exists banned_until timestamptz null,
  add column if not exists reauthentication_token varchar(255) null default '',
  add column if not exists reauthentication_sent_at timestamptz null,
  add column if not exists is_sso_user boolean not null default false,
  add column if not exists deleted_at timestamptz null,
  add column if not exists is_anonymous boolean not null default false;

alter table auth.users
  add column if not exists confirmed_at timestamptz
  generated always as (least(email_confirmed_at, phone_confirmed_at)) stored;

-- ---------------------------------------------------------------------------
-- auth helper functions (GoTrue)
-- ---------------------------------------------------------------------------

create or replace function auth.uid()
returns uuid
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

create or replace function auth.role()
returns text
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

create or replace function auth.email()
returns text
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.email', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
  )::text
$$;

create or replace function auth.jwt()
returns jsonb
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

alter function auth.uid() owner to supabase_auth_admin;
alter function auth.role() owner to supabase_auth_admin;
alter function auth.email() owner to supabase_auth_admin;
alter function auth.jwt() owner to supabase_auth_admin;
grant execute on function auth.uid(), auth.role(), auth.email(), auth.jwt()
  to public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- storage (storage-api)
-- ---------------------------------------------------------------------------

create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  owner uuid null,
  owner_id text null,
  created_at timestamptz null default now(),
  updated_at timestamptz null default now(),
  public boolean null default false,
  avif_autodetection boolean null default false,
  file_size_limit bigint null,
  allowed_mime_types text[] null
);
create unique index if not exists bname on storage.buckets using btree (name);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text null references storage.buckets (id),
  name text null,
  owner uuid null,
  owner_id text null,
  created_at timestamptz null default now(),
  updated_at timestamptz null default now(),
  last_accessed_at timestamptz null default now(),
  metadata jsonb null,
  path_tokens text[] generated always as (string_to_array(name, '/')) stored,
  version text null,
  user_metadata jsonb null
);
create unique index if not exists bucketid_objname on storage.objects using btree (bucket_id, name);

alter table storage.objects enable row level security;
alter table storage.buckets enable row level security;

create or replace function storage.foldername(name text)
returns text[]
language plpgsql immutable
as $$
declare
  _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[1 : array_length(_parts, 1) - 1];
end
$$;

create or replace function storage.filename(name text)
returns text
language plpgsql immutable
as $$
declare
  _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[array_length(_parts, 1)];
end
$$;

alter table storage.buckets owner to supabase_storage_admin;
alter table storage.objects owner to supabase_storage_admin;
alter function storage.foldername(text) owner to supabase_storage_admin;
alter function storage.filename(text) owner to supabase_storage_admin;

grant all on storage.buckets, storage.objects to postgres with grant option;
grant all on storage.buckets, storage.objects to anon, authenticated, service_role;
grant execute on function storage.foldername(text), storage.filename(text)
  to postgres, anon, authenticated, service_role;
