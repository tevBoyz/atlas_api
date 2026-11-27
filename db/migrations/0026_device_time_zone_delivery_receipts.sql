-- Gaps_Adressed Stage 2: [TZ] the receiving device's time zone, and [B7] delivery receipts (D77).
--
-- 1. [TZ] `user_devices.time_zone` (text, nullable): the IANA time zone the app last reported for
--    this installation (`PUT /v1/me/devices/current` body `time_zone`, sent on every registration).
--    Every push text formats its time in the receiving device's zone, else the profile's
--    `timezone`, else Africa/Banjul. Null = not reported, or the value sent was not a known IANA zone
--    (the API stores null instead of refusing the registration). Existing rows keep null.
-- 2. [B7] `notification_deliveries.delivered_at` (timestamptz, nullable): when the receiving phone
--    confirmed that it received the push (`POST /v1/notifications/receipts`); the row then moves from
--    `sent` (accepted by the push service) to `delivered`. A receipt that arrives while the row is
--    still `queued` (before the provider's answer was written) is kept on the `queued` row, and the
--    sender then writes `delivered` instead of `sent`. Check
--    `notification_deliveries_delivered_at_shape`: set only on a `queued` or `delivered` row. Every
--    existing row meets it (the column is new). `final_at` keeps the time the row became final.
--
-- Additive and backward compatible (AGENTS.md rule 4): two nullable columns and one check. Both
-- tables keep their lockdown (0005, 0007). Written only by the API. Re-runnable on a fresh database
-- after the baseline.

alter table public.user_devices
  add column if not exists time_zone text null;

comment on column public.user_devices.time_zone is
  'Stage 2 [TZ]: the IANA time zone the app reported for this installation at its last '
  'registration; push times are shown in it (else profiles.timezone, else Africa/Banjul). Null = '
  'not reported or not a known zone. Written only by the API.';

alter table public.notification_deliveries
  add column if not exists delivered_at timestamptz null;

alter table public.notification_deliveries
  drop constraint if exists notification_deliveries_delivered_at_shape,
  add constraint notification_deliveries_delivered_at_shape
    check (delivered_at is null or status in ('queued', 'delivered'));

comment on column public.notification_deliveries.delivered_at is
  'Stage 2 [B7] (D77): when the receiving phone confirmed receipt of the push '
  '(POST /v1/notifications/receipts); set only on a queued (receipt before the provider answer) or '
  'delivered row. Accepted by the push service alone is sent.';
