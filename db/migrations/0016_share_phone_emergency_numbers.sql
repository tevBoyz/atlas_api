-- SCRUM-52 (Call Resident, decision D59) and SCRUM-54 (Emergency services shortcut, decision D60).
--
-- Additive and backward compatible (AGENTS.md rule 4):
-- - `profiles.share_phone` (boolean, not null, default TRUE): "share my phone number" with the
--   members of an alert. ON by default for new AND existing profiles (Dawit 2026-11-24, D59): the
--   column default fills every existing row. When on, the API adds `resident_phone` (the account's
--   CONFIRMED phone, `users.phone` with `phone_confirmed_at` set) to the share payload of an incident.
--   The old SQL functions never read it (their payload has no `resident_phone`); their explicit
--   inserts keep working through the default.
-- - `app_config` row `emergency_numbers` (D60): the local emergency numbers by country (ISO 3166-1
--   alpha-2), read by the API on every request (no restart needed to change them). Seeded for The
--   Gambia: Ambulance 116, Police 117, Fire and Rescue 119. `on conflict do nothing`: a re-run never
--   resets a value ops already changed.
-- Re-runnable on a fresh database after the baseline.

alter table public.profiles
  add column if not exists share_phone boolean not null default true;

comment on column public.profiles.share_phone is
  'SCRUM-52 (D59): share the account''s confirmed phone (users.phone) with the members of an alert '
  '(share payload key resident_phone). On by default. Written only by the API.';

insert into public.app_config (key, value)
values (
  'emergency_numbers',
  '{"GM": [
     {"service": "ambulance", "label": "Ambulance", "number": "116"},
     {"service": "police", "label": "Police", "number": "117"},
     {"service": "fire_rescue", "label": "Fire and Rescue", "number": "119"}
   ]}'::jsonb
)
on conflict (key) do nothing;
