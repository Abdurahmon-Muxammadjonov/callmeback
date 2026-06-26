-- ============================================================
-- Prosell · Staff Manager (users-asosli) + skript/bildirishnoma/smena
-- Frontend kontrakti: /users/:id/*, /manager-notifications, /shifts/events
-- Supabase Dashboard → SQL Editor → Run. Idempotent.
-- ============================================================

create extension if not exists "pgcrypto";

-- 0) users ustunlari (barchasi nullable — eski yozuvlar buzilmaydi)
alter table public.users add column if not exists first_name              text;
alter table public.users add column if not exists last_name               text;
alter table public.users add column if not exists phone                   text;
alter table public.users add column if not exists shift_start             text;  -- "09:00"
alter table public.users add column if not exists shift_end               text;  -- "18:00"
alter table public.users add column if not exists credentials_changed_at  timestamptz;
-- XAVFSIZLIK: ochiq parol saqlanmaydi. Agar avval password_plain qo'shilgan
-- bo'lsa — uni va undagi barcha ochiq parollarni butunlay o'chiramiz.
alter table public.users drop column if exists password_plain;

-- 1) user_scripts — operatorga biriktirilgan skriptlar (replace-on-PUT)
create table if not exists public.user_scripts (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users(id) on delete cascade,
  title      text not null,
  enabled    boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists idx_user_scripts_user on public.user_scripts(user_id);

-- 2) user_notifications — Bell uchun (read = false → ko'k nuqta)
create table if not exists public.user_notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users(id) on delete cascade,
  message    text not null,
  read       boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists idx_user_notif_user on public.user_notifications(user_id, read);

-- 3) shift_events — smena boshlanishi/tugashi (kuniga bittadan, on-read yaratiladi)
create table if not exists public.shift_events (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users(id) on delete cascade,
  type       text not null check (type in ('start', 'end')),
  at         timestamptz not null default now(),
  event_date date not null default current_date,
  unique (user_id, type, event_date)
);
create index if not exists idx_shift_events_user on public.shift_events(user_id, at desc);

alter table public.user_scripts       disable row level security;
alter table public.user_notifications disable row level security;
alter table public.shift_events       disable row level security;

notify pgrst, 'reload schema';
