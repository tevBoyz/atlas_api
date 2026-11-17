-- Device re-test round 2 (qa/decisions-2026-11-17-test-run-fixes.md #18, #14).
-- Approved by Dawit 2026-11-17. Contract: backend/contracts/member-names-expired-invites.md
--
-- #18 Member names: list_circle_members shows an active member's own
--   profiles.full_name (stored name if empty) instead of the invite
--   placeholder. accept_circle_invite stores the accepter's full_name on the
--   row. Backfill of active rows still named "Invited member" / empty.
--   profiles RLS is not opened: reads happen inside SECURITY DEFINER helpers.
-- #14 Expired invites: a pending row past invite_expires_at does not hold a
--   slot. Capacity, the capacity trigger, accept/preview checks and the invite
--   RPCs count active + valid pending only. The owner list returns such rows
--   with status 'expired' (JSON only; stored status stays 'pending').
--   resend_circle_invite and cancel_circle_invite work on expired invites.
--   complete_profile_setup re-run after decline/cancel gives a usable invite.
-- No new table, column, or enum value. No SMS, email, or push.

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function public._circle_invite_holds_slot(
  m public.safety_circle_members
)
returns boolean
language sql
stable
set search_path = public
as $$
  select m.role = 'member'
     and (
       m.status = 'active'
       or (
         m.status = 'pending'
         and m.invite_canceled_at is null
         and m.invite_consumed_at is null
         and coalesce(m.invite_expires_at, m.invited_at + interval '7 days') > now()
       )
     );
$$;

comment on function public._circle_invite_holds_slot(public.safety_circle_members) is
  'Fix #14: true when the row uses a trusted-member slot: role member and (active, or pending that is not canceled, not consumed and not past invite_expires_at). Expiry matches _circle_invite_lookup_status. Internal.';

create or replace function public._member_profile_name(uid uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select nullif(trim(p.full_name), '')
    from public.profiles p
   where p.id = uid;
$$;

comment on function public._member_profile_name(uuid) is
  'Fix #18: full_name only for uid, trimmed; null if no profile or empty. Internal. Does not expose emergency_*, medical, contact, or share flags.';

revoke all on function public._circle_invite_holds_slot(public.safety_circle_members) from public;
revoke all on function public._circle_invite_holds_slot(public.safety_circle_members) from anon;
revoke all on function public._circle_invite_holds_slot(public.safety_circle_members) from authenticated;

revoke all on function public._member_profile_name(uuid) from public;
revoke all on function public._member_profile_name(uuid) from anon;
revoke all on function public._member_profile_name(uuid) from authenticated;

-- ---------------------------------------------------------------------------
-- Capacity: active + valid pending only
-- ---------------------------------------------------------------------------

create or replace function public._circle_invite_capacity_json(p_circle_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with counts as (
    select
      count(*) filter (
        where scm.role = 'member' and scm.status = 'active'
      )::integer as active_count,
      count(*) filter (
        where scm.role = 'member'
          and scm.status = 'pending'
          and public._circle_invite_holds_slot(scm)
      )::integer as pending_count
    from public.safety_circle_members scm
    where scm.circle_id = p_circle_id
  )
  select jsonb_build_object(
    'limit', public._circle_member_limit(),
    'active_count', counts.active_count,
    'pending_count', counts.pending_count,
    'used', counts.active_count + counts.pending_count,
    'available', greatest(
      0,
      public._circle_member_limit()
        - (counts.active_count + counts.pending_count)
    )
  )
  from counts;
$$;

comment on function public._circle_invite_capacity_json(uuid) is
  'SCRUM-27 / fix #14: limit 5, active_count, pending_count, used, available. Owner row excluded. Declined, canceled and expired pending rows excluded: pending_count is valid (unexpired, uncanceled) pending only. Includes the emergency-contact row while valid. Internal.';

create or replace function public._circle_accept_used_after(
  p_circle_id uuid,
  p_member_id uuid
)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select (
    count(*) filter (
      where public._circle_invite_holds_slot(scm)
        and scm.id is distinct from p_member_id
    )
    + 1
  )::integer
  from public.safety_circle_members scm
  where scm.circle_id = p_circle_id;
$$;

comment on function public._circle_accept_used_after(uuid, uuid) is
  'SCRUM-28 / fix #14: Trusted slots after activating p_member_id = other active members + other valid pending invites + 1. Owner, declined and expired rows excluded. Internal.';

create or replace function public.enforce_safety_circle_member_capacity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public._circle_invite_holds_slot(new) then
    return new;
  end if;

  -- Already holding a slot (valid pending resend, pending accept -> active,
  -- active edits): nothing new is taken.
  if tg_op = 'UPDATE' and public._circle_invite_holds_slot(old) then
    return new;
  end if;

  perform 1
    from public.safety_circles sc
   where sc.id = new.circle_id
   for update;

  if coalesce(
       (public._circle_invite_capacity_json(new.circle_id)->>'available')::integer,
       0
     ) <= 0 then
    raise exception using
      errcode = 'P0001',
      message = 'circle_full';
  end if;

  return new;
end;
$$;

comment on function public.enforce_safety_circle_member_capacity() is
  'SCRUM-27 / fix #14: Reject a row that newly takes a slot (insert, or update from declined/expired to active/valid pending) when the circle already has 5 active + valid pending. Message circle_full. Internal.';

comment on function public.circle_invite_capacity() is
  'SCRUM-27 / fix #14: Owner-only capacity. Returns limit, active_count, pending_count, used, available. Active + valid pending only; an expired pending invite does not use a slot. Non-owners get not_owner. Does not send SMS.';

-- ---------------------------------------------------------------------------
-- Invite RPCs: an expired pending row needs a free slot to be refreshed
-- ---------------------------------------------------------------------------

create or replace function public.invite_circle_member_by_phone(
  display_name text,
  phone text,
  relationship text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  prefix constant text := 'invite_circle_member_by_phone';
  cid uuid;
  raw_phone text;
  raw_name text;
  raw_rel text;
  existing public.safety_circle_members%rowtype;
  created public.safety_circle_members%rowtype;
begin
  cid := public._owner_circle_for_invite(prefix);

  raw_name := trim(coalesce(display_name, ''));
  if char_length(raw_name) = 0 then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':invalid_display_name';
  end if;

  raw_phone := trim(coalesce(phone, ''));
  if raw_phone !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':invalid_phone';
  end if;

  raw_rel := nullif(trim(coalesce(relationship, '')), '');
  if raw_rel is not null
     and raw_rel not in (
       'spouse', 'partner', 'parent', 'child', 'sibling', 'friend', 'other'
     ) then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':invalid_relationship';
  end if;

  select *
    into existing
    from public.safety_circle_members
   where public.safety_circle_members.circle_id = cid
     and public.safety_circle_members.phone = raw_phone
   for update;

  if found then
    if existing.status = 'active' or existing.invite_consumed_at is not null then
      raise exception using
        errcode = 'P0001',
        message = prefix || ':already_active';
    end if;

    -- A valid pending invite already holds a slot. An expired or declined row
    -- does not, so refreshing it needs a free slot. Never a second row.
    if not public._circle_invite_holds_slot(existing) then
      perform public._require_circle_invite_slot(cid, prefix);
    end if;

    created := public._refresh_circle_invite(
      existing.id,
      prefix,
      raw_name,
      coalesce(raw_rel, existing.relationship)
    );
    return public._circle_invite_payload(created, true);
  end if;

  perform public._require_circle_invite_slot(cid, prefix);

  begin
    insert into public.safety_circle_members as scm (
      circle_id,
      role,
      status,
      display_name,
      relationship,
      phone,
      email,
      user_id,
      invited_at,
      invite_token,
      invite_expires_at
    )
    values (
      cid,
      'member',
      'pending',
      raw_name,
      raw_rel,
      raw_phone,
      null,
      null,
      now(),
      public.new_circle_invite_token(),
      now() + interval '7 days'
    )
    returning * into created;
  exception
    when unique_violation then
      select *
        into existing
        from public.safety_circle_members
       where public.safety_circle_members.circle_id = cid
         and public.safety_circle_members.phone = raw_phone
       for update;

      if not found then
        raise exception using
          errcode = 'P0001',
          message = prefix || ':duplicate_membership';
      end if;

      if existing.status = 'active' or existing.invite_consumed_at is not null then
        raise exception using
          errcode = 'P0001',
          message = prefix || ':already_active';
      end if;

      if not public._circle_invite_holds_slot(existing) then
        perform public._require_circle_invite_slot(cid, prefix);
      end if;

      created := public._refresh_circle_invite(
        existing.id,
        prefix,
        raw_name,
        coalesce(raw_rel, existing.relationship)
      );
      return public._circle_invite_payload(created, true);
    when sqlstate 'P0001' then
      if sqlerrm = 'circle_full' then
        raise exception using
          errcode = 'P0001',
          message = prefix || ':circle_full';
      end if;
      raise;
  end;

  return public._circle_invite_payload(created, false);
end;
$$;

create or replace function public.invite_circle_members_by_phone(p_invites jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  prefix constant text := 'invite_circle_members_by_phone';
  cid uuid;
  item jsonb;
  raw_phone text;
  raw_name text;
  shown_phone text;
  existing public.safety_circle_members%rowtype;
  created public.safety_circle_members%rowtype;
  created_rows jsonb := '[]'::jsonb;
  skipped jsonb := '[]'::jsonb;
  not_created jsonb := '[]'::jsonb;
  available integer;
begin
  cid := public._owner_circle_for_invite(prefix);

  if p_invites is null or jsonb_typeof(p_invites) <> 'array' then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':invalid_invites';
  end if;

  available := coalesce(
    (public._circle_invite_capacity_json(cid)->>'available')::integer,
    0
  );

  for item in
    select elem
      from jsonb_array_elements(p_invites) as t(elem)
  loop
    if item is null or jsonb_typeof(item) <> 'object' then
      not_created := not_created || jsonb_build_array(
        jsonb_build_object(
          'phone', null,
          'display_name', null,
          'reason', 'invalid_invite'
        )
      );
      continue;
    end if;

    raw_name := trim(coalesce(item->>'display_name', ''));
    raw_phone := public._normalize_e164(item->>'phone');
    shown_phone := coalesce(raw_phone, nullif(btrim(coalesce(item->>'phone', '')), ''));

    if raw_phone is null or raw_phone !~ '^\+[1-9][0-9]{7,14}$' then
      not_created := not_created || jsonb_build_array(
        jsonb_build_object(
          'phone', shown_phone,
          'display_name', nullif(raw_name, ''),
          'reason', 'invalid_phone'
        )
      );
      continue;
    end if;

    if char_length(raw_name) = 0 then
      not_created := not_created || jsonb_build_array(
        jsonb_build_object(
          'phone', raw_phone,
          'display_name', null,
          'reason', 'invalid_display_name'
        )
      );
      continue;
    end if;

    select *
      into existing
      from public.safety_circle_members
     where public.safety_circle_members.circle_id = cid
       and public.safety_circle_members.phone = raw_phone
     for update;

    if found and (
      existing.status = 'active' or existing.invite_consumed_at is not null
    ) then
      skipped := skipped || jsonb_build_array(
        jsonb_build_object(
          'phone', raw_phone,
          'display_name', raw_name,
          'reason', 'already_active',
          'member_id', existing.id
        )
      );
      continue;
    end if;

    -- Valid pending only. An expired pending row is refreshed below and
    -- needs a free slot, like a declined row.
    if found and public._circle_invite_holds_slot(existing) then
      skipped := skipped || jsonb_build_array(
        jsonb_build_object(
          'phone', raw_phone,
          'display_name', raw_name,
          'reason', 'already_pending',
          'member_id', existing.id
        )
      );
      continue;
    end if;

    if available <= 0 then
      not_created := not_created || jsonb_build_array(
        jsonb_build_object(
          'phone', raw_phone,
          'display_name', raw_name,
          'reason', 'circle_full'
        )
      );
      continue;
    end if;

    if found then
      begin
        created := public._refresh_circle_invite(
          existing.id,
          prefix,
          raw_name
        );
        created_rows := created_rows || jsonb_build_array(
          public._circle_invite_payload(created, true)
        );
        available := available - 1;
      exception
        when sqlstate 'P0001' then
          if sqlerrm = 'circle_full' then
            not_created := not_created || jsonb_build_array(
              jsonb_build_object(
                'phone', raw_phone,
                'display_name', raw_name,
                'reason', 'circle_full'
              )
            );
          elsif sqlerrm = prefix || ':already_active' then
            skipped := skipped || jsonb_build_array(
              jsonb_build_object(
                'phone', raw_phone,
                'display_name', raw_name,
                'reason', 'already_active',
                'member_id', existing.id
              )
            );
          else
            raise;
          end if;
      end;
      continue;
    end if;

    begin
      insert into public.safety_circle_members as scm (
        circle_id,
        role,
        status,
        display_name,
        relationship,
        phone,
        email,
        user_id,
        invited_at,
        invite_token,
        invite_expires_at
      )
      values (
        cid,
        'member',
        'pending',
        raw_name,
        null,
        raw_phone,
        null,
        null,
        now(),
        public.new_circle_invite_token(),
        now() + interval '7 days'
      )
      returning * into created;

      created_rows := created_rows || jsonb_build_array(
        public._circle_invite_payload(created, false)
      );
      available := available - 1;
    exception
      when unique_violation then
        select *
          into existing
          from public.safety_circle_members
         where public.safety_circle_members.circle_id = cid
           and public.safety_circle_members.phone = raw_phone
         for update;

        if not found then
          not_created := not_created || jsonb_build_array(
            jsonb_build_object(
              'phone', raw_phone,
              'display_name', raw_name,
              'reason', 'duplicate_membership'
            )
          );
        elsif existing.status = 'active'
           or existing.invite_consumed_at is not null then
          skipped := skipped || jsonb_build_array(
            jsonb_build_object(
              'phone', raw_phone,
              'display_name', raw_name,
              'reason', 'already_active',
              'member_id', existing.id
            )
          );
        elsif existing.status = 'pending' then
          skipped := skipped || jsonb_build_array(
            jsonb_build_object(
              'phone', raw_phone,
              'display_name', raw_name,
              'reason', 'already_pending',
              'member_id', existing.id
            )
          );
        else
          not_created := not_created || jsonb_build_array(
            jsonb_build_object(
              'phone', raw_phone,
              'display_name', raw_name,
              'reason', 'duplicate_membership'
            )
          );
        end if;
      when sqlstate 'P0001' then
        if sqlerrm = 'circle_full' then
          not_created := not_created || jsonb_build_array(
            jsonb_build_object(
              'phone', raw_phone,
              'display_name', raw_name,
              'reason', 'circle_full'
            )
          );
        else
          raise;
        end if;
    end;
  end loop;

  return jsonb_build_object(
    'created', created_rows,
    'skipped', skipped,
    'not_created', not_created,
    'available_after', coalesce(
      (public._circle_invite_capacity_json(cid)->>'available')::integer,
      0
    )
  );
end;
$$;

comment on function public.invite_circle_member_by_phone(text, text, text) is
  'SCRUM-27 / fix #14: Owner-only. E.164 phone invite, or refresh the existing row for that phone. Refreshing a valid pending row takes no new slot; a declined or expired row needs one (circle_full when available is 0). Does not insert a second row. 7-day single-use token. Does not send SMS.';

comment on function public.invite_circle_members_by_phone(jsonb) is
  'SCRUM-27 / fix #14: Owner-only batch of {phone, display_name}. Normalizes E.164. Skips active and valid pending (already_pending) without a second row. An expired pending phone is refreshed (resent true) when a slot is free, else circle_full. One transaction. Does not send SMS.';

-- ---------------------------------------------------------------------------
-- resend_circle_invite: works on expired; re-checks capacity
-- ---------------------------------------------------------------------------

create or replace function public.resend_circle_invite(member_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  prefix constant text := 'resend_circle_invite';
  cid uuid;
  existing public.safety_circle_members%rowtype;
  created public.safety_circle_members%rowtype;
begin
  cid := public._owner_circle_for_invite(prefix);

  if member_id is null then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':member_not_found';
  end if;

  select *
    into existing
    from public.safety_circle_members
   where public.safety_circle_members.id = member_id
     and public.safety_circle_members.circle_id = cid
   for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':member_not_found';
  end if;

  -- Declined or expired rows do not hold a slot, so the resend takes one.
  if existing.role = 'member'
     and existing.status is distinct from 'active'
     and existing.invite_consumed_at is null
     and not public._circle_invite_holds_slot(existing) then
    perform public._require_circle_invite_slot(cid, prefix);
  end if;

  begin
    created := public._refresh_circle_invite(existing.id, prefix);
  exception
    when sqlstate 'P0001' then
      if sqlerrm = 'circle_full' then
        raise exception using
          errcode = 'P0001',
          message = prefix || ':circle_full';
      end if;
      raise;
  end;

  return public._circle_invite_payload(created, true);
end;
$$;

comment on function public.resend_circle_invite(uuid) is
  'SCRUM-27 / fix #14: Owner-only. Same row: new token, invited_at now, invite_expires_at now + 7 days. Valid pending refresh takes no new slot. Declined or expired pending takes a slot and raises resend_circle_invite:circle_full when available is 0. Active/consumed still already_active. Does not send SMS.';

-- ---------------------------------------------------------------------------
-- accept_circle_invite: store the accepter's profile name (fix #18)
-- ---------------------------------------------------------------------------

create or replace function public.accept_circle_invite(token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  prefix constant text := 'accept_circle_invite';
  uid uuid;
  auth_phone text;
  raw text := trim(coalesce(token, ''));
  cid uuid;
  m public.safety_circle_members%rowtype;
  st text;
  circle_owner uuid;
  used_after integer;
begin
  uid := public._require_auth_uid(prefix);
  auth_phone := public._auth_user_phone(uid);

  if char_length(raw) = 0 then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':not_found';
  end if;

  -- Circle lock first, same order as the SCRUM-27 invite RPCs, so two accepts
  -- cannot both pass the capacity check.
  select scm.circle_id
    into cid
    from public.safety_circle_members scm
   where scm.invite_token = raw;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':not_found';
  end if;

  perform 1
    from public.safety_circles sc
   where sc.id = cid
   for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':not_found';
  end if;

  select *
    into m
    from public.safety_circle_members scm
   where scm.invite_token = raw
   for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':not_found';
  end if;

  -- Same token, already active for this caller: success, no second row.
  if m.status = 'active' and m.user_id = uid then
    return jsonb_build_object(
      'circle_id', m.circle_id,
      'member_id', m.id,
      'status', 'active',
      'owner_name', public._circle_owner_display_name(m.circle_id)
    );
  end if;

  st := public._circle_invite_lookup_status(m);
  perform public._reject_unless_pending(prefix, st);

  if not public._circle_invite_recipient_ok(m, uid, auth_phone) then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':not_recipient';
  end if;

  select sc.owner_id
    into circle_owner
    from public.safety_circles sc
   where sc.id = m.circle_id;

  if circle_owner = uid then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':own_circle';
  end if;

  if public._circle_has_active_membership(m.circle_id, uid, m.id) then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':already_member';
  end if;

  used_after := public._circle_accept_used_after(m.circle_id, m.id);
  if used_after > public._circle_member_limit() then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':circle_full';
  end if;

  begin
    update public.safety_circle_members
       set user_id = uid,
           status = 'active',
           -- Member names fix #18: the accepter's own profile name, so the owner
           -- and other members recognise them. Stored name if no profile name.
           display_name = coalesce(
             public._member_profile_name(uid),
             m.display_name
           ),
           invite_consumed_at = now(),
           invite_canceled_at = null,
           updated_at = now()
     where public.safety_circle_members.id = m.id
     returning * into m;
  exception
    when unique_violation then
      raise exception using
        errcode = 'P0001',
        message = prefix || ':duplicate_membership';
  end;

  return jsonb_build_object(
    'circle_id', m.circle_id,
    'member_id', m.id,
    'status', m.status,
    'owner_name', public._circle_owner_display_name(m.circle_id)
  );
end;
$$;

comment on function public.accept_circle_invite(text) is
  'SCRUM-28 / fix #18: Pending + recipient. Expired token still raises accept_circle_invite:expired. On accept stores the accepter''s profile full name as display_name (via _member_profile_name; stored name kept if none). Does not write profiles and does not require location sharing. Owner gets own_circle. Over-capacity (active + valid pending) gets circle_full and no write. No SMS/push/email.';

-- ---------------------------------------------------------------------------
-- cancel_circle_invite: pending or expired
-- ---------------------------------------------------------------------------

create or replace function public.cancel_circle_invite(member_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  prefix constant text := 'cancel_circle_invite';
  uid uuid;
  m public.safety_circle_members%rowtype;
  caller_is_owner boolean := false;
  lookup_status text;
begin
  uid := public._require_auth_uid(prefix);

  if cancel_circle_invite.member_id is null then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':not_found';
  end if;

  select *
    into m
    from public.safety_circle_members
   where public.safety_circle_members.id = cancel_circle_invite.member_id
   for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':not_found';
  end if;

  select exists (
    select 1
      from public.safety_circles c
     where c.id = m.circle_id
       and c.owner_id = uid
  )
    into caller_is_owner;

  if not caller_is_owner then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':not_authorized';
  end if;

  if m.role = 'owner' then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':cannot_cancel_owner';
  end if;

  lookup_status := public._circle_invite_lookup_status(m);

  -- Fix #14: an expired invite can be cleared too (it already holds no slot).
  if lookup_status not in ('pending', 'expired') then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':not_pending';
  end if;

  update public.safety_circle_members
     set status = 'declined',
         invite_canceled_at = now()
   where public.safety_circle_members.id = m.id;

  return jsonb_build_object(
    'member_id', m.id,
    'circle_id', m.circle_id,
    'status', 'canceled',
    'owner_name', public._circle_owner_display_name(m.circle_id)
  );
end;
$$;

comment on function public.cancel_circle_invite(uuid) is
  'SCRUM-29 / fix #14: Owner-only. Pending or expired invite. Sets declined and invite_canceled_at so the token looks up as canceled and any slot is released. Active / declined: not_pending. Does not delete the row, write profiles, or send SMS/email/push.';

-- ---------------------------------------------------------------------------
-- list_circle_members: profile names for active rows; expired for owner
-- ---------------------------------------------------------------------------

create or replace function public.list_circle_members(circle_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  prefix constant text := 'list_circle_members';
  uid uuid;
  circle_exists boolean := false;
  caller_is_owner boolean := false;
  caller_is_active boolean := false;
begin
  uid := public._require_auth_uid(prefix);

  if list_circle_members.circle_id is null then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':not_found';
  end if;

  select exists (
    select 1
      from public.safety_circles c
     where c.id = list_circle_members.circle_id
  )
    into circle_exists;

  if not circle_exists then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':not_found';
  end if;

  select exists (
    select 1
      from public.safety_circles c
     where c.id = list_circle_members.circle_id
       and c.owner_id = uid
  )
    into caller_is_owner;

  select exists (
    select 1
      from public.safety_circle_members mem
     where mem.circle_id = list_circle_members.circle_id
       and mem.user_id = uid
       and mem.status = 'active'
  )
    into caller_is_active;

  if not caller_is_owner and not caller_is_active then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':not_authorized';
  end if;

  return (
    select coalesce(
      jsonb_agg(payload order by sort_owner desc, sort_status, display_sort, invited_sort),
      '[]'::jsonb
    )
    from (
      select
        case
          when caller_is_owner then
            jsonb_build_object(
              'member_id', r.id,
              'role', r.role,
              'status', r.shown_status,
              'display_name', r.shown_name,
              'is_owner', r.role = 'owner',
              'invited_at', r.invited_at,
              'user_id', r.user_id,
              'avatar_url', case
                when r.user_id is not null
                then public._member_avatar_url(r.user_id)
                else null
              end,
              'phone', r.phone,
              'email', r.email,
              'relationship', r.relationship,
              'invite_expires_at', r.invite_expires_at,
              'invite_consumed_at', r.invite_consumed_at,
              'invite_canceled_at', r.invite_canceled_at
            )
          else
            jsonb_build_object(
              'member_id', r.id,
              'role', r.role,
              'status', r.shown_status,
              'display_name', r.shown_name,
              'is_owner', r.role = 'owner',
              'invited_at', r.invited_at,
              'user_id', r.user_id,
              'avatar_url', case
                when r.user_id is not null
                then public._member_avatar_url(r.user_id)
                else null
              end
            )
        end as payload,
        (r.role = 'owner') as sort_owner,
        case r.shown_status
          when 'active' then 0
          when 'pending' then 1
          when 'expired' then 2
          when 'declined' then 3
          else 4
        end as sort_status,
        lower(r.shown_name) as display_sort,
        r.invited_at as invited_sort
      from (
        select
          scm.id,
          scm.role,
          scm.user_id,
          scm.invited_at,
          scm.phone,
          scm.email,
          scm.relationship,
          scm.invite_expires_at,
          scm.invite_consumed_at,
          scm.invite_canceled_at,
          -- Fix #18: active members are shown by their own profile name.
          -- Pending rows keep the invite name ("Invited member" for links).
          case
            when scm.status = 'active' and scm.user_id is not null
              then coalesce(
                public._member_profile_name(scm.user_id),
                scm.display_name
              )
            else scm.display_name
          end as shown_name,
          -- Fix #14: lookup-style value in JSON only; stored status stays.
          case
            when scm.status = 'pending'
                 and public._circle_invite_lookup_status(scm) = 'expired'
              then 'expired'
            else scm.status
          end as shown_status
        from public.safety_circle_members scm
        where scm.circle_id = list_circle_members.circle_id
          and (
            caller_is_owner
            or scm.status = 'active'
          )
      ) r
    ) listed
  );
end;
$$;

comment on function public.list_circle_members(uuid) is
  'SCRUM-29 / SCRUM-28 / fixes #18 #14: Owner lists every row; a pending row past invite_expires_at is returned with status expired (stored status stays pending). An active non-owner lists active rows only. Active rows with a user show that user''s profile full name (stored name if empty) and avatar_url. Non-owners do not receive phone, email, relationship, invite token, or emergency fields.';

-- ---------------------------------------------------------------------------
-- complete_profile_setup: re-run after decline/cancel gives a usable invite
-- ---------------------------------------------------------------------------

create or replace function public.complete_profile_setup()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  p public.profiles%rowtype;
  v_circle_id uuid;
  v_member_id uuid;
  v_member_status text;
  v_completed_at timestamptz;
  v_contact_email text;
  v_invite_tok text;
  v_invite_exp timestamptz;
begin
  if uid is null then
    raise exception using
      errcode = 'P0001',
      message = 'complete_profile_setup:not_authenticated';
  end if;

  select *
    into p
    from public.profiles
   where public.profiles.id = uid
   for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = 'complete_profile_setup:profile_not_found';
  end if;

  if p.personal_info_completed_at is null
     or char_length(trim(p.full_name)) = 0
     or p.date_of_birth is null then
    raise exception using
      errcode = 'P0001',
      message = 'complete_profile_setup:personal_info_incomplete';
  end if;

  if p.emergency_info_completed_at is null
     or p.emergency_contact_full_name is null
     or char_length(trim(p.emergency_contact_full_name)) = 0
     or p.emergency_contact_relationship is null
     or p.emergency_contact_phone is null
     or p.emergency_contact_phone !~ '^\+[1-9][0-9]{7,14}$' then
    raise exception using
      errcode = 'P0001',
      message = 'complete_profile_setup:emergency_info_incomplete';
  end if;

  if p.preferences_completed_at is null then
    raise exception using
      errcode = 'P0001',
      message = 'complete_profile_setup:preferences_incomplete';
  end if;

  update public.profiles
     set profile_setup_completed_at = coalesce(
           public.profiles.profile_setup_completed_at,
           now()
         )
   where public.profiles.id = uid
   returning public.profiles.profile_setup_completed_at into v_completed_at;

  if not p.location_sharing_enabled then
    return jsonb_build_object(
      'profile_setup_completed_at', v_completed_at,
      'location_sharing_enabled', false,
      'circle_id', null,
      'member_id', null,
      'member_status', null
    );
  end if;

  select sc.id
    into v_circle_id
    from public.safety_circles sc
   where sc.owner_id = uid;

  if v_circle_id is null then
    insert into public.safety_circles as sc (owner_id, name)
    values (uid, 'My Safety Circle')
    returning sc.id into v_circle_id;
  end if;

  insert into public.safety_circle_members as scm (
    circle_id,
    role,
    status,
    display_name,
    relationship,
    phone,
    email,
    user_id,
    invited_at
  )
  values (
    v_circle_id,
    'owner',
    'active',
    trim(p.full_name),
    null,
    null,
    null,
    uid,
    now()
  )
  on conflict (circle_id, user_id) where user_id is not null
  do update set
    display_name = excluded.display_name,
    role = 'owner',
    status = 'active',
    updated_at = now();

  -- An expired or declined contact row no longer holds a slot. Refreshing it
  -- at 5/5 is refused by the capacity trigger; Complete must still succeed,
  -- so keep the row as it is and report its stored status.
  begin
    v_contact_email := nullif(trim(coalesce(p.emergency_contact_email, '')), '');
    v_invite_tok := public.new_circle_invite_token();
    v_invite_exp := now() + interval '7 days';

    insert into public.safety_circle_members as scm (
      circle_id,
      role,
      status,
      display_name,
      relationship,
      phone,
      email,
      user_id,
      invited_at,
      invite_token,
      invite_expires_at
    )
    values (
      v_circle_id,
      'member',
      'pending',
      trim(p.emergency_contact_full_name),
      p.emergency_contact_relationship,
      p.emergency_contact_phone,
      v_contact_email,
      null,
      now(),
      v_invite_tok,
      v_invite_exp
    )
    on conflict (circle_id, phone) where phone is not null
    do update set
      display_name = excluded.display_name,
      relationship = excluded.relationship,
      email = excluded.email,
      status = case
        when scm.status = 'active' then 'active'
        else 'pending'
      end,
      invited_at = case
        when scm.status = 'active'
          then scm.invited_at
        else now()
      end,
      -- A declined / canceled row gets a fresh token. Only a still-pending,
      -- uncanceled row keeps its token (the link the owner already shared).
      invite_token = case
        when scm.status = 'active'
          then scm.invite_token
        when scm.status = 'pending'
             and scm.invite_canceled_at is null
             and scm.invite_token is not null
          then scm.invite_token
        else excluded.invite_token
      end,
      -- Expired-invites fix #14: a re-run after decline / cancel must give a
      -- usable invite, not a token that looks up as canceled.
      invite_canceled_at = case
        when scm.status = 'active'
          then scm.invite_canceled_at
        else null
      end,
      invite_consumed_at = case
        when scm.status = 'active'
          then scm.invite_consumed_at
        else null
      end,
      user_id = case
        when scm.status = 'active'
          then scm.user_id
        when scm.status = 'pending'
             and scm.invite_canceled_at is null
          then scm.user_id
        else null
      end,
      invite_expires_at = case
        when scm.status = 'active'
          then scm.invite_expires_at
        else excluded.invite_expires_at
      end,
      updated_at = now()
    returning scm.id, scm.status into v_member_id, v_member_status;
  exception
    when sqlstate 'P0001' then
      if sqlerrm <> 'circle_full' then
        raise;
      end if;
      select scm.id, scm.status
        into v_member_id, v_member_status
        from public.safety_circle_members scm
       where scm.circle_id = v_circle_id
         and scm.phone = p.emergency_contact_phone;
  end;

  return jsonb_build_object(
    'profile_setup_completed_at', v_completed_at,
    'location_sharing_enabled', true,
    'circle_id', v_circle_id,
    'member_id', v_member_id,
    'member_status', v_member_status
  );
end;
$$;

comment on function public.complete_profile_setup() is
  'SCRUM-80 / 27 / fix #14: Atomic Complete. Sets profile_setup_completed_at. If location_sharing_enabled, ensures My Safety Circle + owner active member + emergency contact pending invite. A re-run on a declined/canceled contact row clears invite_canceled_at / invite_consumed_at / user_id and issues a new token + 7-day expiry; a still-pending row keeps its token and gets a new expiry. If that refresh would pass 5/5 the contact row is left as is (member_status is its stored status). Does not send SMS/email. Return JSON keys unchanged.';

-- ---------------------------------------------------------------------------
-- Backfill (fix #18): active members still named with a placeholder
-- ---------------------------------------------------------------------------

update public.safety_circle_members scm
   set display_name = public._member_profile_name(scm.user_id)
 where scm.status = 'active'
   and scm.user_id is not null
   and (
     scm.display_name is null
     or char_length(trim(scm.display_name)) = 0
     or scm.display_name = 'Invited member'
   )
   and public._member_profile_name(scm.user_id) is not null;

-- ---------------------------------------------------------------------------
-- Grants (CREATE OR REPLACE keeps them; restated)
-- ---------------------------------------------------------------------------

revoke all on function public._circle_invite_capacity_json(uuid) from public;
revoke all on function public._circle_invite_capacity_json(uuid) from anon;
revoke all on function public._circle_invite_capacity_json(uuid) from authenticated;

revoke all on function public._circle_accept_used_after(uuid, uuid) from public;
revoke all on function public._circle_accept_used_after(uuid, uuid) from anon;
revoke all on function public._circle_accept_used_after(uuid, uuid) from authenticated;

revoke all on function public.enforce_safety_circle_member_capacity() from public;
revoke all on function public.enforce_safety_circle_member_capacity() from anon;
grant execute on function public.enforce_safety_circle_member_capacity() to authenticated;

revoke all on function public.invite_circle_member_by_phone(text, text, text) from public;
revoke all on function public.invite_circle_member_by_phone(text, text, text) from anon;
grant execute on function public.invite_circle_member_by_phone(text, text, text) to authenticated;

revoke all on function public.invite_circle_members_by_phone(jsonb) from public;
revoke all on function public.invite_circle_members_by_phone(jsonb) from anon;
grant execute on function public.invite_circle_members_by_phone(jsonb) to authenticated;

revoke all on function public.resend_circle_invite(uuid) from public;
revoke all on function public.resend_circle_invite(uuid) from anon;
grant execute on function public.resend_circle_invite(uuid) to authenticated;

revoke all on function public.accept_circle_invite(text) from public;
revoke all on function public.accept_circle_invite(text) from anon;
grant execute on function public.accept_circle_invite(text) to authenticated;

revoke all on function public.cancel_circle_invite(uuid) from public;
revoke all on function public.cancel_circle_invite(uuid) from anon;
grant execute on function public.cancel_circle_invite(uuid) to authenticated;

revoke all on function public.list_circle_members(uuid) from public;
revoke all on function public.list_circle_members(uuid) from anon;
grant execute on function public.list_circle_members(uuid) to authenticated;

revoke all on function public.complete_profile_setup() from public;
revoke all on function public.complete_profile_setup() from anon;
grant execute on function public.complete_profile_setup() to authenticated;

notify pgrst, 'reload schema';
