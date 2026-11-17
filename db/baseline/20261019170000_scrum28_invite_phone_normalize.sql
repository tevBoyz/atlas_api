-- SCRUM-28 follow-up: Pending Invitations miss rows when Auth phone
-- omits '+' (or has surrounding spaces) while the member row is E.164.
-- Normalize both sides. RPC names and return JSON keys are unchanged.
-- Does not send SMS.

-- ---------------------------------------------------------------------------
-- Internal: trim; keep +E.164; prefix + on 8–15 digits starting 1-9
-- ---------------------------------------------------------------------------

create or replace function public._normalize_e164(raw text)
returns text
language sql
immutable
parallel safe
set search_path = public
as $$
  select case
    when raw is null then null
    when btrim(raw) = '' then null
    when btrim(raw) ~ '^\+[1-9][0-9]{7,14}$' then btrim(raw)
    when btrim(raw) ~ '^[1-9][0-9]{7,14}$' then '+' || btrim(raw)
    else btrim(raw)
  end;
$$;

comment on function public._normalize_e164(text) is
  'SCRUM-28: Trim. Keep +E.164. Prefix + on digits-only 8–15 starting 1-9. Else trimmed or null. Internal.';

revoke all on function public._normalize_e164(text) from public;
revoke all on function public._normalize_e164(text) from anon;
revoke all on function public._normalize_e164(text) from authenticated;

-- ---------------------------------------------------------------------------
-- Auth phone used by invite recipient checks
-- ---------------------------------------------------------------------------

create or replace function public._auth_user_phone(uid uuid)
returns text
language sql
stable
set search_path = public
as $$
  select public._normalize_e164(u.phone)
    from auth.users u
   where u.id = uid;
$$;

comment on function public._auth_user_phone(uuid) is
  'SCRUM-28: Auth phone for uid, normalized to +E.164 when possible. Internal.';

-- ---------------------------------------------------------------------------
-- Recipient: compare normalized phones (Auth may omit +)
-- ---------------------------------------------------------------------------

create or replace function public._circle_invite_recipient_ok(
  m public.safety_circle_members,
  uid uuid,
  auth_phone text
)
returns boolean
language plpgsql
stable
set search_path = public
as $$
begin
  if m.user_id is not null and m.user_id <> uid then
    return false;
  end if;

  if m.phone is not null then
    return public._normalize_e164(auth_phone) is not null
       and public._normalize_e164(m.phone)
         = public._normalize_e164(auth_phone);
  end if;

  -- Link-only: possession of the current token is enough.
  return true;
end;
$$;

comment on function public._circle_invite_recipient_ok(public.safety_circle_members, uuid, text) is
  'SCRUM-28: Phone invites must match Auth after _normalize_e164. Link-only (phone null) allows the token holder. Internal.';

-- ---------------------------------------------------------------------------
-- list_my_circle_invites: same return keys; phone match is normalized
-- ---------------------------------------------------------------------------

create or replace function public.list_my_circle_invites()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  prefix constant text := 'list_my_circle_invites';
  uid uuid;
  auth_phone text;
  m public.safety_circle_members%rowtype;
  st text;
begin
  uid := public._require_auth_uid(prefix);
  auth_phone := public._auth_user_phone(uid);

  for m in
    select scm.*
      from public.safety_circle_members scm
     where scm.role = 'member'
       and scm.status = 'pending'
       and (
         scm.user_id = uid
         or (
           scm.user_id is null
           and scm.phone is not null
           and auth_phone is not null
           and public._normalize_e164(scm.phone)
             = public._normalize_e164(auth_phone)
         )
       )
     for update
  loop
    st := public._circle_invite_lookup_status(m);
    if st <> 'pending' then
      continue;
    end if;
    if not public._circle_invite_recipient_ok(m, uid, auth_phone) then
      continue;
    end if;
    if public._circle_has_active_membership(m.circle_id, uid, m.id) then
      continue;
    end if;
    if m.user_id is null then
      begin
        update public.safety_circle_members
           set user_id = uid,
               updated_at = now()
         where id = m.id;
      exception
        when unique_violation then
          null;
      end;
    end if;
  end loop;

  return (
    select coalesce(
      jsonb_agg(payload order by (payload->>'invited_at') desc),
      '[]'::jsonb
    )
    from (
      select jsonb_build_object(
               'member_id', scm.id,
               'circle_id', scm.circle_id,
               'status', public._circle_invite_lookup_status(scm),
               'owner_name', public._circle_owner_display_name(scm.circle_id),
               'invited_at', scm.invited_at,
               'invite_expires_at', scm.invite_expires_at,
               'invite_token', case
                 when public._circle_invite_lookup_status(scm) = 'pending'
                 then scm.invite_token
                 else null
               end
             ) as payload
        from public.safety_circle_members scm
       where scm.role = 'member'
         and (
           scm.user_id = uid
           or (
             scm.user_id is null
             and scm.phone is not null
             and auth_phone is not null
             and public._normalize_e164(scm.phone)
               = public._normalize_e164(auth_phone)
           )
         )
         and public._circle_invite_lookup_status(scm) in (
           'pending', 'expired', 'canceled'
         )
    ) listed
  );
end;
$$;

comment on function public.list_my_circle_invites() is
  'SCRUM-28: Pending/expired/declined invites this user may see (normalized phone match or claimed user_id). Claims pending phone rows. No other members, emergency_*, or medical. Token only while pending.';

revoke all on function public.list_my_circle_invites() from public;
revoke all on function public.list_my_circle_invites() from anon;
grant execute on function public.list_my_circle_invites() to authenticated;
