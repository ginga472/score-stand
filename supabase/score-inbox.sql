-- Library access for the reviewer (Claude): lets a linked reviewer manage your score library.
-- Run in the Supabase SQL editor, after schema.sql and sessions.sql. Safe to re-run.
--
-- The reviewer can list, add, rename, retag and remove scores (removal is a soft delete, same as the
-- app), read and upload their PDFs, and organize setlists. Your markup (ink) and practice spots stay
-- owner-only. Everything it writes is owned by you, so your devices pick it up on the next sync.
-- To revoke, run the drops at the bottom (or delete the reviewer user to revoke everything).

-- Clean up the earlier add-only version, if it was installed.
drop policy if exists scores_reviewer_add on storage.objects;
drop policy if exists scores_reviewer_uploaded_read on storage.objects;
drop policy if exists scores_reviewer_own_read on storage.objects;
drop policy if exists scores_reviewer_own_delete on storage.objects;
drop function if exists public.add_score(uuid, text, int, text[]), public.remove_score(uuid),
  public.reviewer_scores_list(), public.reviewer_added_file(text), public.reserve_score(uuid);
drop table if exists public.reviewer_scores;

-- Rows: read and write scores and setlists of the account it reviews for (the row's owner stays you).
drop policy if exists reviewer_manage on public.scores;
create policy reviewer_manage on public.scores for all to authenticated
  using (public.reviews_for(owner::text)) with check (public.reviews_for(owner::text));
drop policy if exists reviewer_manage on public.setlists;
create policy reviewer_manage on public.setlists for all to authenticated
  using (public.reviews_for(owner::text)) with check (public.reviews_for(owner::text));

-- Files: read, upload, replace and delete PDFs in your folder of the private `scores` bucket.
drop policy if exists scores_reviewer_manage on storage.objects;
create policy scores_reviewer_manage on storage.objects for all to authenticated
  using (bucket_id = 'scores' and public.reviews_for((storage.foldername(name))[1]))
  with check (bucket_id = 'scores' and public.reviews_for((storage.foldername(name))[1]));

-- To revoke just this (session reviews keep working), run these lines without the leading "--":
-- drop policy if exists reviewer_manage on public.scores;
-- drop policy if exists reviewer_manage on public.setlists;
-- drop policy if exists scores_reviewer_manage on storage.objects;
