-- Score inbox: lets a linked reviewer (Claude) add new scores to your library, and remove the ones
-- it added (e.g. sight-reading sheets that went stale). Your own scores stay untouchable.
-- Run once in the Supabase SQL editor, after schema.sql and sessions.sql. Additive and safe to re-run.
--
-- What the reviewer can do:
--   1. Upload a new PDF to the private `scores` bucket at <your id>/<new score id>.pdf.
--      Insert only: it can't read, list, overwrite or delete any file there.
--   2. Call add_score(), which creates the library row for a PDF it just uploaded.
--      It never updates an existing row (an id that's taken is refused), and it can't read your library.
--   3. List and remove only scores it added itself (recorded in reviewer_scores by add_score):
--      reviewer_scores_list() and remove_score(), plus read/delete of those PDFs only.
-- Your devices pick the new score up on their next sync, like a score imported on another device.
-- You stay in charge: edit, retag or delete any score in the app as usual. To revoke, run the drops at the bottom.

-- Which scores a reviewer added. No API access at all; only the functions below use it.
create table if not exists public.reviewer_scores (
  score_id  uuid primary key references public.scores on delete cascade,
  reviewer  uuid not null references auth.users on delete cascade,
  owner     uuid not null references auth.users on delete cascade,
  added_at  timestamptz not null default now()
);
alter table public.reviewer_scores enable row level security;
alter table public.reviewer_scores force row level security;
revoke all on public.reviewer_scores from anon, authenticated, public;

-- True when the signed-in reviewer added the score whose PDF lives at this storage path.
create or replace function public.reviewer_added_file(path text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.reviewer_scores rs
                 where rs.reviewer = (select auth.uid())
                   and public.reviews_for(rs.owner::text)
                   and path = rs.owner::text || '/' || rs.score_id::text || '.pdf');
$$;
revoke all on function public.reviewer_added_file(text) from anon, public;
grant execute on function public.reviewer_added_file(text) to authenticated;

drop policy if exists scores_reviewer_own_read on storage.objects;
create policy scores_reviewer_own_read on storage.objects for select to authenticated
  using (bucket_id = 'scores' and public.reviewer_added_file(name));
drop policy if exists scores_reviewer_own_delete on storage.objects;
create policy scores_reviewer_own_delete on storage.objects for delete to authenticated
  using (bucket_id = 'scores' and public.reviewer_added_file(name));

drop policy if exists scores_reviewer_add on storage.objects;
create policy scores_reviewer_add on storage.objects for insert to authenticated
  with check (
    bucket_id = 'scores'
    and public.reviews_for((storage.foldername(name))[1])
    and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$'
  );

-- Creates the row for a PDF the reviewer uploaded. Returns true when added, false when the id is already taken.
create or replace function public.add_score(p_id uuid, p_title text, p_page_count int, p_tags text[] default '{}')
returns boolean
language plpgsql security definer set search_path = '' as $$
declare oid uuid; n int; tags text[];
begin
  select r.owner into oid from public.session_reviewers r where r.reviewer = (select auth.uid());
  if oid is null then raise exception 'not a linked reviewer'; end if;
  if p_title is null or length(btrim(p_title)) not between 1 and 200 then raise exception 'title must be 1-200 characters'; end if;
  if p_page_count is null or p_page_count not between 1 and 500 then raise exception 'page_count must be 1-500'; end if;
  if coalesce(cardinality(p_tags), 0) > 8 or exists (select 1 from unnest(p_tags) t where length(t) not between 1 and 40) then
    raise exception 'up to 8 tags of 1-40 characters';
  end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'scores' and o.name = oid::text || '/' || p_id::text || '.pdf') then
    raise exception 'upload the PDF first';
  end if;
  tags := array(select distinct t from unnest(coalesce(p_tags, '{}') || array['from Claude']) t);
  insert into public.scores (id, owner, title, tags, page_count, last_page, updated_ms)
  values (p_id, oid, btrim(p_title), tags, p_page_count, 1, (extract(epoch from now()) * 1000)::bigint)
  on conflict (id) do nothing;
  get diagnostics n = row_count;
  if n > 0 then
    insert into public.reviewer_scores (score_id, reviewer, owner) values (p_id, (select auth.uid()), oid);
  end if;
  return n > 0;
end $$;
revoke all on function public.add_score(uuid, text, int, text[]) from anon, public;
grant execute on function public.add_score(uuid, text, int, text[]) to authenticated;

-- The scores this reviewer added that are still in your library (title only; nothing of yours).
create or replace function public.reviewer_scores_list()
returns table (id uuid, title text, page_count int, added_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select s.id, s.title, s.page_count, rs.added_at
    from public.reviewer_scores rs join public.scores s on s.id = rs.score_id
   where rs.reviewer = (select auth.uid()) and public.reviews_for(rs.owner::text) and not s.deleted
   order by rs.added_at;
$$;
revoke all on function public.reviewer_scores_list() from anon, public;
grant execute on function public.reviewer_scores_list() to authenticated;

-- Removes a score this reviewer added (soft delete, like the app; devices drop it on next sync,
-- along with its markup and spots). Refuses any other score. Delete the PDF via storage first.
create or replace function public.remove_score(p_id uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  update public.scores s set deleted = true, updated_ms = (extract(epoch from now()) * 1000)::bigint
   where s.id = p_id and not s.deleted
     and exists (select 1 from public.reviewer_scores rs
                 where rs.score_id = p_id and rs.reviewer = (select auth.uid()) and public.reviews_for(rs.owner::text));
  get diagnostics n = row_count;
  return n > 0;
end $$;
revoke all on function public.remove_score(uuid) from anon, public;
grant execute on function public.remove_score(uuid) to authenticated;

-- To revoke just this (session reviews keep working):
--   -- Which scores a reviewer added. No API access at all; only the functions below use it.
create table if not exists public.reviewer_scores (
  score_id  uuid primary key references public.scores on delete cascade,
  reviewer  uuid not null references auth.users on delete cascade,
  owner     uuid not null references auth.users on delete cascade,
  added_at  timestamptz not null default now()
);
alter table public.reviewer_scores enable row level security;
alter table public.reviewer_scores force row level security;
revoke all on public.reviewer_scores from anon, authenticated, public;

-- True when the signed-in reviewer added the score whose PDF lives at this storage path.
create or replace function public.reviewer_added_file(path text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.reviewer_scores rs
                 where rs.reviewer = (select auth.uid())
                   and public.reviews_for(rs.owner::text)
                   and path = rs.owner::text || '/' || rs.score_id::text || '.pdf');
$$;
revoke all on function public.reviewer_added_file(text) from anon, public;
grant execute on function public.reviewer_added_file(text) to authenticated;

drop policy if exists scores_reviewer_own_read on storage.objects;
create policy scores_reviewer_own_read on storage.objects for select to authenticated
  using (bucket_id = 'scores' and public.reviewer_added_file(name));
drop policy if exists scores_reviewer_own_delete on storage.objects;
create policy scores_reviewer_own_delete on storage.objects for delete to authenticated
  using (bucket_id = 'scores' and public.reviewer_added_file(name));

drop policy if exists scores_reviewer_add on storage.objects;
--   drop function if exists public.add_score(uuid, text, int, text[]);
