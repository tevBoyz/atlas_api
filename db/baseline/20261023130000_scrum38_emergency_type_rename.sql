-- SCRUM-38: Emergency Type — category rename
-- Jira categories (in order): Medical Emergency, Domestic Violence, Fire,
-- Burglary, Other Emergency. Stored values:
--   medical | domestic_violence | fire | burglary | other
-- Renames crime_safety → domestic_violence and accident → burglary on every
-- existing row, swaps the check constraint, and updates the one validator
-- that still exists at this point (set_emergency_type; it is dropped in the
-- next SCRUM-36/43 submit migration). unspecified stays allowed in the
-- column for legacy rows only; submit_emergency_alert rejects it.
-- Readers (list_responder_incidents, get_incident_details, shared activation
-- JSON) emit the column as stored, so they pick up the new values without
-- code changes. share_payload never contains the type.
-- Hosted Supabase, no Express, no Edge Functions, no FCM, no Twilio.

-- ---------------------------------------------------------------------------
-- Constraint swap + row rename
-- ---------------------------------------------------------------------------

alter table public.incidents
  drop constraint if exists incidents_emergency_type_allowed;

-- Data rename only; keep historical updated_at (not a user edit).
alter table public.incidents disable trigger incidents_set_updated_at;

update public.incidents
   set emergency_type = case emergency_type
                          when 'crime_safety' then 'domestic_violence'
                          when 'accident' then 'burglary'
                        end
 where emergency_type in ('crime_safety', 'accident');

alter table public.incidents enable trigger incidents_set_updated_at;

alter table public.incidents
  add constraint incidents_emergency_type_allowed
    check (emergency_type in (
      'medical',
      'domestic_violence',
      'fire',
      'burglary',
      'other',
      'unspecified'
    ));

comment on constraint incidents_emergency_type_allowed on public.incidents is
  'SCRUM-38: medical | domestic_violence | fire | burglary | other. unspecified is legacy only (pre-submit rows); submit_emergency_alert rejects it.';

comment on column public.incidents.emergency_type is
  'SCRUM-38: medical | domestic_violence | fire | burglary | other (Jira order). Set once by submit_emergency_alert. unspecified = legacy rows only. crime_safety / accident were renamed to domestic_violence / burglary.';

-- ---------------------------------------------------------------------------
-- set_emergency_type — validate the new set until it is dropped (next file)
-- ---------------------------------------------------------------------------

create or replace function public.set_emergency_type(
  p_incident_id uuid,
  p_emergency_type text
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
  uid := public._require_auth_uid('set_emergency_type');

  if p_emergency_type is null
     or p_emergency_type not in (
       'medical',
       'domestic_violence',
       'fire',
       'burglary',
       'other'
     )
  then
    raise exception using
      errcode = 'P0001',
      message = 'set_emergency_type:invalid_type';
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
      message = 'set_emergency_type:not_found';
  end if;

  if rec.status not in ('activating', 'active') then
    raise exception using
      errcode = 'P0001',
      message = 'set_emergency_type:not_open';
  end if;

  update public.incidents
     set emergency_type = p_emergency_type
   where id = rec.id
  returning * into rec;

  return public._incident_activation_json(rec);
end;
$$;

comment on function public.set_emergency_type(uuid, text) is
  'SCRUM-38 (legacy, dropped by the SCRUM-36/43 submit migration): set emergency_type to medical | domestic_violence | fire | burglary | other.';

revoke all on function public.set_emergency_type(uuid, text) from public;
revoke all on function public.set_emergency_type(uuid, text) from anon;
grant execute on function public.set_emergency_type(uuid, text) to authenticated;
