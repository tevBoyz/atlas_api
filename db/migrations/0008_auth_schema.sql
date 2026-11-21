-- API-100-50: Atlas-owned authentication tables (spec §11.7 `users`, `user_credentials`,
-- `user_identities`, `device_sessions`, `refresh_tokens`, `auth_tokens`), so Atlas no longer depends
-- on Supabase Auth after the switch (Phase 6).
--
-- - `users.id` keeps the Supabase Auth id (`auth.users.id` = `profiles.id`). The foreign keys of
--   `profiles.id`, `safety_circle_members.user_id` and `user_devices.user_id` still point at
--   `auth.users`: they are repointed at `users` in Phase 7 (API-100-62), not here.
-- - Email: citext, stored lower-case (checked), unique when not null. Phone: normalized `+E.164`
--   (checked), unique when not null.
-- - Secrets are never stored in clear: passwords as argon2id (or migrated bcrypt) hashes, refresh
--   tokens and one-time link tokens as SHA-256 digests.
--
-- Additive only (AGENTS.md rule 4): new tables, their indexes and the `citext` extension in the
-- `extensions` schema (where Supabase keeps extensions). Re-runnable on a fresh database after the
-- baseline. Locked down for the Supabase API roles like 0001-0007: the app never reads these tables
-- directly, only through the API.

create extension if not exists citext with schema extensions;

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------

create table if not exists public.users (
  id uuid not null default gen_random_uuid(),
  email extensions.citext null,
  email_confirmed_at timestamptz null,
  phone text null,
  phone_confirmed_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  disabled_at timestamptz null,
  metadata jsonb not null default '{}'::jsonb,
  constraint users_pkey primary key (id),
  constraint users_email_key unique (email),
  constraint users_phone_key unique (phone),
  constraint users_email_lower_check
    check (email is null or (email::text = lower(email::text) and length(email::text) <= 254)),
  constraint users_phone_e164_check check (phone is null or phone ~ '^\+[1-9][0-9]{7,14}$'),
  constraint users_metadata_check check (jsonb_typeof(metadata) = 'object')
);

comment on table public.users is
  'API-100-50: Atlas users (own auth). id = the Supabase Auth id for migrated users. Written only by the API.';

-- ---------------------------------------------------------------------------
-- user_credentials (one password per user)
-- ---------------------------------------------------------------------------

create table if not exists public.user_credentials (
  user_id uuid not null,
  password_hash text not null,
  hash_algo text not null,
  password_updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  constraint user_credentials_pkey primary key (user_id),
  constraint user_credentials_user_id_fkey foreign key (user_id)
    references public.users (id) on delete cascade,
  constraint user_credentials_hash_algo_check check (hash_algo in ('bcrypt', 'argon2id'))
);

comment on table public.user_credentials is
  'API-100-50: password hash per user (argon2id; bcrypt for users migrated from Supabase Auth until their next sign-in). Never logged.';

-- ---------------------------------------------------------------------------
-- user_identities (email, phone, google, apple)
-- ---------------------------------------------------------------------------

create table if not exists public.user_identities (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  provider text not null,
  provider_subject text not null,
  email extensions.citext null,
  created_at timestamptz not null default now(),
  last_sign_in_at timestamptz null,
  constraint user_identities_pkey primary key (id),
  constraint user_identities_user_id_fkey foreign key (user_id)
    references public.users (id) on delete cascade,
  constraint user_identities_provider_subject_key unique (provider, provider_subject),
  constraint user_identities_provider_check
    check (provider in ('email', 'phone', 'google', 'apple')),
  constraint user_identities_subject_check
    check (length(provider_subject) between 1 and 255)
);

create index if not exists user_identities_user_id_idx on public.user_identities (user_id);

-- ---------------------------------------------------------------------------
-- device_sessions (one per signed-in app installation)
-- ---------------------------------------------------------------------------

create table if not exists public.device_sessions (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  device_id uuid null,
  installation_id text null,
  platform text null,
  device_name text null,
  app_version text null,
  auth_method text not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_refreshed_at timestamptz not null default now(),
  ip_last inet null,
  user_agent text null,
  revoked_at timestamptz null,
  revoke_reason text null,
  constraint device_sessions_pkey primary key (id),
  constraint device_sessions_user_id_fkey foreign key (user_id)
    references public.users (id) on delete cascade,
  constraint device_sessions_device_id_fkey foreign key (device_id)
    references public.user_devices (id) on delete set null,
  constraint device_sessions_installation_id_check
    check (installation_id is null
           or installation_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  constraint device_sessions_platform_check
    check (platform is null or platform in ('android', 'ios')),
  constraint device_sessions_auth_method_check
    check (auth_method in ('password', 'email_link', 'otp', 'google', 'apple', 'recovery',
                           'exchange')),
  constraint device_sessions_revoke_reason_check
    check (revoke_reason is null
           or revoke_reason in ('logout', 'logout_all', 'deleted', 'refresh_token_reused', 'idle',
                                'password_reset')),
  constraint device_sessions_revoked_check check ((revoked_at is null) = (revoke_reason is null))
);

create index if not exists device_sessions_user_live_idx
  on public.device_sessions (user_id, created_at)
  where revoked_at is null;
create index if not exists device_sessions_device_id_idx
  on public.device_sessions (device_id)
  where device_id is not null;

-- ---------------------------------------------------------------------------
-- refresh_tokens (opaque, rotating; SHA-256 digest only)
-- ---------------------------------------------------------------------------

create table if not exists public.refresh_tokens (
  id uuid not null default gen_random_uuid(),
  session_id uuid not null,
  token_hash bytea not null,
  family_id uuid not null,
  parent_id uuid null,
  issued_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz null,
  revoked_at timestamptz null,
  constraint refresh_tokens_pkey primary key (id),
  constraint refresh_tokens_session_id_fkey foreign key (session_id)
    references public.device_sessions (id) on delete cascade,
  constraint refresh_tokens_parent_id_fkey foreign key (parent_id)
    references public.refresh_tokens (id) on delete set null,
  constraint refresh_tokens_token_hash_key unique (token_hash),
  constraint refresh_tokens_token_hash_check check (length(token_hash) = 32)
);

create index if not exists refresh_tokens_session_id_idx on public.refresh_tokens (session_id);
create index if not exists refresh_tokens_parent_id_idx
  on public.refresh_tokens (parent_id)
  where parent_id is not null;

-- ---------------------------------------------------------------------------
-- auth_tokens (email verification, password reset, magic link; SHA-256 digest only)
-- ---------------------------------------------------------------------------

create table if not exists public.auth_tokens (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  purpose text not null,
  token_hash bytea not null,
  expires_at timestamptz not null,
  used_at timestamptz null,
  created_at timestamptz not null default now(),
  constraint auth_tokens_pkey primary key (id),
  constraint auth_tokens_user_id_fkey foreign key (user_id)
    references public.users (id) on delete cascade,
  constraint auth_tokens_token_hash_key unique (token_hash),
  constraint auth_tokens_token_hash_check check (length(token_hash) = 32),
  constraint auth_tokens_purpose_check
    check (purpose in ('email_verify', 'password_reset', 'magic_link'))
);

create index if not exists auth_tokens_user_purpose_idx
  on public.auth_tokens (user_id, purpose)
  where used_at is null;

-- ---------------------------------------------------------------------------
-- Lock down for the Supabase API roles (as 0001-0007)
-- ---------------------------------------------------------------------------

alter table public.users enable row level security;
alter table public.user_credentials enable row level security;
alter table public.user_identities enable row level security;
alter table public.device_sessions enable row level security;
alter table public.refresh_tokens enable row level security;
alter table public.auth_tokens enable row level security;

revoke all on table public.users from public, anon, authenticated;
revoke all on table public.user_credentials from public, anon, authenticated;
revoke all on table public.user_identities from public, anon, authenticated;
revoke all on table public.device_sessions from public, anon, authenticated;
revoke all on table public.refresh_tokens from public, anon, authenticated;
revoke all on table public.auth_tokens from public, anon, authenticated;
