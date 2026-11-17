-- SCRUM-41: Live Location Sharing
-- Extends attach_incident_location with out-of-order protection (do not
-- replace a newer location_captured_at with an older ping).
-- Adds public.app_config + get_live_location_config() so mobile can read
-- the live update interval (default 12s) and stale threshold (default 45s)
-- without an app-store release.
-- Reuses the same five location columns on public.incidents (SCRUM-40).
-- Does not create incident rows, notify, fan out deliveries, or open profiles.
-- Hosted Supabase, no Express, no Edge Functions, no FCM, no Twilio.

-- ---------------------------------------------------------------------------
-- public.app_config — remote keys (interval + stale threshold)
-- ---------------------------------------------------------------------------

create table if not exists public.app_config (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

comment on table public.app_config is
  'SCRUM-41: Remote config for clients. Authenticated SELECT only; ops change values via SQL / service role.';

comment on column public.app_config.key is
  'Config key, e.g. live_location_interval_seconds.';
comment on column public.app_config.value is
  'JSON scalar or object. Interval / stale keys store a JSON number.';
comment on column public.app_config.updated_at is
  'Last write time. Bumped by trigger on update.';

create or replace function public._app_config_set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists app_config_set_updated_at on public.app_config;
create trigger app_config_set_updated_at
  before update on public.app_config
  for each row
  execute function public._app_config_set_updated_at();

alter table public.app_config enable row level security;

drop policy if exists app_config_select_authenticated on public.app_config;
create policy app_config_select_authenticated
  on public.app_config
  for select
  to authenticated
  using (true);

comment on policy app_config_select_authenticated on public.app_config is
  'SCRUM-41: Authenticated clients may read remote config. No client writes.';

revoke all on table public.app_config from public;
revoke all on table public.app_config from anon;
revoke insert, update, delete, truncate, references, trigger on table public.app_config from authenticated;
grant select on table public.app_config to authenticated;

insert into public.app_config (key, value)
values
  ('live_location_interval_seconds', '12'::jsonb),
  ('live_location_stale_threshold_seconds', '45'::jsonb)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- get_live_location_config() — interval + stale for mobile
-- ---------------------------------------------------------------------------

create or replace function public.get_live_location_config()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid;
  v_interval integer;
  v_stale integer;
begin
  uid := public._require_auth_uid('get_live_location_config');

  select case
           when jsonb_typeof(c.value) = 'number' then (c.value #>> '{}')::integer
           else null
         end
    into v_interval
    from public.app_config c
   where c.key = 'live_location_interval_seconds';

  select case
           when jsonb_typeof(c.value) = 'number' then (c.value #>> '{}')::integer
           else null
         end
    into v_stale
    from public.app_config c
   where c.key = 'live_location_stale_threshold_seconds';

  if v_interval is null or v_interval <= 0 then
    v_interval := 12;
  end if;

  if v_stale is null or v_stale <= 0 then
    v_stale := 45;
  end if;

  return jsonb_build_object(
    'interval_seconds', v_interval,
    'stale_threshold_seconds', v_stale
  );
end;
$$;

comment on function public.get_live_location_config() is
  'SCRUM-41: Return live location interval_seconds (default 12) and stale_threshold_seconds (default 45) from app_config. JWT required. Does not write.';

revoke all on function public.get_live_location_config() from public;
revoke all on function public.get_live_location_config() from anon;
grant execute on function public.get_live_location_config() to authenticated;

-- ---------------------------------------------------------------------------
-- attach_incident_location — live reuse + out-of-order guard
-- ---------------------------------------------------------------------------

create or replace function public.attach_incident_location(
  p_incident_id uuid,
  p_location_source text,
  p_location_lat double precision default null,
  p_location_lng double precision default null,
  p_location_accuracy_m double precision default null,
  p_location_captured_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid;
  rec public.incidents%rowtype;
begin
  uid := public._require_auth_uid('attach_incident_location');

  if p_location_source is null
     or p_location_source not in ('current', 'last_known', 'unavailable')
  then
    raise exception using
      errcode = 'P0001',
      message = 'attach_incident_location:invalid_source';
  end if;

  if p_location_source = 'unavailable' then
    if p_location_lat is not null
       or p_location_lng is not null
       or p_location_accuracy_m is not null
       or p_location_captured_at is not null
    then
      raise exception using
        errcode = 'P0001',
        message = 'attach_incident_location:invalid_location';
    end if;
  else
    if p_location_lat is null
       or p_location_lng is null
       or p_location_captured_at is null
       or p_location_lat < -90
       or p_location_lat > 90
       or p_location_lng < -180
       or p_location_lng > 180
    then
      raise exception using
        errcode = 'P0001',
        message = 'attach_incident_location:invalid_location';
    end if;

    if p_location_source = 'current' and p_location_accuracy_m is null then
      raise exception using
        errcode = 'P0001',
        message = 'attach_incident_location:invalid_location';
    end if;

    if p_location_accuracy_m is not null and p_location_accuracy_m < 0 then
      raise exception using
        errcode = 'P0001',
        message = 'attach_incident_location:invalid_location';
    end if;
  end if;

  select *
    into rec
    from public.incidents i
   where i.id = p_incident_id
     and i.resident_id = uid
   for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'attach_incident_location:not_found';
  end if;

  if rec.status not in ('activating', 'active') then
    raise exception using
      errcode = 'P0001',
      message = 'attach_incident_location:not_open';
  end if;

  -- SCRUM-41: out-of-order — keep the newer fix; return current row.
  if rec.location_captured_at is not null
     and p_location_captured_at is not null
     and p_location_captured_at < rec.location_captured_at
  then
    return public._incident_activation_json(rec);
  end if;

  update public.incidents
     set location_source = p_location_source,
         location_lat = p_location_lat,
         location_lng = p_location_lng,
         location_accuracy_m = p_location_accuracy_m,
         location_captured_at = p_location_captured_at
   where id = rec.id
  returning * into rec;

  return public._incident_activation_json(rec);
end;
$$;

comment on function public.attach_incident_location(uuid, text, double precision, double precision, double precision, timestamptz) is
  'SCRUM-40 / 41: Attach or live-update location on the caller''s activating or active incident. Owner JWT only. Rejects cancelled/resolved as not_open. Skips overwrite when p_location_captured_at is older than the stored fix. Does not notify, create rows, or change status/type/notes/resolve columns.';
