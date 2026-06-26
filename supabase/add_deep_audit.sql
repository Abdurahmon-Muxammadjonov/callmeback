-- ============================================================
-- Chuqur tahlil (Deep Audit) ma'lumotini saqlash.
-- calls ga transcript/sentiment/risk + call_criteria_scores jadvali.
-- Supabase Dashboard → SQL Editor → Run. Idempotent.
-- ============================================================

create extension if not exists "pgcrypto";

-- calls ga yangi ustunlar
alter table public.calls add column if not exists transcript text;
alter table public.calls add column if not exists sentiment text;
alter table public.calls add column if not exists risk text;

-- Har bir qoida bo'yicha ball (0–100)
create table if not exists public.call_criteria_scores (
  id         uuid primary key default gen_random_uuid(),
  call_id    uuid not null references public.calls(id) on delete cascade,
  title      text not null,
  category   text,
  score      integer not null default 0 check (score between 0 and 100),
  created_at timestamptz not null default now()
);

create index if not exists idx_ccs_call_id on public.call_criteria_scores(call_id);
alter table public.call_criteria_scores disable row level security;

notify pgrst, 'reload schema';
