-- Woodshed practice sessions. Run once in the Supabase SQL editor (after schema.sql).
-- Additive: it doesn't touch the score tables.
--
-- The iPad app (signed in as you) uploads each saved session: the raw file to the private
-- `sessions` bucket at <owner id>/<file name>, and a summary row here. RLS keeps both owner-only.
-- Claude never signs in as you. It goes through the claude-sessions edge function, which holds
-- its own revocable key and can only list sessions, download one and write its review.

create table if not exists public.practice_sessions (
  owner          uuid not null default auth.uid() references auth.users on delete cascade,
  name           text not null check (name ~ '^session-\d{4}-\d{2}-\d{2}-\d{6}\.json$'),
  started_at     timestamptz not null,
  duration_ms    bigint not null,
  playing_ms     bigint not null,
  note_count     int not null,
  pieces         text[] not null default '{}',
  sprint_rounds  int not null default 0,
  uploaded_at    timestamptz not null default now(),
  review         jsonb,                 -- Claude's notes (same shape as the app's woodshed block)
  review_at      timestamptz,           -- set when the review is written; the app pulls by this
  primary key (owner, name)
);

alter table public.practice_sessions enable row level security;
alter table public.practice_sessions force row level security;
revoke all on public.practice_sessions from anon, public;
grant select, insert, update on public.practice_sessions to authenticated;
drop policy if exists owner_only on public.practice_sessions;
create policy owner_only on public.practice_sessions for all to authenticated
  using (owner = (select auth.uid())) with check (owner = (select auth.uid()));
create index if not exists practice_sessions_review_at on public.practice_sessions (owner, review_at);

-- Private bucket for session files, stored at <owner id>/<session file name>
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('sessions', 'sessions', false, 20971520, array['application/json'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists sessions_owner_only on storage.objects;
create policy sessions_owner_only on storage.objects for all to authenticated
  using (bucket_id = 'sessions' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'sessions' and (storage.foldername(name))[1] = (select auth.uid())::text);
