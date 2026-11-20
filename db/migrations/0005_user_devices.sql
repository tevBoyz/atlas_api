-- API-100-44: the user's app installations and their push tokens (spec §11.7 `user_devices`,
-- §11.3 U1/U2). One row per (user, installation): the app generates the installation id (a UUID)
-- once per install and sends it as `X-Atlas-Installation-Id`. A push token belongs to at most one
-- row (partial unique index): registering it on a device clears it from any other row first.
--
-- `user_id` references auth.users now; it is repointed to the API's own users table at the auth
-- cutover (spec §11.7). Deleting the user deletes their devices. `device_name` and `revoked_at`
-- are not written in Phase 5 (own sessions, Phase 6, use them).
--
-- Push tokens are credentials for reaching a phone: never logged, never in an error or audit row.
--
-- Additive only (AGENTS.md rule 4): one new table and its indexes. Re-runnable on a fresh database
-- after the baseline. Locked down for the Supabase API roles like 0001-0003 (the app never reads
-- this table directly; it calls the API).

create table if not exists public.user_devices (
  id uuid not null default gen_random_uuid(),
  user_id uuid not null,
  installation_id text not null,
  platform text not null,
  device_name text null,
  app_version text null,
  push_provider text null,
  push_token text null,
  push_token_updated_at timestamptz null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz null,
  constraint user_devices_pkey primary key (id),
  constraint user_devices_user_id_fkey foreign key (user_id)
    references auth.users (id) on delete cascade,
  constraint user_devices_user_installation_key unique (user_id, installation_id),
  constraint user_devices_installation_id_check
    check (installation_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  constraint user_devices_platform_check check (platform in ('android', 'ios')),
  constraint user_devices_push_provider_check
    check (push_provider is null or push_provider in ('fcm', 'apns')),
  -- A token always says which provider issued it; no provider without a token.
  constraint user_devices_push_token_provider_check
    check ((push_token is null) = (push_provider is null))
);

comment on table public.user_devices is
  'API-100-44: app installations per user (X-Atlas-Installation-Id) with their push token. A push token is on at most one row. Written only by the API. push_token is a credential: never logged or audited.';

-- A push token is unique across devices (U1 moves it).
create unique index if not exists user_devices_push_token_key
  on public.user_devices (push_token)
  where push_token is not null;

alter table public.user_devices enable row level security;

revoke all on table public.user_devices from public;
revoke all on table public.user_devices from anon;
revoke all on table public.user_devices from authenticated;
