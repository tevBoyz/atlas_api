-- SCRUM-16: Phone password sign-in shares the email lockout row.
-- login_lockout_status / record_login_failure take exactly one of p_email or p_phone.
-- A known phone increments the same row as that user's normalized email.
-- An unknown phone (or a phone-only user) is keyed by E.164.
-- Does not send email or SMS. Does not change session timebox. Does not count
-- network failures (the client must not call record_login_failure for those).

comment on table public.login_lockouts is
  'SCRUM-16: Password lockout. PK is a normalized email, or an E.164 phone when that number is not tied to an Auth email. Access only via DEFINER RPCs.';

comment on column public.login_lockouts.email is
  'Lock key: lower(trim(email)), or E.164 (+ and 8-15 digits) when the phone has no Auth email.';

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function public._login_lockout_phone_key(raw text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  n text;
begin
  if raw is null or btrim(raw) = '' then
    raise exception using
      errcode = 'P0001',
      message = 'login_lockout:phone_required';
  end if;

  n := public._normalize_e164(raw);
  if n is null or n !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception using
      errcode = 'P0001',
      message = 'login_lockout:invalid_phone';
  end if;

  return n;
end;
$$;

comment on function public._login_lockout_phone_key(text) is
  'SCRUM-16: Strict E.164 for lockout. Digits-only 8-15 get a leading +. Internal. Not an RPC.';

revoke all on function public._login_lockout_phone_key(text) from public;
revoke all on function public._login_lockout_phone_key(text) from anon;
revoke all on function public._login_lockout_phone_key(text) from authenticated;
revoke all on function public._login_lockout_phone_key(text) from service_role;

-- Lock key for an Auth user: normalized email when they have one, else E.164.
-- Returns null when the user has neither. Does not raise.
create or replace function public._login_lockout_key_for_user(uid uuid)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  user_email text;
  user_phone text;
  phone_norm text;
begin
  if uid is null then
    return null;
  end if;

  select nullif(lower(trim(coalesce(u.email, ''))), ''),
         u.phone
    into user_email, user_phone
    from auth.users u
   where u.id = uid;

  if user_email is not null
     and char_length(user_email) <= 254
     and user_email ~ '^[^@\s]+@[^@\s]+$' then
    return user_email;
  end if;

  phone_norm := public._normalize_e164(user_phone);
  if phone_norm is not null and phone_norm ~ '^\+[1-9][0-9]{7,14}$' then
    return phone_norm;
  end if;

  return null;
end;
$$;

comment on function public._login_lockout_key_for_user(uuid) is
  'SCRUM-16: Email lock key, else E.164, else null. Internal. Not an RPC. Do not grant to API roles — the key can be an email.';

revoke all on function public._login_lockout_key_for_user(uuid) from public;
revoke all on function public._login_lockout_key_for_user(uuid) from anon;
revoke all on function public._login_lockout_key_for_user(uuid) from authenticated;
revoke all on function public._login_lockout_key_for_user(uuid) from service_role;

create or replace function public._login_lockout_resolve_key(
  p_email text,
  p_phone text
)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  phone_norm text;
  uid uuid;
  resolved text;
begin
  if p_email is not null and p_phone is not null then
    raise exception using
      errcode = 'P0001',
      message = 'login_lockout:identifier_exclusive';
  end if;

  if p_email is null and p_phone is null then
    raise exception using
      errcode = 'P0001',
      message = 'login_lockout:identifier_required';
  end if;

  if p_email is not null then
    return public._normalize_login_email(p_email);
  end if;

  phone_norm := public._login_lockout_phone_key(p_phone);

  select u.id
    into uid
    from auth.users u
   where public._normalize_e164(u.phone) = phone_norm
   order by case
     when nullif(lower(trim(coalesce(u.email, ''))), '') is not null
      and char_length(lower(trim(u.email))) <= 254
      and lower(trim(u.email)) ~ '^[^@\s]+@[^@\s]+$'
     then 0
     else 1
   end,
   u.created_at nulls last
   limit 1;

  if not found then
    return phone_norm;
  end if;

  resolved := public._login_lockout_key_for_user(uid);
  return coalesce(resolved, phone_norm);
end;
$$;

comment on function public._login_lockout_resolve_key(text, text) is
  'SCRUM-16: Exactly one of p_email or p_phone. Phone of a user with an email returns that email key. Internal. Not an RPC.';

revoke all on function public._login_lockout_resolve_key(text, text) from public;
revoke all on function public._login_lockout_resolve_key(text, text) from anon;
revoke all on function public._login_lockout_resolve_key(text, text) from authenticated;
revoke all on function public._login_lockout_resolve_key(text, text) from service_role;

-- ---------------------------------------------------------------------------
-- Public RPCs (replace single-argument email signatures)
-- ---------------------------------------------------------------------------

drop function if exists public.login_lockout_status(text);
drop function if exists public.record_login_failure(text);

create or replace function public.login_lockout_status(
  p_email text default null,
  p_phone text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  lock_key text;
  rec public.login_lockouts;
begin
  perform public._login_lockout_rate_limit('login_lockout_status', 60);
  lock_key := public._login_lockout_resolve_key(p_email, p_phone);
  rec := public._login_lockout_load(lock_key, true);
  return public._login_lockout_payload(rec);
end;
$$;

comment on function public.login_lockout_status(text, text) is
  'SCRUM-16: { locked, locked_until, failed_attempts }. Exactly one of p_email or p_phone. Anon + authenticated.';

create or replace function public.record_login_failure(
  p_email text default null,
  p_phone text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  lock_key text;
  rec public.login_lockouts;
  payload jsonb;
begin
  perform public._login_lockout_rate_limit('record_login_failure', 15);
  lock_key := public._login_lockout_resolve_key(p_email, p_phone);
  rec := public._login_lockout_load(lock_key, true);

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
    values (lock_key, 1, null, now(), now())
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
     where l.email = lock_key
    returning * into rec;
  end if;

  -- Return JSON (including locked: true). Raising here would roll back the
  -- 5th-failure write in the same PostgREST transaction.
  return public._login_lockout_payload(rec);
end;
$$;

comment on function public.record_login_failure(text, text) is
  'SCRUM-16: Increment after invalid_credentials only. Exactly one of p_email or p_phone. Locks at 5. Anon + authenticated.';

create or replace function public.clear_login_failures(email text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  email_norm text;
  phone_norm text;
  auth_phone text;
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

  jwt_email := nullif(lower(trim(coalesce(auth.jwt() ->> 'email', ''))), '');

  select nullif(lower(trim(coalesce(u.email, ''))), ''),
         u.phone
    into auth_email, auth_phone
    from auth.users u
   where u.id = uid;

  if auth_email is not null or jwt_email is not null then
    email_norm := public._normalize_login_email(clear_login_failures.email);

    if jwt_email is distinct from email_norm
       and auth_email is distinct from email_norm then
      raise exception using
        errcode = 'P0001',
        message = 'login_lockout:email_mismatch';
    end if;

    delete from public.login_lockouts l
     where l.email = email_norm;
  end if;

  phone_norm := public._normalize_e164(auth_phone);
  if phone_norm is not null and phone_norm ~ '^\+[1-9][0-9]{7,14}$' then
    delete from public.login_lockouts l
     where l.email = phone_norm;
  end if;

  return public._login_lockout_status_json(false, null, 0);
end;
$$;

comment on function public.clear_login_failures(text) is
  'SCRUM-16: Authenticated. Deletes the caller email row when the argument matches, and the caller E.164 row when one exists.';

-- ---------------------------------------------------------------------------
-- Password session gate — email and phone password grants
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
  lock_key text;
  until_ts timestamptz;
begin
  claims := event->'claims';
  method := lower(trim(both '"' from coalesce(event->>'authentication_method', '')));

  if claims is null then
    return event;
  end if;

  -- Email+password and phone+password both use method "password".
  -- OTP, oauth, magic link, recovery, and token_refresh are not blocked.
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

  lock_key := public._login_lockout_key_for_user(uid);
  if lock_key is null then
    return jsonb_build_object('claims', claims);
  end if;

  select l.locked_until
    into until_ts
    from public.login_lockouts l
   where l.email = lock_key
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
  'SCRUM-16: Custom access token hook. Reject email or phone password grant when that user lock key is locked.';

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on function public.login_lockout_status(text, text) from public;
grant execute on function public.login_lockout_status(text, text) to anon;
grant execute on function public.login_lockout_status(text, text) to authenticated;

revoke all on function public.record_login_failure(text, text) from public;
grant execute on function public.record_login_failure(text, text) to anon;
grant execute on function public.record_login_failure(text, text) to authenticated;

revoke all on function public.clear_login_failures(text) from public;
revoke all on function public.clear_login_failures(text) from anon;
grant execute on function public.clear_login_failures(text) to authenticated;

revoke all on function public.hook_reject_locked_password_session(jsonb) from public;
revoke all on function public.hook_reject_locked_password_session(jsonb) from anon;
revoke all on function public.hook_reject_locked_password_session(jsonb) from authenticated;
grant execute on function public.hook_reject_locked_password_session(jsonb) to supabase_auth_admin;

notify pgrst, 'reload schema';
