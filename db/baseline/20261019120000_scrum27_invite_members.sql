-- SCRUM-27: Invite Members via Contacts or Shareable Link
-- Additive invite token/expiry columns on safety_circle_members plus owner-only
-- RPCs. Does not send SMS/email (Twilio/SMTP hold). Does not accept/decline
-- (SCRUM-28). Does not write profiles.emergency_*. Hosted Supabase, no Express.

-- ---------------------------------------------------------------------------
-- Invite columns on safety_circle_members
-- ---------------------------------------------------------------------------

alter table public.safety_circle_members
  add column if not exists invite_token text null,
  add column if not exists invite_expires_at timestamptz null,
  add column if not exists invite_consumed_at timestamptz null,
  add column if not exists invite_canceled_at timestamptz null;

comment on column public.safety_circle_members.invite_token is
  'SCRUM-27: Unique hex token for the shareable invite URL. Null on the owner row. Rotated on every resend. Consumed by SCRUM-28 (this story never sets invite_consumed_at).';
comment on column public.safety_circle_members.invite_expires_at is
  'SCRUM-27: invited_at + 7 days. Null on the owner row. Lookup/accept must fail after this instant.';
comment on column public.safety_circle_members.invite_consumed_at is
  'SCRUM-28: Set when the invitee accepts and the token is single-used. SCRUM-27 never writes this.';
comment on column public.safety_circle_members.invite_canceled_at is
  'Optional cancel stamp. SCRUM-27 write RPCs do not cancel; resend clears it. Lookup treats a non-null value as canceled.';

create unique index if not exists safety_circle_members_invite_token_uidx
  on public.safety_circle_members (invite_token)
  where invite_token is not null;

-- Existing 26/80 pending emergency-contact rows can be resent / shared.
update public.safety_circle_members
   set invite_token = replace(
         (gen_random_uuid()::text || gen_random_uuid()::text),
         '-',
         ''
       ),
       invite_expires_at = invited_at + interval '7 days'
 where role = 'member'
   and status = 'pending'
   and invite_token is null;

alter table public.safety_circle_members
  drop constraint if exists safety_circle_members_pending_invite_token;

alter table public.safety_circle_members
  add constraint safety_circle_members_pending_invite_token
  check (
    role <> 'member'
    or status <> 'pending'
    or (
      invite_token is not null
      and char_length(invite_token) >= 32
      and invite_expires_at is not null
    )
  );

-- ---------------------------------------------------------------------------
-- Internal helpers (not granted to anon / authenticated / PUBLIC)
-- ---------------------------------------------------------------------------

create or replace function public.new_circle_invite_token()
returns text
language sql
volatile
set search_path = public
as $$
  select replace((gen_random_uuid()::text || gen_random_uuid()::text), '-', '');
$$;

comment on function public.new_circle_invite_token() is
  'SCRUM-27: 64-char hex invite token. Internal; not granted to API roles.';

create or replace function public._owner_circle_for_invite(err_prefix text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  sharing boolean;
  cid uuid;
begin
  if uid is null then
    raise exception using
      errcode = 'P0001',
      message = err_prefix || ':not_authenticated';
  end if;

  select p.location_sharing_enabled
    into sharing
    from public.profiles p
   where p.id = uid;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = err_prefix || ':profile_not_found';
  end if;

  if not sharing then
    raise exception using
      errcode = 'P0001',
      message = err_prefix || ':location_sharing_disabled';
  end if;

  select sc.id
    into cid
    from public.safety_circles sc
   where sc.owner_id = uid
   for update;

  if cid is null then
    raise exception using
      errcode = 'P0001',
      message = err_prefix || ':circle_not_found';
  end if;

  return cid;
end;
$$;

comment on function public._owner_circle_for_invite(text) is
  'SCRUM-27: Auth + location_sharing_enabled + owner circle lock. Internal.';

create or replace function public._circle_invite_payload(
  m public.safety_circle_members,
  resent boolean
)
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'member_id', m.id,
    'circle_id', m.circle_id,
    'status', m.status,
    'display_name', m.display_name,
    'relationship', m.relationship,
    'phone', m.phone,
    'invite_token', m.invite_token,
    'invite_url', 'io.supabase.atlasmobile://invite/' || m.invite_token,
    'invited_at', m.invited_at,
    'invite_expires_at', m.invite_expires_at,
    'resent', resent
  );
$$;

comment on function public._circle_invite_payload(public.safety_circle_members, boolean) is
  'SCRUM-27: JSON payload for invite / resend RPCs. Internal.';

create or replace function public._refresh_circle_invite(
  p_member_id uuid,
  err_prefix text,
  p_display_name text default null,
  p_relationship text default null
)
returns public.safety_circle_members
language plpgsql
security definer
set search_path = public
as $$
declare
  m public.safety_circle_members%rowtype;
  new_name text;
  new_rel text;
begin
  select *
    into m
    from public.safety_circle_members
   where id = p_member_id
   for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = err_prefix || ':member_not_found';
  end if;

  if m.role <> 'member' then
    raise exception using
      errcode = 'P0001',
      message = err_prefix || ':not_invitable';
  end if;

  if m.status = 'active' or m.invite_consumed_at is not null then
    raise exception using
      errcode = 'P0001',
      message = err_prefix || ':already_active';
  end if;

  new_name := coalesce(nullif(trim(p_display_name), ''), m.display_name);
  if char_length(new_name) = 0 then
    raise exception using
      errcode = 'P0001',
      message = err_prefix || ':invalid_display_name';
  end if;

  if p_relationship is null then
    new_rel := m.relationship;
  else
    new_rel := nullif(trim(p_relationship), '');
  end if;

  if new_rel is not null
     and new_rel not in (
       'spouse', 'partner', 'parent', 'child', 'sibling', 'friend', 'other'
     ) then
    raise exception using
      errcode = 'P0001',
      message = err_prefix || ':invalid_relationship';
  end if;

  update public.safety_circle_members
     set display_name = new_name,
         relationship = new_rel,
         status = 'pending',
         user_id = null,
         invited_at = now(),
         invite_token = public.new_circle_invite_token(),
         invite_expires_at = now() + interval '7 days',
         invite_consumed_at = null,
         invite_canceled_at = null,
         updated_at = now()
   where id = p_member_id
   returning * into m;

  return m;
end;
$$;

comment on function public._refresh_circle_invite(uuid, text, text, text) is
  'SCRUM-27: Rotate token, refresh invited_at + 7-day expiry, set pending. Never regresses active. Internal.';

revoke all on function public.new_circle_invite_token() from public;
revoke all on function public.new_circle_invite_token() from anon;
revoke all on function public.new_circle_invite_token() from authenticated;

revoke all on function public._owner_circle_for_invite(text) from public;
revoke all on function public._owner_circle_for_invite(text) from anon;
revoke all on function public._owner_circle_for_invite(text) from authenticated;

revoke all on function public._circle_invite_payload(public.safety_circle_members, boolean) from public;
revoke all on function public._circle_invite_payload(public.safety_circle_members, boolean) from anon;
revoke all on function public._circle_invite_payload(public.safety_circle_members, boolean) from authenticated;

revoke all on function public._refresh_circle_invite(uuid, text, text, text) from public;
revoke all on function public._refresh_circle_invite(uuid, text, text, text) from anon;
revoke all on function public._refresh_circle_invite(uuid, text, text, text) from authenticated;

-- ---------------------------------------------------------------------------
-- complete_profile_setup() — stamp token + expiry on the 26 emergency invite
-- Return shape is unchanged (SCRUM-80 / 26).
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
  circle_id uuid;
  member_id uuid;
  member_status text;
  completed_at timestamptz;
  contact_email text;
  invite_tok text;
  invite_exp timestamptz;
begin
  if uid is null then
    raise exception using
      errcode = 'P0001',
      message = 'complete_profile_setup:not_authenticated';
  end if;

  select *
    into p
    from public.profiles
   where id = uid
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
     set profile_setup_completed_at = coalesce(profile_setup_completed_at, now())
   where id = uid
   returning profile_setup_completed_at into completed_at;

  if not p.location_sharing_enabled then
    return jsonb_build_object(
      'profile_setup_completed_at', completed_at,
      'location_sharing_enabled', false,
      'circle_id', null,
      'member_id', null,
      'member_status', null
    );
  end if;

  select sc.id
    into circle_id
    from public.safety_circles sc
   where sc.owner_id = uid;

  if circle_id is null then
    insert into public.safety_circles (owner_id, name)
    values (uid, 'My Safety Circle')
    returning id into circle_id;
  end if;

  insert into public.safety_circle_members (
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
    circle_id,
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

  contact_email := nullif(trim(coalesce(p.emergency_contact_email, '')), '');
  invite_tok := public.new_circle_invite_token();
  invite_exp := now() + interval '7 days';

  insert into public.safety_circle_members (
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
    circle_id,
    'member',
    'pending',
    trim(p.emergency_contact_full_name),
    p.emergency_contact_relationship,
    p.emergency_contact_phone,
    contact_email,
    null,
    now(),
    invite_tok,
    invite_exp
  )
  on conflict (circle_id, phone) where phone is not null
  do update set
    display_name = excluded.display_name,
    relationship = excluded.relationship,
    email = excluded.email,
    status = case
      when public.safety_circle_members.status = 'active' then 'active'
      else 'pending'
    end,
    invited_at = case
      when public.safety_circle_members.status = 'active'
        then public.safety_circle_members.invited_at
      else now()
    end,
    invite_token = case
      when public.safety_circle_members.status = 'active'
        then public.safety_circle_members.invite_token
      when public.safety_circle_members.status = 'pending'
           and public.safety_circle_members.invite_token is not null
        then public.safety_circle_members.invite_token
      else excluded.invite_token
    end,
    invite_expires_at = case
      when public.safety_circle_members.status = 'active'
        then public.safety_circle_members.invite_expires_at
      else excluded.invite_expires_at
    end,
    updated_at = now()
  returning id, status into member_id, member_status;

  return jsonb_build_object(
    'profile_setup_completed_at', completed_at,
    'location_sharing_enabled', true,
    'circle_id', circle_id,
    'member_id', member_id,
    'member_status', member_status
  );
end;
$$;

comment on function public.complete_profile_setup() is
  'SCRUM-80 / 27: Atomic Complete. Sets profile_setup_completed_at. If location_sharing_enabled, ensures My Safety Circle + owner active member + emergency contact pending invite with token + 7-day expiry. Does not send SMS/email. Does not consume tokens. Return shape unchanged.';

revoke all on function public.complete_profile_setup() from public;
revoke all on function public.complete_profile_setup() from anon;
grant execute on function public.complete_profile_setup() to authenticated;

-- ---------------------------------------------------------------------------
-- Owner RPCs
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
   where circle_id = cid
     and phone = raw_phone
   for update;

  if found then
    created := public._refresh_circle_invite(
      existing.id,
      prefix,
      raw_name,
      coalesce(raw_rel, existing.relationship)
    );
    return public._circle_invite_payload(created, true);
  end if;

  begin
    insert into public.safety_circle_members (
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
       where circle_id = cid
         and phone = raw_phone
       for update;

      if not found then
        raise exception using
          errcode = 'P0001',
          message = prefix || ':duplicate_membership';
      end if;

      created := public._refresh_circle_invite(
        existing.id,
        prefix,
        raw_name,
        coalesce(raw_rel, existing.relationship)
      );
      return public._circle_invite_payload(created, true);
  end;

  return public._circle_invite_payload(created, false);
end;
$$;

comment on function public.invite_circle_member_by_phone(text, text, text) is
  'SCRUM-27: Owner-only. Validate E.164 then insert a pending member with unique token + 7-day expiry, or resend an existing non-active row for that phone. Does not send SMS. Does not write profiles.emergency_*. Never regresses active.';

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

  insert into public.safety_circle_members (
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

  return public._circle_invite_payload(created, false);
end;
$$;

comment on function public.create_circle_invite_link(text) is
  'SCRUM-27: Owner-only. Pending member with unique token, phone null, 7-day expiry. Share io.supabase.atlasmobile://invite/{token}. Does not send SMS.';

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
   where id = member_id
     and circle_id = cid
   for update;

  if not found then
    raise exception using
      errcode = 'P0001',
      message = prefix || ':member_not_found';
  end if;

  created := public._refresh_circle_invite(existing.id, prefix);
  return public._circle_invite_payload(created, true);
end;
$$;

comment on function public.resend_circle_invite(uuid) is
  'SCRUM-27: Owner-only. Rotate token, refresh invited_at + 7-day expiry. Expired/declined/canceled become pending. Active/consumed errors. Does not send SMS.';

create or replace function public.lookup_circle_invite(token text)
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $$
declare
  raw text := trim(coalesce(token, ''));
  m public.safety_circle_members%rowtype;
  result_status text;
begin
  if char_length(raw) = 0 then
    return jsonb_build_object(
      'status', 'not_found',
      'invite_expires_at', null
    );
  end if;

  select *
    into m
    from public.safety_circle_members
   where invite_token = raw;

  if not found then
    return jsonb_build_object(
      'status', 'not_found',
      'invite_expires_at', null
    );
  end if;

  if m.invite_canceled_at is not null or m.status = 'declined' then
    result_status := 'canceled';
  elsif m.invite_consumed_at is not null or m.status = 'active' then
    result_status := 'consumed';
  elsif m.invite_expires_at is not null and m.invite_expires_at <= now() then
    result_status := 'expired';
  elsif m.invite_expires_at is null
        and m.invited_at + interval '7 days' <= now() then
    result_status := 'expired';
  elsif m.status = 'pending' then
    result_status := 'pending';
  else
    result_status := 'not_found';
  end if;

  return jsonb_build_object(
    'status', result_status,
    'invite_expires_at', m.invite_expires_at
  );
end;
$$;

comment on function public.lookup_circle_invite(text) is
  'SCRUM-27: Token preview. Returns status pending|expired|consumed|canceled|not_found and invite_expires_at. No profile, phone, or other member fields. Does not activate membership.';

revoke all on function public.invite_circle_member_by_phone(text, text, text) from public;
revoke all on function public.invite_circle_member_by_phone(text, text, text) from anon;
grant execute on function public.invite_circle_member_by_phone(text, text, text) to authenticated;

revoke all on function public.create_circle_invite_link(text) from public;
revoke all on function public.create_circle_invite_link(text) from anon;
grant execute on function public.create_circle_invite_link(text) to authenticated;

revoke all on function public.resend_circle_invite(uuid) from public;
revoke all on function public.resend_circle_invite(uuid) from anon;
grant execute on function public.resend_circle_invite(uuid) to authenticated;

revoke all on function public.lookup_circle_invite(text) from public;
grant execute on function public.lookup_circle_invite(text) to anon;
grant execute on function public.lookup_circle_invite(text) to authenticated;
