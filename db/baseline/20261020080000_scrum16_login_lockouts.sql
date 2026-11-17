-- SCRUM-16: Login lockout (5 failures / 15 minutes) + password-session gate.
-- Keyed by normalized email. SECURITY DEFINER RPCs only — no Data API access.
-- Does not add profiles columns. Does not send email/SMS/push.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.login_lockouts (
  email text primary key,
  failed_attempts integer not null default 0
    constraint login_lockouts_failed_attempts_nonneg check (failed_attempts >= 0),
  locked_until timestamptz null,
  last_failed_at timestamptz null,
  updated_at timestamptz not null default now()
);

comment on table public.login_lockouts is
  'SCRUM-16: Per-email password lockout. Access only via DEFINER RPCs.';
comment on column public.login_lockouts.email is
  'Normalized: lower(trim(email)).';
comment on column public.login_lockouts.failed_attempts is
  'Failures in the current 15-minute window. 5 locks for 15 minutes.';
comment on column public.login_lockouts.locked_until is
  'Set at lock. Null when unlocked. Further failures do not extend it.';

create table public.login_lockout_rpc_throttle (
  bucket text primary key,
  window_started_at timestamptz not null,
  call_count integer not null default 0
    constraint login_lockout_rpc_throttle_count_nonneg check (call_count >= 0)
);

comment on table public.login_lockout_rpc_throttle is
  'SCRUM-16: Per-IP RPC windows. Internal. Not for the app.';

alter table public.login_lockouts enable row level security;
alter table public.login_lockout_rpc_throttle enable row level security;

revoke all on table public.login_lockouts from public;
revoke all on table public.login_lockouts from anon;
revoke all on table public.login_lockouts from authenticated;

revoke all on table public.login_lockout_rpc_throttle from public;
revoke all on table public.login_lockout_rpc_throttle from anon;
revoke all on table public.login_lockout_rpc_throttle from authenticated;

grant select on table public.login_lockouts to supabase_auth_admin;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function public._normalize_login_email(raw text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  n text;
begin
  n := lower(trim(coalesce(raw, '')));
  if n = '' then
    raise exception using
      errcode = 'P0001',
      message = 'login_lockout:email_required';
  end if;
  if char_length(n) > 254 or n !~ '^[^@\s]+@[^@\s]+$' then
    raise exception using
      errcode = 'P0001',
      message = 'login_lockout:invalid_email';
  end if;
  return n;
end;
$$;

comment on function public._normalize_login_email(text) is
  'SCRUM-16: lower(trim(email)). Reject blank / oversized / no-at. Internal.';

create or replace function public._login_lockout_status_json(
  p_locked boolean,
  p_locked_until timestamptz,
  p_failed_attempts integer
)
returns jsonb
language sql
immutable
set search_path = public
as $$
  select jsonb_build_object(
    'locked', coalesce(p_locked, false),
    'locked_until', p_locked_until,
    'failed_attempts', coalesce(p_failed_attempts, 0)
  );
$$;

comment on function public._login_lockout_status_json(boolean, timestamptz, integer) is
  'SCRUM-16: Status payload. Internal.';

create or replace function public._login_lockout_client_ip()
returns text
language plpgsql
stable
set search_path = public
as $$
declare
  headers jsonb;
  forwarded text;
  real_ip text;
begin
  begin
    headers := current_setting('request.headers', true)::jsonb;
  exception
    when others then
      headers := null;
  end;

  if headers is null then
    return 'unknown';
  end if;

  forwarded := nullif(trim(split_part(coalesce(headers->>'x-forwarded-for', ''), ',', 1)), '');
  if forwarded is not null then
    return forwarded;
  end if;

  real_ip := nullif(trim(coalesce(headers->>'x-real-ip', '')), '');
  if real_ip is not null then
    return real_ip;
  end if;

  return 'unknown';
end;
$$;

comment on function public._login_lockout_client_ip() is
  'SCRUM-16: Caller IP from request headers. Internal.';

create or replace function public._login_lockout_rate_limit(
  rpc_name text,
  max_calls integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bucket text;
  v_count integer;
begin
  if rpc_name is null or max_calls is null or max_calls < 1 then
    return;
  end if;

  v_bucket := rpc_name || ':' || public._login_lockout_client_ip();

  insert into public.login_lockout_rpc_throttle as t (
    bucket,
    window_started_at,
    call_count
  )
  values (v_bucket, now(), 1)
  on conflict (bucket) do update
    set window_started_at = case
          when t.window_started_at <= now() - interval '5 minutes'
            then now()
          else t.window_started_at
        end,
        call_count = case
          when t.window_started_at <= now() - interval '5 minutes'
            then 1
          else t.call_count + 1
        end
  returning t.call_count
    into v_count;

  if v_count > max_calls then
    raise exception using
      errcode = 'P0001',
      message = 'login_lockout:rate_limited';
  end if;
end;
$$;

comment on function public._login_lockout_rate_limit(text, integer) is
  'SCRUM-16: Per-IP 5-minute window. Internal.';

create or replace function public._login_lockout_load(
  email_norm text,
  reset_expired boolean
)
returns public.login_lockouts
language plpgsql
security definer
set search_path = public
as $$
declare
  rec public.login_lockouts;
begin
  select *
    into rec
    from public.login_lockouts l
   where l.email = email_norm
   for update;

  if not found then
    return null;
  end if;

  if not reset_expired then
    return rec;
  end if;

  if rec.locked_until is not null and rec.locked_until <= now() then
    rec.failed_attempts := 0;
    rec.locked_until := null;
    rec.last_failed_at := null;
    rec.updated_at := now();
    update public.login_lockouts l
       set failed_attempts = rec.failed_attempts,
           locked_until = rec.locked_until,
           last_failed_at = rec.last_failed_at,
           updated_at = rec.updated_at
     where l.email = email_norm;
  elsif rec.locked_until is null
     and rec.last_failed_at is not null
     and rec.last_failed_at <= now() - interval '15 minutes' then
    rec.failed_attempts := 0;
    rec.last_failed_at := null;
    rec.updated_at := now();
    update public.login_lockouts l
       set failed_attempts = rec.failed_attempts,
           last_failed_at = rec.last_failed_at,
           updated_at = rec.updated_at
     where l.email = email_norm;
  end if;

  return rec;
end;
$$;

comment on function public._login_lockout_load(text, boolean) is
  'SCRUM-16: Load row; optionally expire lock / 15-minute window. Internal.';

create or replace function public._login_lockout_payload(rec public.login_lockouts)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  is_locked boolean;
begin
  if rec is null then
    return public._login_lockout_status_json(false, null, 0);
  end if;
  is_locked := rec.locked_until is not null and rec.locked_until > now();
  return public._login_lockout_status_json(
    is_locked,
    case when is_locked then rec.locked_until else null end,
    coalesce(rec.failed_attempts, 0)
  );
end;
$$;

comment on function public._login_lockout_payload(public.login_lockouts) is
  'SCRUM-16: Row → status JSON. Internal.';

-- ---------------------------------------------------------------------------
-- Public RPCs
-- ---------------------------------------------------------------------------

create or replace function public.login_lockout_status(email text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  email_norm text;
  rec public.login_lockouts;
begin
  perform public._login_lockout_rate_limit('login_lockout_status', 60);
  email_norm := public._normalize_login_email(login_lockout_status.email);
  rec := public._login_lockout_load(email_norm, true);
  return public._login_lockout_payload(rec);
end;
$$;

comment on function public.login_lockout_status(text) is
  'SCRUM-16: { locked, locked_until, failed_attempts }. Anon + authenticated.';

create or replace function public.record_login_failure(email text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  email_norm text;
  rec public.login_lockouts;
  payload jsonb;
begin
  perform public._login_lockout_rate_limit('record_login_failure', 15);
  email_norm := public._normalize_login_email(record_login_failure.email);
  rec := public._login_lockout_load(email_norm, true);

  if rec is not null
     and rec.locked_until is not null
     and rec.locked_until > now() then
    payload := public._login_lockout_payload(rec);
    raise exception using
      errcode = 'P0001',
      message = 'login_lockout:locked',
      detail = payload::text;
  end if;

  if rec is null then
    insert into public.login_lockouts as l (
      email,
      failed_attempts,
      locked_until,
      last_failed_at,
      updated_at
    )
    values (email_norm, 1, null, now(), now())
    returning * into rec;
  else
    rec.failed_attempts := coalesce(rec.failed_attempts, 0) + 1;
    rec.last_failed_at := now();
    rec.updated_at := now();
    if rec.failed_attempts >= 5 then
      rec.locked_until := now() + interval '15 minutes';
    end if;
    update public.login_lockouts l
       set failed_attempts = rec.failed_attempts,
           locked_until = rec.locked_until,
           last_failed_at = rec.last_failed_at,
           updated_at = rec.updated_at
     where l.email = email_norm
    returning * into rec;
  end if;

  -- Return JSON (including locked: true). Raising here would roll back the
  -- 5th-failure write in the same PostgREST transaction.
  return public._login_lockout_payload(rec);
end;
$$;

comment on function public.record_login_failure(text) is
  'SCRUM-16: Increment after invalid_credentials. Locks at 5. Anon + authenticated.';

create or replace function public.clear_login_failures(email text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  email_norm text;
  uid uuid := auth.uid();
  jwt_email text;
  auth_email text;
begin
  perform public._login_lockout_rate_limit('clear_login_failures', 30);

  if uid is null then
    raise exception using
      errcode = 'P0001',
      message = 'login_lockout:not_authenticated';
  end if;

  email_norm := public._normalize_login_email(clear_login_failures.email);

  jwt_email := nullif(lower(trim(coalesce(auth.jwt() ->> 'email', ''))), '');

  select nullif(lower(trim(coalesce(u.email, ''))), '')
    into auth_email
    from auth.users u
   where u.id = uid;

  if jwt_email is distinct from email_norm
     and auth_email is distinct from email_norm then
    raise exception using
      errcode = 'P0001',
      message = 'login_lockout:email_mismatch';
  end if;

  delete from public.login_lockouts l
   where l.email = email_norm;

  return public._login_lockout_status_json(false, null, 0);
end;
$$;

comment on function public.clear_login_failures(text) is
  'SCRUM-16: Clear after successful sign-in / Google / reset. JWT email must match.';

-- ---------------------------------------------------------------------------
-- Password session gate (custom access token hook)
-- ---------------------------------------------------------------------------

create or replace function public.hook_reject_locked_password_session(event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  claims jsonb;
  method text;
  uid uuid;
  user_email text;
  until_ts timestamptz;
begin
  claims := event->'claims';
  method := lower(trim(both '"' from coalesce(event->>'authentication_method', '')));

  if claims is null then
    return event;
  end if;

  if method is distinct from 'password' then
    return jsonb_build_object('claims', claims);
  end if;

  begin
    uid := nullif(trim(coalesce(event->>'user_id', '')), '')::uuid;
  exception
    when others then
      uid := null;
  end;

  if uid is null then
    return jsonb_build_object('claims', claims);
  end if;

  select lower(trim(u.email))
    into user_email
    from auth.users u
   where u.id = uid;

  if user_email is null or user_email = '' then
    return jsonb_build_object('claims', claims);
  end if;

  select l.locked_until
    into until_ts
    from public.login_lockouts l
   where l.email = user_email
     and l.locked_until is not null
     and l.locked_until > now();

  if until_ts is not null then
    return jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 403,
        'message', 'login_lockout:locked'
      )
    );
  end if;

  return jsonb_build_object('claims', claims);
end;
$$;

comment on function public.hook_reject_locked_password_session(jsonb) is
  'SCRUM-16: Custom access token hook. Reject password grant when email is locked.';

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on function public._normalize_login_email(text) from public;
revoke all on function public._normalize_login_email(text) from anon;
revoke all on function public._normalize_login_email(text) from authenticated;

revoke all on function public._login_lockout_status_json(boolean, timestamptz, integer) from public;
revoke all on function public._login_lockout_status_json(boolean, timestamptz, integer) from anon;
revoke all on function public._login_lockout_status_json(boolean, timestamptz, integer) from authenticated;

revoke all on function public._login_lockout_client_ip() from public;
revoke all on function public._login_lockout_client_ip() from anon;
revoke all on function public._login_lockout_client_ip() from authenticated;

revoke all on function public._login_lockout_rate_limit(text, integer) from public;
revoke all on function public._login_lockout_rate_limit(text, integer) from anon;
revoke all on function public._login_lockout_rate_limit(text, integer) from authenticated;

revoke all on function public._login_lockout_load(text, boolean) from public;
revoke all on function public._login_lockout_load(text, boolean) from anon;
revoke all on function public._login_lockout_load(text, boolean) from authenticated;

revoke all on function public._login_lockout_payload(public.login_lockouts) from public;
revoke all on function public._login_lockout_payload(public.login_lockouts) from anon;
revoke all on function public._login_lockout_payload(public.login_lockouts) from authenticated;

revoke all on function public.login_lockout_status(text) from public;
grant execute on function public.login_lockout_status(text) to anon;
grant execute on function public.login_lockout_status(text) to authenticated;

revoke all on function public.record_login_failure(text) from public;
grant execute on function public.record_login_failure(text) to anon;
grant execute on function public.record_login_failure(text) to authenticated;

revoke all on function public.clear_login_failures(text) from public;
revoke all on function public.clear_login_failures(text) from anon;
grant execute on function public.clear_login_failures(text) to authenticated;

revoke all on function public.hook_reject_locked_password_session(jsonb) from public;
revoke all on function public.hook_reject_locked_password_session(jsonb) from anon;
revoke all on function public.hook_reject_locked_password_session(jsonb) from authenticated;
grant execute on function public.hook_reject_locked_password_session(jsonb) to supabase_auth_admin;
