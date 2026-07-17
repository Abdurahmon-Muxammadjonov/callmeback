-- ============================================================
-- Prosell · MASTER migration — HAMMASI bitta faylda (idempotent).
-- Supabase Dashboard → SQL Editor → New query → yopishtiring → RUN.
-- Necha marta ishlatsangiz ham xavfsiz; mavjud ma'lumot buzilmaydi.
-- ============================================================

create extension if not exists "pgcrypto";

-- ===== platforms (multi-platform, text id) =====
create table if not exists public.platforms (
  id text primary key, name text not null, tagline text, initials text,
  accent text not null default 'indigo' check (accent in ('indigo','cyan','emerald','violet')),
  created_at timestamptz not null default now()
);
insert into public.platforms (id,name,tagline,initials,accent)
values ('core','Procell Core','Asosiy call-center','PC','indigo') on conflict (id) do nothing;

-- ===== tenant_platforms (multi-tenancy) =====
create table if not exists public.tenant_platforms (
  id uuid primary key default gen_random_uuid(), name text not null, slug text unique not null,
  is_active boolean not null default true, created_at timestamptz not null default now()
);

-- ===== managers (operatorlar) =====
create table if not exists public.managers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  status text not null default 'active' check (status in ('active','inactive','on_leave','flagged')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.managers add column if not exists tenant_id         uuid references public.tenant_platforms(id) on delete set null;
alter table public.managers add column if not exists platform_id       text references public.platforms(id) on delete set null;
alter table public.managers add column if not exists role              text;
alter table public.managers add column if not exists daily_call_target integer not null default 20;
alter table public.managers add column if not exists last_seen_at      timestamptz;
update public.managers set platform_id='core' where platform_id is null;
create index if not exists idx_managers_status   on public.managers(status);
create index if not exists idx_managers_platform on public.managers(platform_id);
create index if not exists idx_managers_tenant   on public.managers(tenant_id);
alter table public.managers add column if not exists pbx_id text;
create unique index if not exists uq_managers_pbx_id on public.managers(pbx_id);

-- ===== calls =====
create table if not exists public.calls (
  id uuid primary key default gen_random_uuid(),
  manager_id uuid references public.managers(id) on delete cascade,
  audio_url text not null,
  total_calls integer not null default 0,
  incoming_count integer not null default 0,
  outgoing_count integer not null default 0,
  duration integer not null default 0,
  unanswered_count integer not null default 0,
  bad_leads_count integer not null default 0,
  created_at timestamptz not null default now()
);
alter table public.calls alter column manager_id drop not null;
alter table public.calls add column if not exists kpi_score           integer not null default 0;
alter table public.calls add column if not exists penalty_amount      numeric(12,2) not null default 0;
alter table public.calls add column if not exists bonus_amount        numeric(12,2) not null default 0;
alter table public.calls add column if not exists rop_comment         text not null default 'Izoh yoq';
alter table public.calls add column if not exists transcript          text;
alter table public.calls add column if not exists sentiment           text;
alter table public.calls add column if not exists risk                text;
alter table public.calls add column if not exists transcript_segments jsonb not null default '[]'::jsonb;
alter table public.calls add column if not exists summary             text;
alter table public.calls add column if not exists client_info         text;
alter table public.calls add column if not exists final_agreement     text;
alter table public.calls add column if not exists next_steps          jsonb not null default '[]'::jsonb;
alter table public.calls add column if not exists status              text not null default 'done';
alter table public.calls add column if not exists error               text;
alter table public.calls add column if not exists pbx_call_id         text;
alter table public.calls add column if not exists pbx_id              text;
alter table public.calls add column if not exists direction           text not null default 'unknown'
  check (direction in ('incoming','outgoing','unknown'));
alter table public.calls add column if not exists client_name         text;
alter table public.calls add column if not exists client_phone        text;
alter table public.calls add column if not exists audio_source_url    text;
alter table public.calls add column if not exists audio_storage_url   text;
alter table public.calls add column if not exists audio_storage_path  text;
alter table public.calls add column if not exists platform_id         text references public.platforms(id) on delete set null;
alter table public.calls add column if not exists bad_lead            boolean not null default false;
alter table public.calls add column if not exists dropped_reason      text;
update public.calls set platform_id='core' where platform_id is null;
create index if not exists idx_calls_manager_id on public.calls(manager_id);
create index if not exists idx_calls_created_at on public.calls(created_at desc);
create index if not exists idx_calls_status     on public.calls(status);
create index if not exists idx_calls_platform   on public.calls(platform_id);
create unique index if not exists uq_calls_pbx_id on public.calls(pbx_id);

-- ===== conversions / lost_reasons / call_criteria_scores =====
create table if not exists public.conversions (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references public.calls(id) on delete cascade,
  traffic_conversion numeric(5,2) not null default 0,
  sales_conversion numeric(5,2) not null default 0,
  stage_1_to_2 integer not null default 0,
  stage_2_to_3 integer not null default 0,
  stage_3_to_4 integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists idx_conversions_call_id on public.conversions(call_id);

create table if not exists public.lost_reasons (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references public.calls(id) on delete cascade,
  reason_text text not null, count integer not null default 1,
  status text not null default 'open', created_at timestamptz not null default now()
);
create index if not exists idx_lost_reasons_call_id on public.lost_reasons(call_id);

create table if not exists public.call_criteria_scores (
  id uuid primary key default gen_random_uuid(),
  call_id uuid not null references public.calls(id) on delete cascade,
  title text not null, category text,
  score integer not null default 0 check (score between 0 and 100),
  created_at timestamptz not null default now()
);
create index if not exists idx_ccs_call_id on public.call_criteria_scores(call_id);

-- ===== criteria (baholash mezonlari) =====
create table if not exists public.criteria (
  id uuid primary key default gen_random_uuid(),
  title text not null, description text not null,
  penalty_amount numeric(12,2) not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default timezone('utc'::text, now())
);
alter table public.criteria add column if not exists category text;
alter table public.criteria add column if not exists weight   integer not null default 0;
alter table public.criteria add column if not exists type     text not null default 'Majburiy';
create index if not exists idx_criteria_active   on public.criteria(is_active);
create index if not exists idx_criteria_category on public.criteria(category);

-- ===== users (login + staff) =====
create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  name text not null, email text unique not null,
  age integer, phone text, role text not null default 'user',
  password_hash text, created_at timestamptz not null default now()
);
alter table public.users add column if not exists first_name             text;
alter table public.users add column if not exists last_name              text;
alter table public.users add column if not exists shift_start            text;
alter table public.users add column if not exists shift_end              text;
alter table public.users add column if not exists credentials_changed_at timestamptz;
-- XAVFSIZLIK: ochiq parol saqlanmaydi — agar bo'lsa, butunlay o'chiramiz.
alter table public.users drop column if exists password_plain;

-- calls -> users bog'lanishi (mijoz o'chirilsa ham qo'ng'iroq tarixi saqlanadi)
alter table public.calls add column if not exists client_id uuid references public.users(id) on delete set null;

create table if not exists public.user_scripts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  title text not null, enabled boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists idx_user_scripts_user on public.user_scripts(user_id);

create table if not exists public.user_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  message text not null, read boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists idx_user_notif_user on public.user_notifications(user_id, read);

-- ===== crm_integrations (PBX simple settings) =====
create table if not exists public.crm_integrations (
  id               uuid primary key default gen_random_uuid(),
  webhook_url      text not null,
  api_key          text not null,
  enabled          boolean not null default true,
  last_test_status integer,
  last_test_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists idx_crm_integrations_updated_at
  on public.crm_integrations(updated_at desc);

create table if not exists public.shift_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  type text not null check (type in ('start','end')),
  at timestamptz not null default now(),
  event_date date not null default current_date,
  unique (user_id, type, event_date)
);
create index if not exists idx_shift_events_user on public.shift_events(user_id, at desc);

-- ===== analytics: daily_targets / dashboards_metadata / leads / sales_funnel =====
create table if not exists public.daily_targets (
  id uuid primary key default gen_random_uuid(),
  manager_id uuid not null references public.managers(id) on delete cascade,
  target_date date not null default current_date,
  daily_target integer not null default 0,
  notes text, created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (manager_id, target_date)
);
create index if not exists idx_daily_targets_manager_date on public.daily_targets(manager_id, target_date desc);

create table if not exists public.dashboards_metadata (
  id uuid primary key default gen_random_uuid(),
  scope text not null default 'core' check (scope in ('executive','rop','core')),
  metric_key text not null, metric_value jsonb not null default '{}'::jsonb,
  period text not null default 'all' check (period in ('day','week','month','all')),
  tenant_id uuid references public.tenant_platforms(id) on delete cascade,
  computed_at timestamptz not null default now(),
  unique (scope, metric_key, period, tenant_id)
);

create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  manager_id uuid references public.managers(id) on delete set null,
  tenant_id uuid references public.tenant_platforms(id) on delete set null,
  call_id uuid references public.calls(id) on delete set null,
  stage text not null default 'lead_generated'
    check (stage in ('lead_generated','contacted','qualified','proposal','negotiation','deal_closed','lost')),
  source text, value numeric(14,2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz
);
create index if not exists idx_leads_stage on public.leads(stage);
create index if not exists idx_leads_manager on public.leads(manager_id);

create or replace view public.sales_funnel as
select l.tenant_id, l.stage, count(*)::int as lead_count, coalesce(sum(l.value),0)::numeric as total_value
from public.leads l group by l.tenant_id, l.stage;

-- ===== updated_at trigger (managers, daily_targets) =====
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end; $$;
drop trigger if exists trg_managers_updated_at on public.managers;
create trigger trg_managers_updated_at before update on public.managers
  for each row execute function public.set_updated_at();
drop trigger if exists trg_daily_targets_updated_at on public.daily_targets;
create trigger trg_daily_targets_updated_at before update on public.daily_targets
  for each row execute function public.set_updated_at();

-- ===== Period-over-Period funksiyalari =====
create or replace function public.pop_pct(cur numeric, prev numeric)
returns numeric language sql immutable as $$
  select case when coalesce(prev,0)=0 then (case when coalesce(cur,0)>0 then 100 else 0 end)
              else round((cur-prev)/prev*100,1) end;
$$;

create or replace function public.calls_pop_stats(p_platform_id text default null)
returns jsonb language sql stable as $$
  with src as (
    select created_at, duration, kpi_score from public.calls
    where created_at >= date_trunc('month', now()) - interval '1 month'
      and (p_platform_id is null or platform_id = p_platform_id)
  ),
  agg as (
    select
      count(*) filter (where created_at >= date_trunc('day', now())) as d_cur_calls,
      count(*) filter (where created_at >= date_trunc('day', now()) - interval '1 day' and created_at < now() - interval '1 day') as d_prev_calls,
      coalesce(sum(duration) filter (where created_at >= date_trunc('day', now())),0) as d_cur_dur,
      coalesce(sum(duration) filter (where created_at >= date_trunc('day', now()) - interval '1 day' and created_at < now() - interval '1 day'),0) as d_prev_dur,
      avg(kpi_score) filter (where created_at >= date_trunc('day', now())) as d_cur_kpi,
      avg(kpi_score) filter (where created_at >= date_trunc('day', now()) - interval '1 day' and created_at < now() - interval '1 day') as d_prev_kpi,
      count(*) filter (where created_at >= date_trunc('week', now())) as w_cur_calls,
      count(*) filter (where created_at >= date_trunc('week', now()) - interval '1 week' and created_at < now() - interval '1 week') as w_prev_calls,
      coalesce(sum(duration) filter (where created_at >= date_trunc('week', now())),0) as w_cur_dur,
      coalesce(sum(duration) filter (where created_at >= date_trunc('week', now()) - interval '1 week' and created_at < now() - interval '1 week'),0) as w_prev_dur,
      avg(kpi_score) filter (where created_at >= date_trunc('week', now())) as w_cur_kpi,
      avg(kpi_score) filter (where created_at >= date_trunc('week', now()) - interval '1 week' and created_at < now() - interval '1 week') as w_prev_kpi,
      count(*) filter (where created_at >= date_trunc('month', now())) as m_cur_calls,
      count(*) filter (where created_at >= date_trunc('month', now()) - interval '1 month' and created_at < now() - interval '1 month') as m_prev_calls,
      coalesce(sum(duration) filter (where created_at >= date_trunc('month', now())),0) as m_cur_dur,
      coalesce(sum(duration) filter (where created_at >= date_trunc('month', now()) - interval '1 month' and created_at < now() - interval '1 month'),0) as m_prev_dur,
      avg(kpi_score) filter (where created_at >= date_trunc('month', now())) as m_cur_kpi,
      avg(kpi_score) filter (where created_at >= date_trunc('month', now()) - interval '1 month' and created_at < now() - interval '1 month') as m_prev_kpi
    from src
  )
  select jsonb_build_object(
    'daily', jsonb_build_object(
      'calls', jsonb_build_object('current',d_cur_calls,'previous',d_prev_calls,'change_pct',public.pop_pct(d_cur_calls,d_prev_calls)),
      'duration_minutes', jsonb_build_object('current',round(d_cur_dur/60.0,1),'previous',round(d_prev_dur/60.0,1),'change_pct',public.pop_pct(d_cur_dur,d_prev_dur)),
      'avg_kpi', jsonb_build_object('current',round(coalesce(d_cur_kpi,0),2),'previous',round(coalesce(d_prev_kpi,0),2),'change_pct',public.pop_pct(coalesce(d_cur_kpi,0),coalesce(d_prev_kpi,0)))),
    'weekly', jsonb_build_object(
      'calls', jsonb_build_object('current',w_cur_calls,'previous',w_prev_calls,'change_pct',public.pop_pct(w_cur_calls,w_prev_calls)),
      'duration_minutes', jsonb_build_object('current',round(w_cur_dur/60.0,1),'previous',round(w_prev_dur/60.0,1),'change_pct',public.pop_pct(w_cur_dur,w_prev_dur)),
      'avg_kpi', jsonb_build_object('current',round(coalesce(w_cur_kpi,0),2),'previous',round(coalesce(w_prev_kpi,0),2),'change_pct',public.pop_pct(coalesce(w_cur_kpi,0),coalesce(w_prev_kpi,0)))),
    'monthly', jsonb_build_object(
      'calls', jsonb_build_object('current',m_cur_calls,'previous',m_prev_calls,'change_pct',public.pop_pct(m_cur_calls,m_prev_calls)),
      'duration_minutes', jsonb_build_object('current',round(m_cur_dur/60.0,1),'previous',round(m_prev_dur/60.0,1),'change_pct',public.pop_pct(m_cur_dur,m_prev_dur)),
      'avg_kpi', jsonb_build_object('current',round(coalesce(m_cur_kpi,0),2),'previous',round(coalesce(m_prev_kpi,0),2),'change_pct',public.pop_pct(coalesce(m_cur_kpi,0),coalesce(m_prev_kpi,0)))),
    'generated_at', now()
  ) from agg;
$$;

-- ===== RLS: server secret kalit bilan ishlaydi — yangi jadvallarda RLS shart emas =====
alter table public.criteria             disable row level security;
alter table public.call_criteria_scores disable row level security;
alter table public.platforms            disable row level security;
alter table public.tenant_platforms     disable row level security;
alter table public.daily_targets        disable row level security;
alter table public.dashboards_metadata  disable row level security;
alter table public.leads                disable row level security;
alter table public.user_scripts         disable row level security;
alter table public.user_notifications   disable row level security;
alter table public.shift_events         disable row level security;

notify pgrst, 'reload schema';
