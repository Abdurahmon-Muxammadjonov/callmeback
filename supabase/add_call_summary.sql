-- ============================================================
-- Chuqur tahlil: boy xulosa maydonlari + manager_id nullable + cascade.
-- Supabase Dashboard → SQL Editor → Run. Idempotent.
-- ============================================================

-- 1) Boy xulosa maydonlari (frontend GET /api/calls/:id da kutadi)
alter table public.calls add column if not exists summary             text;
alter table public.calls add column if not exists client_info         text;
alter table public.calls add column if not exists final_agreement     text;
alter table public.calls add column if not exists next_steps          jsonb not null default '[]'::jsonb;
alter table public.calls add column if not exists transcript_segments jsonb not null default '[]'::jsonb;

-- 2) manager_id IXTIYORIY bo'lsin (menejersiz test tahlil uchun)
alter table public.calls alter column manager_id drop not null;

-- 3) Operator o'chirilsa, uning qo'ng'iroqlari ham o'chsin (cascade)
alter table public.calls drop constraint if exists calls_manager_id_fkey;
alter table public.calls
  add constraint calls_manager_id_fkey
  foreign key (manager_id) references public.managers(id) on delete cascade;

notify pgrst, 'reload schema';
