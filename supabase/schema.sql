-- Score Stand sync schema. Run once in the Supabase SQL editor.
-- Single user: every row carries owner = auth.uid(), and RLS only ever
-- lets the signed-in owner see or change their own rows.
-- Works with "Automatically expose new tables" OFF (recommended): access is granted explicitly below.
-- Also in the dashboard: Authentication → Sign In / Providers → turn OFF "Allow new users to sign up".

create table public.scores (
  id          uuid primary key,
  owner       uuid not null default auth.uid() references auth.users on delete cascade,
  title       text not null,
  tags        text[] not null default '{}',
  page_count  int not null,
  last_page   int not null default 1,
  added_at    timestamptz not null default now(),
  updated_ms  bigint not null,              -- client clock, used for last-write-wins
  synced_at   timestamptz not null default now(),  -- server clock, used as the pull cursor
  deleted     boolean not null default false
);

create table public.ink (
  score_id    uuid not null references public.scores on delete cascade,
  page        int not null,
  owner       uuid not null default auth.uid() references auth.users on delete cascade,
  strokes     jsonb not null,
  updated_ms  bigint not null,
  synced_at   timestamptz not null default now(),
  deleted     boolean not null default false,
  primary key (score_id, page)
);

create table public.setlists (
  id          uuid primary key,
  owner       uuid not null default auth.uid() references auth.users on delete cascade,
  name        text not null,
  score_ids   uuid[] not null default '{}',
  created_at  timestamptz not null default now(),
  updated_ms  bigint not null,              -- client clock, used for last-write-wins
  synced_at   timestamptz not null default now(),  -- server clock, used as the pull cursor
  deleted     boolean not null default false
);

create table public.spots (
  id          uuid primary key,
  owner       uuid not null default auth.uid() references auth.users on delete cascade,
  score_id    uuid not null references public.scores on delete cascade,
  page        int not null,
  label       text not null,
  goal        text,
  tempo       int,
  created_at  timestamptz not null default now(),
  updated_ms  bigint not null,              -- client clock, used for last-write-wins
  synced_at   timestamptz not null default now(),  -- server clock, used as the pull cursor
  deleted     boolean not null default false
);

-- Every write stamps synced_at with the server clock, so devices can ask
-- "what changed since I last looked?" without trusting each other's clocks.
create function public.stamp_synced_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.synced_at := now();
  return new;
end $$;

-- Lock everything down: no access for anonymous visitors at all.
do $$
declare t text;
begin
  foreach t in array array['scores', 'ink', 'setlists', 'spots'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from anon, public', t);
    -- Explicit grants, so this works with "Automatically expose new tables" turned off.
    -- No delete: removals are soft (deleted = true).
    execute format('grant select, insert, update on public.%I to authenticated', t);
    execute format(
      'create policy owner_only on public.%I for all to authenticated using (owner = (select auth.uid())) with check (owner = (select auth.uid()))', t);
    execute format(
      'create trigger stamp before insert or update on public.%I for each row execute function public.stamp_synced_at()', t);
    execute format('create index on public.%I (owner, synced_at)', t);
  end loop;
end $$;

-- Private bucket for PDFs, stored at <owner id>/<score id>.pdf
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('scores', 'scores', false, 83886080, array['application/pdf']);

create policy scores_owner_only on storage.objects for all to authenticated
  using (bucket_id = 'scores' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'scores' and (storage.foldername(name))[1] = (select auth.uid())::text);
