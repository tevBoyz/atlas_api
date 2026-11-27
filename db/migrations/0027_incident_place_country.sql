-- Gaps_Adressed Stage 2: [B6] the place of an alert and [B9] its country.
--
-- `incidents.place_name` (text, nullable): the place the resident's phone reverse-geocoded from the
-- current or last known fix (e.g. "Serrekunda"), sent with the SOS (`POST /v1/incidents`) or a
-- location report (`POST /v1/incidents/{id}/locations`); the latest one sent wins. The alert push
-- says "· near <place_name>" when it is known at send time, else "· Location unavailable" (never
-- coordinates). Check `incidents_place_name_shape`: 1-120 characters, no leading or trailing space.
--
-- `incidents.country_code` (text, nullable): ISO 3166-1 alpha-2 country of that place, uppercase
-- (check `incidents_country_code_shape`). The incident reads choose `emergency_services` from
-- `app_config.emergency_numbers` by it; missing or a country without numbers -> The Gambia (D60).
--
-- Every existing row meets both checks (the columns are new). Additive and backward compatible
-- (AGENTS.md rule 4): two nullable columns and two checks. Written only by the API. Re-runnable on a
-- fresh database after the baseline.

alter table public.incidents
  add column if not exists place_name text null,
  add column if not exists country_code text null;

alter table public.incidents
  drop constraint if exists incidents_place_name_shape,
  add constraint incidents_place_name_shape
    check (place_name is null
           or (char_length(place_name) between 1 and 120 and place_name = btrim(place_name)));

alter table public.incidents
  drop constraint if exists incidents_country_code_shape,
  add constraint incidents_country_code_shape
    check (country_code is null or country_code ~ '^[A-Z]{2}$');

comment on column public.incidents.place_name is
  'Stage 2 [B6]: the reverse-geocoded place of the alert (latest sent with the SOS or a location '
  'report); the alert push says near <place_name>, else Location unavailable. Never coordinates.';

comment on column public.incidents.country_code is
  'Stage 2 [B9]: ISO 3166-1 alpha-2 country of the alert (uppercase); emergency_services are chosen '
  'by it from app_config emergency_numbers, missing or unknown -> GM (D60).';
