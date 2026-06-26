-- ============================================================
-- Fon (background) tahlil uchun status kuzatuvi.
-- status: 'processing' | 'done' | 'failed'
-- Frontend batch yuborgach, shu ustun orqali holatni poll qiladi.
--  Supabase Dashboard → SQL Editor → Run. Idempotent.
-- ============================================================

alter table public.calls add column if not exists status text not null default 'done';
alter table public.calls add column if not exists error  text;

create index if not exists idx_calls_status on public.calls(status);

notify pgrst, 'reload schema';
