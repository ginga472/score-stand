-- Woodshed practice sessions. Run once in the Supabase SQL editor (after schema.sql).
-- Additive: it doesn't touch the score tables.
--
-- The iPad app (signed in as you) uploads each saved session: the raw file to the private
-- `sessions` bucket at <owner id>/<file name>, and a summary row here. RLS keeps both owner-only.
-- Reviewers (Claude) never sign in as you and no admin key is used anywhere. A reviewer is its own
-- Supabase user, linked to you in session_reviewers. The database itself limits it to: reading your
-- session rows and files, and writing notes through save_session_notes(). Nothing else: no score
-- tables, no other columns, no deletes. Remove its row in session_reviewers (or the user) to revoke.

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
  review         jsonb,                 -- notes on the session (same shape as the app's woodshed block)
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

-- ---------- Reviewers ----------
-- Who may review whose sessions. No policies: nobody reads it over the API; the helper below does.
create table if not exists public.session_reviewers (
  reviewer uuid not null references auth.users on delete cascade,
  owner    uuid not null references auth.users on delete cascade,
  primary key (reviewer, owner),
  check (reviewer <> owner)
);
alter table public.session_reviewers enable row level security;
alter table public.session_reviewers force row level security;
revoke all on public.session_reviewers from anon, authenticated, public;

-- True when the signed-in user reviews sessions for this owner (owner given as uuid text).
create or replace function public.reviews_for(owner_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.session_reviewers r
                 where r.reviewer = (select auth.uid()) and r.owner::text = owner_id);
$$;
revoke all on function public.reviews_for(text) from anon, public;
grant execute on function public.reviews_for(text) to authenticated;

-- Reviewers can read the rows and files of the people they review for. Writes stay owner-only.
drop policy if exists reviewer_read on public.practice_sessions;
create policy reviewer_read on public.practice_sessions for select to authenticated
  using (public.reviews_for(owner::text));
drop policy if exists sessions_reviewer_read on storage.objects;
create policy sessions_reviewer_read on storage.objects for select to authenticated
  using (bucket_id = 'sessions' and public.reviews_for((storage.foldername(name))[1]));

-- The only write a reviewer can make: the notes on one session, as a JSON object under 100 KB.
create or replace function public.save_session_notes(p_name text, p_notes jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  if jsonb_typeof(p_notes) is distinct from 'object' or octet_length(p_notes::text) > 100000 then
    raise exception 'notes must be a JSON object under 100 KB';
  end if;
  update public.practice_sessions s set review = p_notes, review_at = now()
   where s.name = p_name and public.reviews_for(s.owner::text);
  get diagnostics n = row_count;
  return n > 0;
end $$;
revoke all on function public.save_session_notes(text, jsonb) from anon, public;
grant execute on function public.save_session_notes(text, jsonb) to authenticated;

-- Link the reviewer account. setup-sessions.sh fills in its email. It is linked to the account that
-- owns your synced scores (the one real user; probe accounts from old sign-up tests are skipped).
-- Safe to run again.
do $$
declare rid uuid; oid uuid; owners int;
begin
  select id into rid from auth.users where email = lower('{{REVIEWER_EMAIL}}');
  if rid is null then raise notice 'No reviewer user yet: create it first, then run this again.'; return; end if;
  select count(distinct owner), min(owner::text)::uuid into owners, oid
    from (select owner from public.scores union select owner from public.practice_sessions) o where owner <> rid;
  if owners <> 1 then raise exception 'Expected one account with synced data, found %', owners; end if;
  insert into public.session_reviewers (reviewer, owner) values (rid, oid) on conflict do nothing;
  raise notice 'Reviewer linked.';
end $$;
