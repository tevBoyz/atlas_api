-- Gap 49 (a push token is not re-registered after it is cleared), decision D69.
--
-- Additive and backward compatible (AGENTS.md rule 4): one nullable column on `user_devices`.
-- - `push_token_invalid_hash` (text, null): the SHA-256 (lowercase hex) of the last push token the
--   provider (FCM / APNs) answered `unregistered` for on this device. Set by the delivery worker in
--   the same statement that clears `push_token`; never the token itself. U1
--   (`PUT /v1/me/devices/current`) refuses to store a token whose SHA-256 equals it and answers
--   `push_token_status` = `invalid`, so the app fetches a brand-new token; storing any other token
--   clears it. Existing rows keep null.
-- The table keeps its lockdown from 0005 (RLS on, no grants for the Supabase API roles); a new
-- column inherits it. Re-runnable on a fresh database after the baseline.

alter table public.user_devices
  add column if not exists push_token_invalid_hash text null;

comment on column public.user_devices.push_token_invalid_hash is
  'Gap 49 (D69): SHA-256 (hex) of the last push token the provider answered unregistered for on '
  'this device (never the token). U1 refuses that token (push_token_status invalid); storing any '
  'other token clears it. Written only by the API.';
