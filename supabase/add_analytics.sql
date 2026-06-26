-- ============================================================
-- Prosell · Analitika & Multi-tenancy kengaytmasi
-- Supabase Dashboard → SQL Editor → Run. Idempotent.
-- Barcha FK'lar mavjud public.managers(id) (UUID) ga bog'lanadi.
-- ============================================================

create extension if not exists "pgcrypto";

-- =====================================================
-- 1) tenant_platforms — alohida biznes platformalari (multi-tenancy)
-- =====================================================
create table if not exists public.tenant_platforms (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  slug        text unique not null,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);
create index if not exists idx_tenant_active on public.tenant_platforms(is_active);

-- managers va leads'ni tenant'ga bog'lash (nullable — eski yozuvlar buzilmaydi)
alter table public.managers add column if not exists tenant_id uuid references public.tenant_platforms(id) on delete set null;
create index if not exists idx_managers_tenant on public.managers(tenant_id);

-- =====================================================
-- 2) daily_targets — har bir menejer uchun kunlik reja
-- =====================================================
create table if not exists public.daily_targets (
  id           uuid primary key default gen_random_uuid(),
  manager_id   uuid not null references public.managers(id) on delete cascade,
  target_date  date not null default current_date,
  daily_target integer not null default 0 check (daily_target >= 0),
  notes        text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (manager_id, target_date)
);
create index if not exists idx_daily_targets_manager_date on public.daily_targets(manager_id, target_date desc);

-- =====================================================
-- 3) dashboards_metadata — boshqaruv/ROP/KPI ko'rinishlari uchun saqlangan metrikalar
-- =====================================================
create table if not exists public.dashboards_metadata (
  id           uuid primary key default gen_random_uuid(),
  scope        text not null default 'core' check (scope in ('executive', 'rop', 'core')),
  metric_key   text not null,
  metric_value jsonb not null default '{}'::jsonb,
  period       text not null default 'all' check (period in ('day', 'week', 'month', 'all')),
  tenant_id    uuid references public.tenant_platforms(id) on delete cascade,
  computed_at  timestamptz not null default now(),
  unique (scope, metric_key, period, tenant_id)
);
create index if not exists idx_dashboards_scope on public.dashboards_metadata(scope, period);

-- =====================================================
-- 4) leads — voronka (funnel) bosqichma-bosqich kuzatuvi
-- =====================================================
create table if not exists public.leads (
  id          uuid primary key default gen_random_uuid(),
  manager_id  uuid references public.managers(id) on delete set null,
  tenant_id   uuid references public.tenant_platforms(id) on delete set null,
  call_id     uuid references public.calls(id) on delete set null,
  stage       text not null default 'lead_generated'
              check (stage in ('lead_generated','contacted','qualified','proposal','negotiation','deal_closed','lost')),
  source      text,
  value       numeric(14,2) not null default 0 check (value >= 0),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  closed_at   timestamptz
);
create index if not exists idx_leads_stage      on public.leads(stage);
create index if not exists idx_leads_manager     on public.leads(manager_id);
create index if not exists idx_leads_tenant      on public.leads(tenant_id);
create index if not exists idx_leads_created_at  on public.leads(created_at desc);

-- stage o'zgarganda updated_at/closed_at avtomatik yangilanadi
create or replace function public.touch_lead()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  if new.stage in ('deal_closed','lost') and old.stage is distinct from new.stage then
    new.closed_at := now();
  end if;
  return new;
end;
$$;
drop trigger if exists trg_leads_touch on public.leads;
create trigger trg_leads_touch before update on public.leads
  for each row execute function public.touch_lead();

-- =====================================================
-- 5) sales_funnel — bosqich bo'yicha jamlovchi VIEW (tez o'qish uchun)
-- =====================================================
create or replace view public.sales_funnel as
select
  l.tenant_id,
  l.stage,
  count(*)::int          as lead_count,
  coalesce(sum(l.value), 0)::numeric as total_value
from public.leads l
group by l.tenant_id, l.stage;

-- =====================================================
-- updated_at trigger for daily_targets
-- (set_updated_at schema.sql da bor; bu yerda ham yaratamiz — fayl mustaqil ishlasin)
-- =====================================================
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_daily_targets_updated_at on public.daily_targets;
create trigger trg_daily_targets_updated_at
  before update on public.daily_targets
  for each row execute function public.set_updated_at();

-- RLS: server secret kalit bilan ishlaydi — bu jadvallar uchun RLS shart emas.
alter table public.tenant_platforms    disable row level security;
alter table public.daily_targets       disable row level security;
alter table public.dashboards_metadata disable row level security;
alter table public.leads               disable row level security;

notify pgrst, 'reload schema';
