-- ============================================================
-- calls ga to'liq dialog (kim nima gapirgani) uchun transcript_segments ustuni.
-- Format: [{ "speaker": "Manager"|"Mijoz", "text": "...", "start": 12.5 }, ...]
-- Supabase Dashboard → SQL Editor → Run. Idempotent.
-- ============================================================

alter table public.calls
  add column if not exists transcript_segments jsonb not null default '[]'::jsonb;

notify pgrst, 'reload schema';
