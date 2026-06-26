-- ============================================================
-- Prosell · Boshqaruv paneli (Management Dashboard) kengaytmasi
-- platforms (multi-platform) + managers/calls qo'shimcha ustunlari.
-- Supabase Dashboard → SQL Editor → Run. Idempotent.
-- ============================================================

-- =====================================================
-- platforms — alohida biznes platformalari (text id: 'core', 'retail' ...)
-- =====================================================
create table if not exists public.platforms (
  id          text primary key,
  name        text not null,
  tagline     text,
  initials    text,
  accent      text not null default 'indigo' check (accent in ('indigo','cyan','emerald','violet')),
  created_at  timestamptz not null default now()
);

-- Standart platforma — mavjud barcha ma'lumot shunga tegishli bo'ladi.
insert into public.platforms (id, name, tagline, initials, accent)
values ('core', 'Procell Core', 'Asosiy call-center', 'PC', 'indigo')
on conflict (id) do nothing;

-- =====================================================
-- managers — platforma, lavozim, kunlik reja, onlayn holat
-- =====================================================
alter table public.managers add column if not exists platform_id       text references public.platforms(id) on delete set null;
alter table public.managers add column if not exists role              text;
alter table public.managers add column if not exists daily_call_target integer not null default 20 check (daily_call_target >= 0);
alter table public.managers add column if not exists last_seen_at      timestamptz;

-- Mavjud menejerlarni 'core' platformaga biriktiramiz (filtrlash buzilmasin).
update public.managers set platform_id = 'core' where platform_id is null;
create index if not exists idx_managers_platform on public.managers(platform_id);

-- =====================================================
-- calls — platforma + "sabablarsiz munosabatlar" maydonlari
-- (unanswered_count / bad_leads_count allaqachon bor — qaytadan qo'shilmaydi)
-- =====================================================
alter table public.calls add column if not exists platform_id    text references public.platforms(id) on delete set null;
alter table public.calls add column if not exists bad_lead       boolean not null default false;
alter table public.calls add column if not exists dropped_reason text;

update public.calls set platform_id = 'core' where platform_id is null;
create index if not exists idx_calls_platform on public.calls(platform_id);

notify pgrst, 'reload schema';
