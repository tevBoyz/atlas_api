-- SCRUM-29 cancel amendment checks. Run as one script against the hosted database.
-- All writes stay inside this DO block. The block ends by raising
-- scrum29_cancel_invite_ok so PostgreSQL rolls the test rows back.
-- A different error is a failed assert.

do $scrum29$
declare
  suffix text;
  phone_owner text;
  phone_member text;
  owner uuid := gen_random_uuid();
  member uuid := gen_random_uuid();
  cid uuid := gen_random_uuid();
  owner_member_id uuid;
  pending_id uuid;
  expired_id uuid;
  active_id uuid;
  declined_id uuid;
  t_pending text;
  t_expired text;
  src text;
  canceled jsonb;
  lookup jsonb;
  listed jsonb;
  cap jsonb;
  members jsonb;
  row_status text;
  row_role text;
  row_token text;
  row_canceled timestamptz;
  row_consumed timestamptz;
  row_updated timestamptz;
  saved_canceled timestamptz;
  saved_updated timestamptz;
  profile_updated timestamptz;
  profile_updated_after timestamptz;
  emergency_name text;
  circle_count integer;
  member_rows integer;
  i integer;
begin
  select pg_get_functiondef('public.cancel_circle_invite(uuid)'::regprocedure)
    into src;
  if src ilike '%delete from%'
     or src ilike '%profiles%'
     or src ilike '%invite_consumed_at%' then
    raise exception 'cancel_circle_invite deletes, touches profiles, or consumes';
  end if;

  select pg_get_functiondef('public.list_my_joined_circles()'::regprocedure)
    into src;
  if src not ilike '%active_member_count%'
     or src ilike '%phone%'
     or src ilike '%email%'
     or src ilike '%emergency%'
     or src ilike '%medical%' then
    raise exception 'list_my_joined_circles count or privacy regressed';
  end if;

  select pg_get_functiondef('public.remove_circle_member(uuid)'::regprocedure)
    into src;
  if src not ilike '%delete from public.safety_circle_members%'
     or src ilike '%invite_canceled_at%' then
    raise exception 'remove_circle_member was changed';
  end if;

  select pg_get_functiondef('public.leave_safety_circle(uuid)'::regprocedure)
    into src;
  if src not ilike '%delete from public.safety_circle_members%'
     or src ilike '%invite_canceled_at%' then
    raise exception 'leave_safety_circle was changed';
  end if;

  if has_function_privilege(
       'anon',
       'public.cancel_circle_invite(uuid)',
       'execute'
     ) then
    raise exception 'anon can execute cancel_circle_invite';
  end if;
  if not has_function_privilege(
       'authenticated',
       'public.cancel_circle_invite(uuid)',
       'execute'
     ) then
    raise exception 'authenticated cannot execute cancel_circle_invite';
  end if;

  suffix := null;
  for i in 1..30 loop
    suffix := lpad((floor(random() * 100000))::int::text, 5, '0');
    if not exists (
      select 1
        from auth.users u
       where u.phone like '+220398' || suffix || '%'
    ) and not exists (
      select 1
        from public.safety_circle_members m
       where m.phone like '+220398' || suffix || '%'
    ) then
      exit;
    end if;
    suffix := null;
  end loop;
  if suffix is null then
    raise exception 'could not allocate test phones';
  end if;

  phone_owner := '+220398' || suffix || '1';
  phone_member := '+220398' || suffix || '2';

  insert into auth.users (id, phone, phone_confirmed_at)
  values
    (owner, phone_owner, now()),
    (member, phone_member, now());

  insert into public.profiles (id, full_name, date_of_birth)
  values
    (owner, 'Owner Cancel', date '1990-01-01'),
    (member, 'Active Member', date '1992-02-02');

  select p.updated_at, p.emergency_contact_full_name
    into profile_updated, emergency_name
    from public.profiles p
   where p.id = owner;

  t_pending := public.new_circle_invite_token();
  t_expired := public.new_circle_invite_token();

  insert into public.safety_circles (id, owner_id, name)
  values (cid, owner, 'My Safety Circle');

  insert into public.safety_circle_members (
    circle_id, role, status, display_name, user_id
  )
  values (cid, 'owner', 'active', 'Owner Cancel', owner)
  returning id into owner_member_id;

  insert into public.safety_circle_members (
    circle_id, role, status, display_name, user_id, invite_consumed_at
  )
  values (
    cid, 'member', 'active', 'Active Member', member, now()
  )
  returning id into active_id;

  insert into public.safety_circle_members (
    circle_id, role, status, display_name, invite_token, invite_expires_at
  )
  values (
    cid,
    'member',
    'pending',
    'Pending Invite',
    t_pending,
    now() + interval '7 days'
  )
  returning id into pending_id;

  insert into public.safety_circle_members (
    circle_id, role, status, display_name, invite_token, invite_expires_at
  )
  values (
    cid,
    'member',
    'pending',
    'Expired Invite',
    t_expired,
    now() - interval '1 day'
  )
  returning id into expired_id;

  insert into public.safety_circle_members (
    circle_id, role, status, display_name, invite_canceled_at
  )
  values (
    cid, 'member', 'declined', 'Already Declined', now()
  )
  returning id into declined_id;

  -- Fix #14 (2026-11-17): the expired pending row holds no slot.
  cap := public._circle_invite_capacity_json(cid);
  if (cap->>'active_count')::integer is distinct from 1
     or (cap->>'pending_count')::integer is distinct from 1
     or (cap->>'used')::integer is distinct from 2
     or (cap->>'available')::integer is distinct from 3 then
    raise exception 'capacity baseline failed: %', cap;
  end if;

  perform set_config('request.jwt.claim.sub', owner::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', owner, 'role', 'authenticated')::text,
    true
  );

  select elem
    into listed
    from jsonb_array_elements(public.list_my_joined_circles()) elem
   where elem->>'circle_id' = cid::text;
  if listed is null
     or listed->>'role' is distinct from 'owner'
     or listed->>'status' is distinct from 'active'
     or listed->>'name' is distinct from 'My Safety Circle'
     or listed->>'owner_name' is distinct from 'Owner Cancel'
     or listed->>'member_id' is distinct from owner_member_id::text
     or (listed->>'active_member_count')::integer is distinct from 1
     or listed->>'joined_at' is null
     or not (
       listed ? 'circle_id' and listed ? 'name' and listed ? 'role'
       and listed ? 'member_id' and listed ? 'status'
       and listed ? 'owner_name' and listed ? 'joined_at'
       and listed ? 'active_member_count'
     )
     or listed ? 'phone' or listed ? 'email'
     or listed ? 'emergency_contact_full_name'
     or listed ? 'blood_type' or listed ? 'allergies'
     or listed ? 'medical_conditions' then
    raise exception 'owner joined count failed: %', listed;
  end if;

  perform set_config('request.jwt.claim.sub', member::text, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', member, 'role', 'authenticated')::text,
    true
  );

  select elem
    into listed
    from jsonb_array_elements(public.list_my_joined_circles()) elem
   where elem->>'circle_id' = cid::text;
  if listed is null
     or listed->>'role' is distinct from 'member'
     or listed->>'member_id' is distinct from active_id::text
     or (listed->>'active_member_count')::integer is distinct from 1
     or listed ? 'phone' or listed ? 'email' then
    raise exception 'member joined count failed: %', listed;
  end if;

  members := public.list_circle_members(cid);
  if exists (
    select 1
      from jsonb_array_elements(members) elem
     where elem ? 'phone' or elem ? 'email' or elem ? 'relationship'
  ) or exists (
    select 1
      from jsonb_array_elements(members) elem
     where elem->>'status' = 'pending'
  ) then
    raise exception 'non-owner member list leaked contact or pending: %', members;
  end if;

  select m.updated_at
    into saved_updated
    from public.safety_circle_members m
   where m.id = pending_id;

  begin
    perform public.cancel_circle_invite(pending_id);
    raise exception 'non-owner cancel did not raise';
  exception
    when sqlstate 'P0001' then
      if sqlerrm not like '%cancel_circle_invite:not_authorized%' then
        raise exception 'non-owner cancel got %', sqlerrm;
      end if;
  end;

  select m.status, m.invite_canceled_at, m.invite_consumed_at, m.updated_at
    into row_status, row_canceled, row_consumed, row_updated
    from public.safety_circle_members m
   where m.id = pending_id;
  if row_status is distinct from 'pending'
     or row_canceled is not null
     or row_consumed is not null
     or row_updated is distinct from saved_updated then
    raise exception 'non-owner cancel wrote the invite';
  end if;

  perform set_config('request.jwt.claim.sub', owner::text, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', owner, 'role', 'authenticated')::text,
    true
  );

  members := public.list_circle_members(cid);
  if not exists (
    select 1
      from jsonb_array_elements(members) elem
     where elem->>'member_id' = pending_id::text
       and elem ? 'phone'
       and elem ? 'email'
       and elem ? 'relationship'
  ) then
    raise exception 'owner member list dropped contact keys: %', members;
  end if;

  begin
    perform public.cancel_circle_invite(null);
    raise exception 'null member id did not raise';
  exception
    when sqlstate 'P0001' then
      if sqlerrm not like '%cancel_circle_invite:not_found%' then
        raise exception 'null member id got %', sqlerrm;
      end if;
  end;

  begin
    perform public.cancel_circle_invite(gen_random_uuid());
    raise exception 'unknown member id did not raise';
  exception
    when sqlstate 'P0001' then
      if sqlerrm not like '%cancel_circle_invite:not_found%' then
        raise exception 'unknown member id got %', sqlerrm;
      end if;
  end;

  begin
    perform public.cancel_circle_invite(owner_member_id);
    raise exception 'owner-row cancel did not raise';
  exception
    when sqlstate 'P0001' then
      if sqlerrm not like '%cancel_circle_invite:cannot_cancel_owner%' then
        raise exception 'owner-row cancel got %', sqlerrm;
      end if;
  end;

  select m.status, m.role, m.invite_canceled_at
    into row_status, row_role, row_canceled
    from public.safety_circle_members m
   where m.id = owner_member_id;
  if row_status is distinct from 'active'
     or row_role is distinct from 'owner'
     or row_canceled is not null then
    raise exception 'owner-row cancel wrote the owner';
  end if;

  begin
    perform public.cancel_circle_invite(active_id);
    raise exception 'active cancel did not raise';
  exception
    when sqlstate 'P0001' then
      if sqlerrm not like '%cancel_circle_invite:not_pending%' then
        raise exception 'active cancel got %', sqlerrm;
      end if;
  end;

  select m.status, m.invite_canceled_at, m.invite_consumed_at
    into row_status, row_canceled, row_consumed
    from public.safety_circle_members m
   where m.id = active_id;
  if row_status is distinct from 'active'
     or row_canceled is not null
     or row_consumed is null then
    raise exception 'active cancel wrote the member';
  end if;

  -- Fix #14 (2026-11-17): the owner can cancel an expired invite.
  canceled := public.cancel_circle_invite(expired_id);
  if canceled->>'status' is distinct from 'canceled' then
    raise exception 'expired cancel failed: %', canceled;
  end if;

  select m.status, m.invite_canceled_at, m.invite_token
    into row_status, row_canceled, row_token
    from public.safety_circle_members m
   where m.id = expired_id;
  if row_status is distinct from 'declined'
     or row_canceled is null
     or row_token is distinct from t_expired then
    raise exception 'expired cancel did not decline the invite';
  end if;

  begin
    perform public.cancel_circle_invite(declined_id);
    raise exception 'declined cancel did not raise';
  exception
    when sqlstate 'P0001' then
      if sqlerrm not like '%cancel_circle_invite:not_pending%' then
        raise exception 'declined cancel got %', sqlerrm;
      end if;
  end;

  cap := public._circle_invite_capacity_json(cid);
  if (cap->>'pending_count')::integer is distinct from 1
     or (cap->>'available')::integer is distinct from 3 then
    raise exception 'failed cancels changed capacity: %', cap;
  end if;

  canceled := public.cancel_circle_invite(pending_id);
  if canceled->>'status' is distinct from 'canceled'
     or canceled->>'member_id' is distinct from pending_id::text
     or canceled->>'circle_id' is distinct from cid::text
     or canceled->>'owner_name' is distinct from 'Owner Cancel'
     or canceled ? 'phone' or canceled ? 'email' then
    raise exception 'cancel payload failed: %', canceled;
  end if;

  select m.status, m.invite_token, m.invite_canceled_at, m.invite_consumed_at
    into row_status, row_token, row_canceled, row_consumed
    from public.safety_circle_members m
   where m.id = pending_id;
  if row_status is distinct from 'declined'
     or row_token is distinct from t_pending
     or row_canceled is null
     or row_consumed is not null then
    raise exception 'cancel did not decline without consuming';
  end if;
  saved_canceled := row_canceled;

  lookup := public.lookup_circle_invite(t_pending);
  if lookup->>'status' is distinct from 'canceled' then
    raise exception 'canceled token lookup failed: %', lookup;
  end if;

  cap := public._circle_invite_capacity_json(cid);
  if (cap->>'active_count')::integer is distinct from 1
     or (cap->>'pending_count')::integer is distinct from 0
     or (cap->>'used')::integer is distinct from 1
     or (cap->>'available')::integer is distinct from 4 then
    raise exception 'slot was not released: %', cap;
  end if;

  select count(*)
    into member_rows
    from public.safety_circle_members m
   where m.circle_id = cid;
  if member_rows is distinct from 5 then
    raise exception 'cancel deleted or inserted a member row: %', member_rows;
  end if;

  select count(*)
    into circle_count
    from public.safety_circles c
   where c.owner_id = owner;
  if circle_count is distinct from 1 then
    raise exception 'cancel created or deleted a circle';
  end if;

  select p.updated_at, p.emergency_contact_full_name
    into profile_updated_after, emergency_name
    from public.profiles p
   where p.id = owner;
  if profile_updated_after is distinct from profile_updated
     or emergency_name is not null then
    raise exception 'cancel wrote the owner profile';
  end if;

  select elem
    into listed
    from jsonb_array_elements(public.list_my_joined_circles()) elem
   where elem->>'circle_id' = cid::text;
  if (listed->>'active_member_count')::integer is distinct from 1 then
    raise exception 'count changed after cancel: %', listed;
  end if;

  begin
    perform public.cancel_circle_invite(pending_id);
    raise exception 'second cancel did not raise';
  exception
    when sqlstate 'P0001' then
      if sqlerrm not like '%cancel_circle_invite:not_pending%' then
        raise exception 'second cancel got %', sqlerrm;
      end if;
  end;

  select m.invite_canceled_at
    into row_canceled
    from public.safety_circle_members m
   where m.id = pending_id;
  if row_canceled is distinct from saved_canceled then
    raise exception 'second cancel wrote the invite';
  end if;

  raise exception using
    errcode = 'P0001',
    message = 'scrum29_cancel_invite_ok ' || phone_owner;
end
$scrum29$;
