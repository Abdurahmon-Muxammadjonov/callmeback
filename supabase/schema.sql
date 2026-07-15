-- =====================================================
-- ProSell · Call Center Analytics Schema (TO'LIQ, idempotent)
-- Run in: Supabase Dashboard → SQL Editor → New Query
-- Bir necha marta ishlatsa ham xato bermaydi.
-- =====================================================

create extension if not exists "pgcrypto";

-- =====================================================
-- managers
-- =====================================================
create table if not exists public.managers (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  status      text not null default 'active'
              check (status in ('active', 'inactive', 'on_leave', 'flagged')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists idx_managers_status on public.managers(status);

-- =====================================================
-- calls  (backend analyze-call kodi yozadigan barcha ustunlar bilan)
-- =====================================================
create table if not exists public.calls (
  id                uuid primary key default gen_random_uuid(),
  manager_id        uuid not null references public.managers(id) on delete cascade,
  audio_url         text not null,
  total_calls       integer not null default 0 check (total_calls       >= 0),
  incoming_count    integer not null default 0 check (incoming_count    >= 0),
  outgoing_count    integer not null default 0 check (outgoing_count    >= 0),
  duration          integer not null default 0 check (duration          >= 0), -- seconds
  unanswered_count  integer not null default 0 check (unanswered_count  >= 0),
  bad_leads_count   integer not null default 0 check (bad_leads_count   >= 0),
  kpi_score         integer       not null default 0,
  penalty_amount    numeric(12,2) not null default 0,
  bonus_amount      numeric(12,2) not null default 0,
  rop_comment       text          not null default 'Izoh yoq',
  created_at        timestamptz not null default now()
);

-- Mavjud calls jadvaliga yetishmayotgan ustunlarni qo'shish (eski baza uchun)
alter table public.calls add column if not exists kpi_score      integer       not null default 0;
alter table public.calls add column if not exists penalty_amount numeric(12,2) not null default 0;
alter table public.calls add column if not exists bonus_amount   numeric(12,2) not null default 0;
alter table public.calls add column if not exists rop_comment    text          not null default 'Izoh yoq';
alter table public.calls add column if not exists pbx_call_id    text;
alter table public.calls add column if not exists direction      text not null default 'unknown'
  check (direction in ('incoming','outgoing','unknown'));
alter table public.calls add column if not exists client_name    text;
alter table public.calls add column if not exists client_phone   text;
alter table public.calls add column if not exists audio_source_url  text;
alter table public.calls add column if not exists audio_storage_url text;
alter table public.calls add column if not exists audio_storage_path text;

create index if not exists idx_calls_manager_id on public.calls(manager_id);
create index if not exists idx_calls_created_at on public.calls(created_at desc);

-- Partial index that powers the daily KPI query
create index if not exists idx_calls_kpi_lookup
  on public.calls (manager_id, created_at desc)
  where duration > 60;

-- =====================================================
-- conversions
-- =====================================================
create table if not exists public.conversions (
  id                  uuid primary key default gen_random_uuid(),
  call_id             uuid not null references public.calls(id) on delete cascade,
  traffic_conversion  numeric(5,2) not null default 0
                      check (traffic_conversion between 0 and 100),
  sales_conversion    numeric(5,2) not null default 0
                      check (sales_conversion   between 0 and 100),
  stage_1_to_2        integer not null default 0 check (stage_1_to_2 >= 0),
  stage_2_to_3        integer not null default 0 check (stage_2_to_3 >= 0),
  stage_3_to_4        integer not null default 0 check (stage_3_to_4 >= 0),
  created_at          timestamptz not null default now()
);

create index if not exists idx_conversions_call_id on public.conversions(call_id);

-- =====================================================
-- lost_reasons
-- =====================================================
create table if not exists public.lost_reasons (
  id           uuid primary key default gen_random_uuid(),
  call_id      uuid not null references public.calls(id) on delete cascade,
  reason_text  text not null,
  count        integer not null default 1 check (count > 0),
  status       text not null default 'open'
               check (status in ('open', 'reviewed', 'resolved', 'dismissed')),
  created_at   timestamptz not null default now()
);

create index if not exists idx_lost_reasons_call_id on public.lost_reasons(call_id);
create index if not exists idx_lost_reasons_status  on public.lost_reasons(status);

-- =====================================================
-- users  (CRUD API uchun)
-- =====================================================
create table if not exists public.users (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  email         text unique not null,
  age           integer,
  phone         text,
  role          text not null default 'user',
  password_hash text,
  created_at    timestamptz not null default now()
);

-- Eski users jadvaliga password_hash ustunini qo'shish (idempotent)
alter table public.users add column if not exists password_hash text;

-- calls -> users bog'lanishi (mijoz o'chirilsa ham qo'ng'iroq tarixi saqlanadi)
alter table public.calls add column if not exists client_id uuid references public.users(id) on delete set null;

-- =====================================================
-- updated_at trigger for managers
-- =====================================================
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_managers_updated_at on public.managers;
create trigger trg_managers_updated_at
  before update on public.managers
  for each row execute function public.set_updated_at();

-- =====================================================
-- Row Level Security
-- Secret/service_role kalit RLS ni avtomatik aylanib o'tadi.
-- Bu policy'lar anon/authenticated kirishni boshqaradi.
-- DROP ... IF EXISTS -> qayta ishlatsa "already exists" xatosi chiqmaydi.
-- =====================================================
alter table public.managers     enable row level security;
alter table public.calls        enable row level security;
alter table public.conversions  enable row level security;
alter table public.lost_reasons enable row level security;

-- users serverdagi secret kalit orqali boshqariladi; RLS shart emas
alter table public.users disable row level security;

drop policy if exists "managers_read_authenticated" on public.managers;
create policy "managers_read_authenticated"
  on public.managers for select to authenticated using (true);

drop policy if exists "calls_read_authenticated" on public.calls;
create policy "calls_read_authenticated"
  on public.calls for select to authenticated using (true);

drop policy if exists "conversions_read_authenticated" on public.conversions;
create policy "conversions_read_authenticated"
  on public.conversions for select to authenticated using (true);

drop policy if exists "lost_reasons_read_authenticated" on public.lost_reasons;
create policy "lost_reasons_read_authenticated"
  on public.lost_reasons for select to authenticated using (true);

-- PostgREST schema cache'ni yangilash
notify pgrst, 'reload schema';
