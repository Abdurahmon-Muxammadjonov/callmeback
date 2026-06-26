-- ============================================================
-- CRITERIA jadvali — admin qo'shadigan dinamik baholash qoidalari.
-- category / weight / type bilan (frontend shularni kutadi).
-- type: 'Majburiy' | 'Jarima' | 'Bonus'
-- Supabase Dashboard → SQL Editor → Run. Idempotent.
-- ============================================================

create extension if not exists "pgcrypto";

create table if not exists public.criteria (
  id             uuid primary key default gen_random_uuid(),
  title          text not null,
  description    text not null,
  penalty_amount numeric(12,2) not null default 0,
  is_active      boolean not null default true,
  category       text,
  weight         integer not null default 0 check (weight between 0 and 100),
  type           text not null default 'Majburiy' check (type in ('Majburiy','Jarima','Bonus')),
  created_at     timestamptz not null default timezone('utc'::text, now())
);

-- Eski criteria jadvaliga yangi ustunlarni qo'shish (idempotent)
alter table public.criteria add column if not exists category text;
alter table public.criteria add column if not exists weight integer not null default 0;
alter table public.criteria add column if not exists type text not null default 'Majburiy';

alter table public.criteria disable row level security;

create index if not exists idx_criteria_active   on public.criteria(is_active);
create index if not exists idx_criteria_category on public.criteria(category);

notify pgrst, 'reload schema';
