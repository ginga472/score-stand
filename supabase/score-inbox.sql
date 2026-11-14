-- Score inbox: lets a linked reviewer (Claude) ADD new scores to your library, and nothing more.
-- Run once in the Supabase SQL editor, after schema.sql and sessions.sql. Additive and safe to re-run.
--
-- What the reviewer can do:
--   1. Upload a new PDF to the private `scores` bucket at <your id>/<new score id>.pdf.
--      Insert only: it can't read, list, overwrite or delete any file there.
--   2. Call add_score(), which creates the library row for a PDF it just uploaded.
--      It never updates an existing row (an id that's taken is refused), and it can't read your library.
-- Your devices pick the new score up on their next sync, like a score imported on another device.
-- You stay in charge: edit, retag or delete it in the app as usual. To revoke, run the two drops at the bottom.

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
  return n > 0;
end $$;
revoke all on function public.add_score(uuid, text, int, text[]) from anon, public;
grant execute on function public.add_score(uuid, text, int, text[]) to authenticated;

-- To revoke just this (session reviews keep working):
--   drop policy if exists scores_reviewer_add on storage.objects;
--   drop function if exists public.add_score(uuid, text, int, text[]);
