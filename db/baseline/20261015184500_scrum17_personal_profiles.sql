-- SCRUM-17: New User Personal Profile Setup
-- profiles row keyed by auth.users.id + public avatars storage bucket.

-- ---------------------------------------------------------------------------
-- profiles
-- ---------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null,
  date_of_birth date not null,
  gender text null,
  avatar_path text null,
  personal_info_completed_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint profiles_full_name_nonempty
    check (char_length(trim(full_name)) > 0),
  constraint profiles_gender_allowed
    check (
      gender is null
      or gender in ('female', 'male', 'prefer_not_to_say')
    )
);

comment on table public.profiles is
  'Atlas user personal profile (SCRUM-17). Phone/email stay on auth.users.';
comment on column public.profiles.full_name is
  'Required display name from Personal Info Continue.';
comment on column public.profiles.date_of_birth is
  'Required date of birth; client must reject future dates.';
comment on column public.profiles.gender is
  'Optional: female | male | prefer_not_to_say.';
comment on column public.profiles.avatar_path is
  'Object path inside the avatars bucket, e.g. {user_id}/avatar.jpg. Null if no photo.';
comment on column public.profiles.personal_info_completed_at is
  'Set when Personal Info Continue succeeds. Null means step still needed.';

create index profiles_personal_info_completed_at_idx
  on public.profiles (personal_info_completed_at);

create or replace function public.set_profiles_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row
  execute function public.set_profiles_updated_at();

alter table public.profiles enable row level security;

create policy "profiles_select_own"
  on public.profiles
  for select
  to authenticated
  using (auth.uid() = id);

create policy "profiles_insert_own"
  on public.profiles
  for insert
  to authenticated
  with check (auth.uid() = id);

create policy "profiles_update_own"
  on public.profiles
  for update
  to authenticated
  using (auth.uid() = id)
  with check (auth.uid() = id);

grant select, insert, update on table public.profiles to authenticated;

-- ---------------------------------------------------------------------------
-- Storage: avatars bucket (public read; write only own folder)
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'avatars',
  'avatars',
  true,
  5242880,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Path convention: {auth.uid()}/avatar.jpg (or .png / .webp)

create policy "avatars_select_public"
  on storage.objects
  for select
  to public
  using (bucket_id = 'avatars');

create policy "avatars_insert_own"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "avatars_update_own"
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "avatars_delete_own"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
