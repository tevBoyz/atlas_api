-- SCRUM-28 amendment checks. Run as one script against the hosted database.
-- All writes stay inside this DO block. The block ends by raising
-- scrum28_accept_amendment_ok so PostgreSQL rolls the test rows back.
-- A different error is a failed assert.

do $scrum28$
declare
  suffix text;
  phone_owner text;
  phone_invitee text;
  phone_noprofile text;
  phone_blocked text;
  phone_owner2 text;
  phone_owner3 text;
  phone_owner4 text;
  owner uuid := gen_random_uuid();
  owner2 uuid := gen_random_uuid();
  owner3 uuid := gen_random_uuid();
  owner4 uuid := gen_random_uuid();
  invitee uuid := gen_random_uuid();
  noprofile uuid := gen_random_uuid();
  blocked uuid := gen_random_uuid();
  cid uuid := gen_random_uuid();
  cid_decline uuid := gen_random_uuid();
  cid_full uuid := gen_random_uuid();
  cid_exact uuid := gen_random_uuid();
  t_accept text;
  t_owner text;
  t_other text;
  t_decline text;
  t_full text;
  t_exact text;
  src text;
  preview jsonb;
  accepted jsonb;
  accepted_again jsonb;
  declined jsonb;
  sharing boolean;
  row_status text;
  row_user uuid;
  used integer;
  list jsonb;
  member_count integer;
  i integer;
begin
  select pg_get_functiondef('public.accept_circle_invite(text)'::regprocedure)
    into src;
  if src ilike '%location_sharing%' or src ilike '%public.profiles%' or src ilike '%from public.profiles%' then
    raise exception 'accept_circle_invite still references profiles or location sharing';
  end if;

  suffix := null;
  for i in 1..30 loop
    suffix := lpad((floor(random() * 100000))::int::text, 5, '0');
    if not exists (
      select 1
        from auth.users u
       where u.phone like '+220397' || suffix || '%'
    ) and not exists (
      select 1
        from public.safety_circle_members m
       where m.phone like '+220397' || suffix || '%'
    ) then
      exit;
    end if;
    suffix := null;
  end loop;
  if suffix is null then
    raise exception 'could not allocate test phones';
  end if;

  phone_owner := '+220397' || suffix || '1';
  phone_invitee := '+220397' || suffix || '2';
  phone_noprofile := '+220397' || suffix || '3';
  phone_blocked := '+220397' || suffix || '4';
  phone_owner2 := '+220397' || suffix || '5';
  phone_owner3 := '+220397' || suffix || '6';
  phone_owner4 := '+220397' || suffix || '7';

  insert into auth.users (id, phone, phone_confirmed_at)
  values
    (owner, phone_owner, now()),
    (owner2, phone_owner2, now()),
    (owner3, phone_owner3, now()),
    (owner4, phone_owner4, now()),
    (invitee, phone_invitee, now()),
    (noprofile, phone_noprofile, now()),
    (blocked, phone_blocked, now());

  insert into public.profiles (id, full_name, date_of_birth, location_sharing_enabled)
  values
    (owner, 'Owner One', date '1990-01-01', true),
    (owner2, 'Owner Two', date '1990-01-01', true),
    (owner3, 'Owner Three', date '1990-01-01', true),
    (owner4, 'Owner Four', date '1990-01-01', true),
    (invitee, 'Invitee One', date '1992-02-02', false);

  t_accept := public.new_circle_invite_token();
  t_owner := public.new_circle_invite_token();
  t_other := public.new_circle_invite_token();
  t_decline := public.new_circle_invite_token();
  t_full := public.new_circle_invite_token();
  t_exact := public.new_circle_invite_token();

  insert into public.safety_circles (id, owner_id, name)
  values
    (cid, owner, 'My Safety Circle'),
    (cid_decline, owner2, 'My Safety Circle'),
    (cid_full, owner3, 'My Safety Circle'),
    (cid_exact, owner4, 'My Safety Circle');

  insert into public.safety_circle_members (
    circle_id, role, status, display_name, user_id
  )
  values
    (cid, 'owner', 'active', 'Owner One', owner),
    (cid_decline, 'owner', 'active', 'Owner Two', owner2),
    (cid_full, 'owner', 'active', 'Owner Three', owner3),
    (cid_exact, 'owner', 'active', 'Owner Four', owner4);

  insert into public.safety_circle_members (
    circle_id, role, status, display_name, phone, invite_token, invite_expires_at
  )
  values
    (cid, 'member', 'pending', 'Invitee One', phone_invitee, t_accept, now() + interval '7 days'),
    (cid, 'member', 'pending', 'Link For Owner', null, t_owner, now() + interval '7 days');

  perform set_config('request.jwt.claim.sub', owner::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', owner, 'role', 'authenticated')::text,
    true
  );

  preview := public.preview_circle_invite(t_owner);
  if preview->>'status' is distinct from 'own_circle'
     or preview->>'owner_name' is distinct from 'Owner One'
     or preview->>'circle_id' is distinct from cid::text
     or not (preview ? 'owner_avatar_url') then
    raise exception 'preview own_circle failed: %', preview;
  end if;
  select m.user_id, m.status
    into row_user, row_status
    from public.safety_circle_members m
   where m.invite_token = t_owner;
  if row_user is not null or row_status is distinct from 'pending' then
    raise exception 'own_circle preview claimed or activated';
  end if;

  begin
    perform public.accept_circle_invite(t_owner);
    raise exception 'own_circle accept did not raise';
  exception
    when sqlstate 'P0001' then
      if sqlerrm not like '%accept_circle_invite:own_circle%' then
        raise exception 'own_circle accept got %', sqlerrm;
      end if;
  end;
  select m.user_id, m.status
    into row_user, row_status
    from public.safety_circle_members m
   where m.invite_token = t_owner;
  if row_user is not null or row_status is distinct from 'pending' then
    raise exception 'own_circle accept wrote the invite';
  end if;

  perform set_config('request.jwt.claim.sub', invitee::text, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', invitee, 'role', 'authenticated')::text,
    true
  );

  accepted := public.accept_circle_invite(t_accept);
  if accepted->>'status' is distinct from 'active'
     or accepted->>'owner_name' is distinct from 'Owner One'
     or accepted->>'circle_id' is distinct from cid::text then
    raise exception 'accept without location sharing failed: %', accepted;
  end if;

  select p.location_sharing_enabled
    into sharing
    from public.profiles p
   where p.id = invitee;
  if sharing is distinct from false then
    raise exception 'accept turned location sharing on';
  end if;
  if exists (
    select 1 from public.safety_circles sc where sc.owner_id = invitee
  ) then
    raise exception 'accept created a personal circle';
  end if;

  accepted_again := public.accept_circle_invite(t_accept);
  if accepted_again->>'member_id' is distinct from accepted->>'member_id'
     or accepted_again->>'status' is distinct from 'active' then
    raise exception 'second accept was not idempotent: %', accepted_again;
  end if;
  select count(*)
    into member_count
    from public.safety_circle_members m
   where m.invite_token = t_accept;
  if member_count <> 1 then
    raise exception 'second accept inserted another row';
  end if;

  preview := public.preview_circle_invite(t_accept);
  if preview->>'status' is distinct from 'already_member'
     or preview->>'circle_id' is distinct from cid::text
     or preview->>'owner_name' is distinct from 'Owner One' then
    raise exception 'preview of own active token failed: %', preview;
  end if;

  insert into public.safety_circle_members (
    circle_id, role, status, display_name, invite_token, invite_expires_at
  )
  values (
    cid, 'member', 'pending', 'Someone Else', t_other, now() + interval '7 days'
  );

  preview := public.preview_circle_invite(t_other);
  if preview->>'status' is distinct from 'already_member'
     or preview->>'circle_id' is distinct from cid::text
     or preview->>'owner_name' is distinct from 'Owner One' then
    raise exception 'preview already_member failed: %', preview;
  end if;
  select m.user_id, m.status
    into row_user, row_status
    from public.safety_circle_members m
   where m.invite_token = t_other;
  if row_user is not null or row_status is distinct from 'pending' then
    raise exception 'already_member preview claimed a second row';
  end if;

  perform set_config('request.jwt.claim.sub', owner::text, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', owner, 'role', 'authenticated')::text,
    true
  );
  list := public.list_circle_members(cid);
  if not exists (
    select 1
      from jsonb_array_elements(list) e
     where e->>'status' = 'pending'
  ) then
    raise exception 'owner list hid pending: %', list;
  end if;

  perform set_config('request.jwt.claim.sub', invitee::text, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', invitee, 'role', 'authenticated')::text,
    true
  );
  list := public.list_circle_members(cid);
  if exists (
    select 1
      from jsonb_array_elements(list) e
     where e->>'status' = 'pending'
        or e ? 'phone'
        or e ? 'email'
        or e ? 'relationship'
        or e ? 'invite_token'
  ) then
    raise exception 'non-owner list leaked pending or contact fields: %', list;
  end if;
  if not exists (
    select 1
      from jsonb_array_elements(list) e
     where e->>'role' = 'owner' and e->>'status' = 'active'
  ) then
    raise exception 'non-owner list missed the owner row: %', list;
  end if;

  -- Decline releases the slot. Five pending, then one decline, then a new insert.
  insert into public.safety_circle_members (
    circle_id, role, status, display_name, phone, invite_token, invite_expires_at
  )
  values (
    cid_decline, 'member', 'pending', 'Invitee One', phone_invitee,
    t_decline, now() + interval '7 days'
  );
  for i in 1..4 loop
    insert into public.safety_circle_members (
      circle_id, role, status, display_name, invite_token, invite_expires_at
    )
    values (
      cid_decline, 'member', 'pending', 'Pending ' || i::text,
      public.new_circle_invite_token(), now() + interval '7 days'
    );
  end loop;

  used := (public._circle_invite_capacity_json(cid_decline)->>'used')::integer;
  if used <> 5 then
    raise exception 'expected 5 used before decline, got %', used;
  end if;

  begin
    insert into public.safety_circle_members (
      circle_id, role, status, display_name, invite_token, invite_expires_at
    )
    values (
      cid_decline, 'member', 'pending', 'Overflow',
      public.new_circle_invite_token(), now() + interval '7 days'
    );
    raise exception 'insert past 5 was allowed before decline';
  exception
    when sqlstate 'P0001' then
      if sqlerrm not like '%circle_full%' then
        raise exception 'full insert got %', sqlerrm;
      end if;
  end;

  declined := public.decline_circle_invite(t_decline);
  if declined->>'status' is distinct from 'declined'
     or declined->>'owner_name' is distinct from 'Owner Two' then
    raise exception 'decline failed: %', declined;
  end if;
  select m.status
    into row_status
    from public.safety_circle_members m
   where m.invite_token = t_decline;
  if row_status is distinct from 'declined' then
    raise exception 'decline did not set declined';
  end if;
  used := (public._circle_invite_capacity_json(cid_decline)->>'used')::integer;
  if used <> 4 then
    raise exception 'decline did not release the slot, used=%', used;
  end if;

  insert into public.safety_circle_members (
    circle_id, role, status, display_name, invite_token, invite_expires_at
  )
  values (
    cid_decline, 'member', 'pending', 'After Decline',
    public.new_circle_invite_token(), now() + interval '7 days'
  );

  -- Accept at exactly 5 (4 other active + this pending) is allowed.
  for i in 1..4 loop
    insert into public.safety_circle_members (
      circle_id, role, status, display_name
    )
    values (cid_exact, 'member', 'active', 'Seat ' || i::text);
  end loop;
  insert into public.safety_circle_members (
    circle_id, role, status, display_name, invite_token, invite_expires_at
  )
  values (
    cid_exact, 'member', 'pending', 'No Profile', t_exact, now() + interval '7 days'
  );

  perform set_config('request.jwt.claim.sub', noprofile::text, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', noprofile, 'role', 'authenticated')::text,
    true
  );
  accepted := public.accept_circle_invite(t_exact);
  if accepted->>'status' is distinct from 'active' then
    raise exception 'accept at 5 without a profile failed: %', accepted;
  end if;
  if exists (select 1 from public.profiles p where p.id = noprofile) then
    raise exception 'accept created a profile';
  end if;
  if exists (select 1 from public.safety_circles sc where sc.owner_id = noprofile) then
    raise exception 'accept created a circle for the no-profile user';
  end if;

  -- 5 other active rows plus this pending cannot be activated.
  alter table public.safety_circle_members
    disable trigger safety_circle_members_enforce_capacity;
  for i in 1..5 loop
    insert into public.safety_circle_members (
      circle_id, role, status, display_name
    )
    values (cid_full, 'member', 'active', 'Full Seat ' || i::text);
  end loop;
  insert into public.safety_circle_members (
    circle_id, role, status, display_name, invite_token, invite_expires_at
  )
  values (
    cid_full, 'member', 'pending', 'Blocked', t_full, now() + interval '7 days'
  );
  alter table public.safety_circle_members
    enable trigger safety_circle_members_enforce_capacity;

  perform set_config('request.jwt.claim.sub', blocked::text, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', blocked, 'role', 'authenticated')::text,
    true
  );

  begin
    perform public.accept_circle_invite(t_full);
    raise exception 'circle_full accept did not raise';
  exception
    when sqlstate 'P0001' then
      if sqlerrm not like '%accept_circle_invite:circle_full%' then
        raise exception 'circle_full accept got %', sqlerrm;
      end if;
  end;
  select m.user_id, m.status
    into row_user, row_status
    from public.safety_circle_members m
   where m.invite_token = t_full;
  if row_user is not null or row_status is distinct from 'pending' then
    raise exception 'circle_full accept wrote the invite';
  end if;

  preview := public.preview_circle_invite(t_full);
  if preview->>'status' is distinct from 'circle_full'
     or preview->>'owner_name' is distinct from 'Owner Three'
     or preview->>'circle_id' is distinct from cid_full::text then
    raise exception 'preview circle_full failed: %', preview;
  end if;
  select m.status
    into row_status
    from public.safety_circle_members m
   where m.invite_token = t_full;
  if row_status is distinct from 'pending' then
    raise exception 'preview circle_full activated the invite';
  end if;

  raise exception using
    errcode = 'P0001',
    message = 'scrum28_accept_amendment_ok ' || phone_owner;
end
$scrum28$;
