-- SCRUM-27: A personal Safety Circle holds at most 5 trusted members,
-- excluding the owner. Active members and pending invitations both count,
-- including the onboarding emergency-contact pending row. Declined does not.
-- available = greatest(0, 5 - (active + pending)).
-- create_circle_invite_link reserves one pending slot and does not activate.
-- No SMS, email, or push. Does not add SCRUM-33 cancel.

-- ---------------------------------------------------------------------------
-- Limit and capacity snapshot
-- ---------------------------------------------------------------------------

create or replace function public._circle_member_limit()
returns integer
language sql
immutable
parallel safe
set search_path = public
as $$
  select 5;
$$;

comment on function public._circle_member_limit() is
  'SCRUM-27: Trusted-member cap excluding the owner. Internal.';

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
        where scm.role = 'member' and scm.status = 'pending'
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
  'SCRUM-27: limit 5, active_count, pending_count, used, available. Owner row excluded. Declined excluded. Pending includes the emergency-contact row and expired-but-still-pending rows. Internal.';

create or replace function public._require_circle_invite_slot(
  p_circle_id uuid,
  err_prefix text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform 1
    from public.safety_circles sc
   where sc.id = p_circle_id
   for update;

  if coalesce(
       (public._circle_invite_capacity_json(p_circle_id)->>'available')::integer,
       0
     ) <= 0 then
    raise exception using
      errcode = 'P0001',
      message = err_prefix || ':circle_full';
  end if;
end;
$$;

comment on function public._require_circle_invite_slot(uuid, text) is
  'SCRUM-27: Lock the circle row, then refuse with {prefix}:circle_full when available is 0. Call before an insert or before a non-pending row becomes pending. Internal.';

-- ---------------------------------------------------------------------------
-- Integrity: no insert, and no update that newly occupies a slot, past 5.
-- Already-occupying updates (pending resend, pending accept → active) pass.
-- ---------------------------------------------------------------------------

create or replace function public.enforce_safety_circle_member_capacity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  new_occupies boolean;
  old_occupies boolean;
begin
  new_occupies := new.role = 'member'
    and new.status in ('pending', 'active');

  if not new_occupies then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    old_occupies := old.role = 'member'
      and old.status in ('pending', 'active');
    if old_occupies then
      return new;
    end if;
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
  'SCRUM-27: Reject a new active/pending member slot when the circle already has 5. Message is circle_full. Invite RPCs catch this and rethrow {rpc}:circle_full. Internal.';

drop trigger if exists safety_circle_members_enforce_capacity
  on public.safety_circle_members;

create trigger safety_circle_members_enforce_capacity
  before insert or update on public.safety_circle_members
  for each row
  execute function public.enforce_safety_circle_member_capacity();

-- ---------------------------------------------------------------------------
-- circle_invite_capacity() — signed-in owner only
-- ---------------------------------------------------------------------------

create or replace function public.circle_invite_capacity()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  cid uuid;
begin
  if uid is null then
    raise exception using
      errcode = 'P0001',
      message = 'circle_invite_capacity:not_authenticated';
  end if;

  select sc.id
    into cid
    from public.safety_circles sc
   where sc.owner_id = uid;

  if cid is null then
    raise exception using
      errcode = 'P0001',
      message = 'circle_invite_capacity:not_owner';
  end if;

  return public._circle_invite_capacity_json(cid);
end;
$$;

comment on function public.circle_invite_capacity() is
  'SCRUM-27: Owner-only capacity. Returns limit, active_count, pending_count, used, available. Non-owners get not_owner. Does not require location sharing. Does not send SMS.';

-- ---------------------------------------------------------------------------
-- invite_circle_member_by_phone — same args; refuse before a new slot
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

    -- Pending already occupies a slot. Refresh in place; never a second row.
    if existing.status is distinct from 'pending' then
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

      if existing.status is distinct from 'pending' then
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

comment on function public.invite_circle_member_by_phone(text, text, text) is
  'SCRUM-27: Owner-only. E.164 phone invite, or refresh the existing row for that phone. New slot refused with circle_full when available is 0. Does not insert a second row. 7-day single-use token. Does not send SMS.';

-- ---------------------------------------------------------------------------
-- create_circle_invite_link — reserves one pending slot
-- ---------------------------------------------------------------------------

create or replace function public.create_circle_invite_link(
  display_name text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  prefix constant text := 'create_circle_invite_link';
  cid uuid;
  raw_name text;
  created public.safety_circle_members%rowtype;
begin
  cid := public._owner_circle_for_invite(prefix);

  raw_name := nullif(trim(coalesce(display_name, '')), '');
  if raw_name is null then
    raw_name := 'Invited member';
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
      null,
      null,
      null,
      null,
      now(),
      public.new_circle_invite_token(),
      now() + interval '7 days'
    )
    returning * into created;
  exception
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

comment on function public.create_circle_invite_link(text) is
  'SCRUM-27: Owner-only. Inserts one pending link invite (phone null) and reserves one slot. circle_full when available is 0, with no row left behind. 7-day single-use token. Does not activate membership. Does not send SMS.';

-- ---------------------------------------------------------------------------
-- resend: a declined row newly occupies a slot. Pending resend does not.
-- Not SCRUM-33 cancel. Same token rotation as before.
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

  if existing.role = 'member'
     and existing.status is distinct from 'active'
     and existing.invite_consumed_at is null
     and existing.status is distinct from 'pending' then
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
  'SCRUM-27: Owner-only. Rotate token and set a 7-day expiry. Pending refresh does not take a new slot. Declined → pending takes a slot and raises circle_full when available is 0. Active/consumed still already_active. Does not cancel. Does not send SMS.';

-- ---------------------------------------------------------------------------
-- invite_circle_members_by_phone(p_invites jsonb)
-- One transaction. Skip active/pending phones. Stop new rows at capacity.
-- ---------------------------------------------------------------------------

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

    if found and existing.status = 'pending' then
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

comment on function public.invite_circle_members_by_phone(jsonb) is
  'SCRUM-27: Owner-only batch of {phone, display_name}. Normalizes E.164 (including +220). Skips active and pending without a second row. Stops new rows at circle_full. One transaction. 7-day single-use tokens. Does not send SMS.';

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on function public._circle_member_limit() from public;
revoke all on function public._circle_member_limit() from anon;
revoke all on function public._circle_member_limit() from authenticated;

revoke all on function public._circle_invite_capacity_json(uuid) from public;
revoke all on function public._circle_invite_capacity_json(uuid) from anon;
revoke all on function public._circle_invite_capacity_json(uuid) from authenticated;

revoke all on function public._require_circle_invite_slot(uuid, text) from public;
revoke all on function public._require_circle_invite_slot(uuid, text) from anon;
revoke all on function public._require_circle_invite_slot(uuid, text) from authenticated;

revoke all on function public.enforce_safety_circle_member_capacity() from public;
revoke all on function public.enforce_safety_circle_member_capacity() from anon;
grant execute on function public.enforce_safety_circle_member_capacity() to authenticated;

revoke all on function public.circle_invite_capacity() from public;
revoke all on function public.circle_invite_capacity() from anon;
grant execute on function public.circle_invite_capacity() to authenticated;

revoke all on function public.invite_circle_member_by_phone(text, text, text) from public;
revoke all on function public.invite_circle_member_by_phone(text, text, text) from anon;
grant execute on function public.invite_circle_member_by_phone(text, text, text) to authenticated;

revoke all on function public.create_circle_invite_link(text) from public;
revoke all on function public.create_circle_invite_link(text) from anon;
grant execute on function public.create_circle_invite_link(text) to authenticated;

revoke all on function public.resend_circle_invite(uuid) from public;
revoke all on function public.resend_circle_invite(uuid) from anon;
grant execute on function public.resend_circle_invite(uuid) to authenticated;

revoke all on function public.invite_circle_members_by_phone(jsonb) from public;
revoke all on function public.invite_circle_members_by_phone(jsonb) from anon;
grant execute on function public.invite_circle_members_by_phone(jsonb) to authenticated;

notify pgrst, 'reload schema';
