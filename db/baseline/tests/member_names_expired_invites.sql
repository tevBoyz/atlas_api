-- Fixes #18 (member names) and #14 (expired invites), device re-test round 2.
-- Run as one script against the hosted database. All writes stay inside this
-- DO block. The block ends by raising member_names_expired_invites_ok so
-- PostgreSQL rolls the test rows back. A different error is a failed assert.

do $names_expired$
declare
  suffix text;
  phone_owner text;
  phone_linker text;
  phone_noprof text;
  phone_contact text;
  phone_outsider text;
  owner uuid := gen_random_uuid();
  linker uuid := gen_random_uuid();
  noprof uuid := gen_random_uuid();
  contact uuid := gen_random_uuid();
  outsider uuid := gen_random_uuid();
  cid uuid;
  contact_id uuid;
  linker_row uuid;
  link2_id uuid;
  link3_id uuid;
  fill_id uuid;
  old_id uuid;
  old2_id uuid;
  noprof_row uuid;
  t_link text;
  t_old text;
  t_old2 text;
  t_contact text;
  t_contact_new text;
  setup jsonb;
  res jsonb;
  cap jsonb;
  members jsonb;
  elem jsonb;
  src text;
  row_status text;
  row_name text;
  row_token text;
  row_user uuid;
  row_canceled timestamptz;
  row_consumed timestamptz;
  row_expires timestamptz;
  i integer;
begin
  -- Static checks -------------------------------------------------------------
  select pg_get_functiondef('public.accept_circle_invite(text)'::regprocedure)
    into src;
  if src not ilike '%_member_profile_name(uid)%'
     or src ilike '%location_sharing%'
     or src ilike '%update public.profiles%' then
    raise exception 'accept_circle_invite name write missing or touches profiles/location';
  end if;

  if exists (
    select 1
      from pg_policies pol
     where pol.schemaname = 'public'
       and pol.tablename = 'profiles'
       and pol.cmd in ('SELECT', 'ALL')
       and pol.qual ilike '%safety_circle%'
  ) then
    raise exception 'profiles RLS was opened to circle members';
  end if;

  if has_function_privilege('authenticated', 'public._member_profile_name(uuid)', 'execute')
     or has_function_privilege('anon', 'public._member_profile_name(uuid)', 'execute') then
    raise exception '_member_profile_name is callable by clients';
  end if;

  -- Fixtures ------------------------------------------------------------------
  suffix := null;
  for i in 1..30 loop
    suffix := lpad((floor(random() * 100000))::int::text, 5, '0');
    if not exists (
      select 1 from auth.users u where u.phone like '+220397' || suffix || '%'
    ) and not exists (
      select 1 from public.safety_circle_members m where m.phone like '+220397' || suffix || '%'
    ) and not exists (
      select 1 from public.profiles p where p.emergency_contact_phone like '+220397' || suffix || '%'
    ) then
      exit;
    end if;
    suffix := null;
  end loop;
  if suffix is null then
    raise exception 'could not allocate test phones';
  end if;

  phone_owner := '+220397' || suffix || '1';
  phone_linker := '+220397' || suffix || '2';
  phone_noprof := '+220397' || suffix || '3';
  phone_contact := '+220397' || suffix || '4';
  phone_outsider := '+220397' || suffix || '5';

  insert into auth.users (id, phone, phone_confirmed_at)
  values
    (owner, phone_owner, now()),
    (linker, phone_linker, now()),
    (noprof, phone_noprof, now()),
    (contact, phone_contact, now()),
    (outsider, phone_outsider, now());

  insert into public.profiles (
    id, full_name, date_of_birth, personal_info_completed_at,
    emergency_contact_full_name, emergency_contact_relationship,
    emergency_contact_phone, emergency_info_completed_at,
    preferences_completed_at, location_sharing_enabled
  )
  values (
    owner, 'Owner Names', date '1990-01-01', now(),
    'Contact Person', 'friend', phone_contact, now(),
    now(), true
  );

  insert into public.profiles (id, full_name, date_of_birth)
  values
    (linker, 'Link Joiner', date '1992-02-02'),
    (contact, 'Contact Account', date '1993-03-03'),
    (outsider, 'Outsider', date '1994-04-04');

  -- Owner completes setup: circle + owner row + contact pending invite.
  perform set_config('request.jwt.claim.sub', owner::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', owner, 'role', 'authenticated')::text,
    true
  );

  setup := public.complete_profile_setup();
  cid := (setup->>'circle_id')::uuid;
  contact_id := (setup->>'member_id')::uuid;
  if cid is null or setup->>'member_status' is distinct from 'pending' then
    raise exception 'setup failed: %', setup;
  end if;

  res := public.create_circle_invite_link(null);
  t_link := res->>'invite_token';
  linker_row := (res->>'member_id')::uuid;
  if res->>'display_name' is distinct from 'Invited member' then
    raise exception 'link placeholder changed: %', res;
  end if;

  -- #18: link-joined member shows their profile name ---------------------------
  perform set_config('request.jwt.claim.sub', linker::text, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', linker, 'role', 'authenticated')::text,
    true
  );
  res := public.accept_circle_invite(t_link);
  if res->>'status' is distinct from 'active' then
    raise exception 'link accept failed: %', res;
  end if;

  select m.display_name into row_name
    from public.safety_circle_members m where m.id = linker_row;
  if row_name is distinct from 'Link Joiner' then
    raise exception 'accept did not store the profile name: %', row_name;
  end if;

  -- Active member without a profile keeps the stored name.
  insert into public.safety_circle_members (
    circle_id, role, status, display_name, user_id, invite_consumed_at
  )
  values (cid, 'member', 'active', 'Stored Name', noprof, now())
  returning id into noprof_row;

  -- Owner view
  perform set_config('request.jwt.claim.sub', owner::text, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', owner, 'role', 'authenticated')::text,
    true
  );

  res := public.create_circle_invite_link(null);
  link2_id := (res->>'member_id')::uuid;

  -- Simulate a pre-fix row: active with the placeholder name. The list must
  -- still show the live profile name.
  update public.safety_circle_members
     set display_name = 'Invited member'
   where id = linker_row;

  members := public.list_circle_members(cid);
  select e into elem from jsonb_array_elements(members) e
   where e->>'member_id' = linker_row::text;
  if elem->>'display_name' is distinct from 'Link Joiner'
     or elem->>'status' is distinct from 'active'
     or not (elem ? 'avatar_url') then
    raise exception 'owner list did not show profile name: %', elem;
  end if;

  select e into elem from jsonb_array_elements(members) e
   where e->>'member_id' = link2_id::text;
  if elem->>'display_name' is distinct from 'Invited member'
     or elem->>'status' is distinct from 'pending' then
    raise exception 'pending link invite lost its placeholder: %', elem;
  end if;

  select e into elem from jsonb_array_elements(members) e
   where e->>'member_id' = noprof_row::text;
  if elem->>'display_name' is distinct from 'Stored Name' then
    raise exception 'no-profile fallback failed: %', elem;
  end if;

  select e into elem from jsonb_array_elements(members) e
   where e->>'is_owner' = 'true';
  if elem->>'display_name' is distinct from 'Owner Names' then
    raise exception 'owner row name failed: %', elem;
  end if;

  -- #14: expired pending does not use a slot ----------------------------------
  t_old := public.new_circle_invite_token();
  insert into public.safety_circle_members (
    circle_id, role, status, display_name, invite_token, invited_at, invite_expires_at
  )
  values (
    cid, 'member', 'pending', 'Old Invite', t_old,
    now() - interval '10 days', now() - interval '3 days'
  )
  returning id into old_id;

  -- active: linker, noprof. valid pending: contact, link2. expired: old.
  cap := public.circle_invite_capacity();
  if (cap->>'active_count')::integer is distinct from 2
     or (cap->>'pending_count')::integer is distinct from 2
     or (cap->>'used')::integer is distinct from 4
     or (cap->>'available')::integer is distinct from 1
     or (cap->>'limit')::integer is distinct from 5 then
    raise exception 'expired counted in capacity: %', cap;
  end if;

  members := public.list_circle_members(cid);
  select e into elem from jsonb_array_elements(members) e
   where e->>'member_id' = old_id::text;
  if elem is null
     or elem->>'status' is distinct from 'expired'
     or elem->>'display_name' is distinct from 'Old Invite' then
    raise exception 'owner list missing expired row: %', elem;
  end if;
  select m.status into row_status from public.safety_circle_members m where m.id = old_id;
  if row_status is distinct from 'pending' then
    raise exception 'stored status changed: %', row_status;
  end if;

  -- Members never see pending or expired rows.
  perform set_config('request.jwt.claim.sub', linker::text, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', linker, 'role', 'authenticated')::text,
    true
  );
  members := public.list_circle_members(cid);
  if exists (
    select 1 from jsonb_array_elements(members) e
     where e->>'status' in ('pending', 'expired', 'declined')
        or e ? 'phone' or e ? 'email' or e ? 'relationship'
  ) then
    raise exception 'member list leaked pending/expired/contact: %', members;
  end if;
  select e into elem from jsonb_array_elements(members) e
   where e->>'member_id' = linker_row::text;
  if elem->>'display_name' is distinct from 'Link Joiner' then
    raise exception 'member list did not show profile name: %', elem;
  end if;

  -- Accepting an expired token still fails.
  perform set_config('request.jwt.claim.sub', outsider::text, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', outsider, 'role', 'authenticated')::text,
    true
  );
  begin
    perform public.accept_circle_invite(t_old);
    raise exception 'expired accept did not raise';
  exception
    when sqlstate 'P0001' then
      if sqlerrm not like '%accept_circle_invite:expired%' then
        raise exception 'expired accept got %', sqlerrm;
      end if;
  end;

  -- Resend on expired re-checks capacity ------------------------------------
  perform set_config('request.jwt.claim.sub', owner::text, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', owner, 'role', 'authenticated')::text,
    true
  );

  res := public.create_circle_invite_link(null);
  fill_id := (res->>'member_id')::uuid;
  cap := public.circle_invite_capacity();
  if (cap->>'used')::integer is distinct from 5
     or (cap->>'available')::integer is distinct from 0 then
    raise exception 'fill failed: %', cap;
  end if;

  begin
    perform public.resend_circle_invite(old_id);
    raise exception 'resend at 5/5 did not raise';
  exception
    when sqlstate 'P0001' then
      if sqlerrm not like '%resend_circle_invite:circle_full%' then
        raise exception 'resend at 5/5 got %', sqlerrm;
      end if;
  end;
  select m.invite_token, m.status into row_token, row_status
    from public.safety_circle_members m where m.id = old_id;
  if row_token is distinct from t_old or row_status is distinct from 'pending' then
    raise exception 'failed resend wrote the row';
  end if;

  -- An expired row can be inserted at 5/5 (holds no slot) and canceled.
  t_old2 := public.new_circle_invite_token();
  insert into public.safety_circle_members (
    circle_id, role, status, display_name, invite_token, invited_at, invite_expires_at
  )
  values (
    cid, 'member', 'pending', 'Old Two', t_old2,
    now() - interval '9 days', now() - interval '2 days'
  )
  returning id into old2_id;

  res := public.cancel_circle_invite(old2_id);
  if res->>'status' is distinct from 'canceled'
     or res->>'member_id' is distinct from old2_id::text then
    raise exception 'cancel on expired failed: %', res;
  end if;
  select m.status, m.invite_canceled_at into row_status, row_canceled
    from public.safety_circle_members m where m.id = old2_id;
  if row_status is distinct from 'declined' or row_canceled is null then
    raise exception 'cancel on expired did not decline';
  end if;
  if public.lookup_circle_invite(t_old2)->>'status' is distinct from 'canceled' then
    raise exception 'canceled expired token lookup wrong';
  end if;
  cap := public.circle_invite_capacity();
  if (cap->>'used')::integer is distinct from 5 then
    raise exception 'cancel on expired changed capacity: %', cap;
  end if;

  -- Free one slot, then resend the expired invite: same row, new token.
  perform public.cancel_circle_invite(fill_id);
  cap := public.circle_invite_capacity();
  if (cap->>'used')::integer is distinct from 4 then
    raise exception 'cancel did not free a slot: %', cap;
  end if;

  res := public.resend_circle_invite(old_id);
  if res->>'member_id' is distinct from old_id::text
     or res->>'status' is distinct from 'pending'
     or res->>'invite_token' is null
     or res->>'invite_token' = t_old
     or (res->>'invite_expires_at')::timestamptz < now() + interval '6 days' then
    raise exception 'resend on expired failed: %', res;
  end if;
  if public.lookup_circle_invite(res->>'invite_token')->>'status' is distinct from 'pending' then
    raise exception 'resent token is not pending';
  end if;
  cap := public.circle_invite_capacity();
  if (cap->>'used')::integer is distinct from 5
     or (cap->>'pending_count')::integer is distinct from 3 then
    raise exception 'resend did not take the slot: %', cap;
  end if;
  members := public.list_circle_members(cid);
  select e into elem from jsonb_array_elements(members) e
   where e->>'member_id' = old_id::text;
  if elem->>'status' is distinct from 'pending' then
    raise exception 'resent row not listed pending: %', elem;
  end if;

  -- complete_profile_setup re-run after decline ------------------------------
  select m.invite_token into t_contact
    from public.safety_circle_members m where m.id = contact_id;

  perform set_config('request.jwt.claim.sub', contact::text, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', contact, 'role', 'authenticated')::text,
    true
  );
  res := public.decline_circle_invite(t_contact);
  if res->>'status' is distinct from 'declined' then
    raise exception 'contact decline failed: %', res;
  end if;

  perform set_config('request.jwt.claim.sub', owner::text, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', owner, 'role', 'authenticated')::text,
    true
  );

  setup := public.complete_profile_setup();
  if setup->>'member_id' is distinct from contact_id::text
     or setup->>'member_status' is distinct from 'pending' then
    raise exception 'setup re-run after decline failed: %', setup;
  end if;

  select m.status, m.invite_token, m.invite_canceled_at, m.invite_consumed_at,
         m.user_id, m.invite_expires_at
    into row_status, t_contact_new, row_canceled, row_consumed, row_user, row_expires
    from public.safety_circle_members m where m.id = contact_id;
  if row_status is distinct from 'pending'
     or row_canceled is not null
     or row_consumed is not null
     or row_user is not null
     or t_contact_new is null
     or t_contact_new = t_contact
     or row_expires < now() + interval '6 days' then
    raise exception 'setup re-run left an unusable invite';
  end if;
  if public.lookup_circle_invite(t_contact_new)->>'status' is distinct from 'pending' then
    raise exception 'setup re-run token does not look up as pending: %',
      public.lookup_circle_invite(t_contact_new);
  end if;
  if public.lookup_circle_invite(t_contact)->>'status' is distinct from 'not_found' then
    raise exception 'old declined token still resolves';
  end if;

  -- The contact can now accept the new link.
  perform set_config('request.jwt.claim.sub', contact::text, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', contact, 'role', 'authenticated')::text,
    true
  );
  res := public.preview_circle_invite(t_contact_new);
  if res->>'status' is distinct from 'pending' then
    raise exception 'contact preview after re-run failed: %', res;
  end if;

  -- Decline again, fill the circle, re-run: Complete still succeeds and the
  -- contact row is left declined (no slot).
  res := public.decline_circle_invite(t_contact_new);
  perform set_config('request.jwt.claim.sub', owner::text, true);
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', owner, 'role', 'authenticated')::text,
    true
  );
  perform public.create_circle_invite_link(null);
  cap := public.circle_invite_capacity();
  if (cap->>'available')::integer is distinct from 0 then
    raise exception 'refill failed: %', cap;
  end if;
  setup := public.complete_profile_setup();
  if setup->>'member_id' is distinct from contact_id::text
     or setup->>'member_status' is distinct from 'declined'
     or setup->>'profile_setup_completed_at' is null then
    raise exception 'setup re-run at 5/5 failed: %', setup;
  end if;

  raise exception using
    errcode = 'P0001',
    message = 'member_names_expired_invites_ok ' || phone_owner;
end
$names_expired$;
