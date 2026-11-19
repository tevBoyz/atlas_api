-- Phase 1 rollback switch (docs/phase1_handoff.md section 5): the app_config row the mobile app
-- reads to choose the backend for its incident area. Values: '"supabase"' (default, the SQL RPCs)
-- or '"api"' (this API). Flip it as the service role / postgres, for example:
--   update public.app_config set value = '"api"'::jsonb where key = 'client_incidents_backend';
--
-- Data only, additive and idempotent (AGENTS.md rule 4): one new row in the existing
-- public.app_config (baseline 20261023110000_scrum41_live_location.sql), seeded in the same style
-- as the live-location keys. `on conflict do nothing` keeps a value ops already set. Signed-in users
-- read it through the existing app_config_select_authenticated policy; they cannot write it
-- (the baseline grants `authenticated` SELECT only).

insert into public.app_config (key, value)
values ('client_incidents_backend', '"supabase"'::jsonb)
on conflict (key) do nothing;
