-- ============================================================================
-- SOTUV DASHBOARDI (amoCRM) — 2026-10-20.
--
-- NEGA: foydalanuvchi talabi — bitta ekranda butun biznes: tushum, qarz,
-- voronkalar, manbalar, menejerlar, reklama, AI tahlil, zapusk rejasi.
-- crm_leads endi HAMMA bitimlarni saqlaydi (avval faqat to'lovlilar) —
-- lidlar soni, konversiya, manba, rad etish sababi shu jadvaldan
-- (src/lib/crmDeals.ts sinxron, src/lib/salesDashboard.ts hisob).
--
-- Qayta ishga tushirsa xato bermaydi. Hech narsa o'chirilmaydi.
-- ============================================================================

alter table public.crm_leads add column if not exists source              text;
alter table public.crm_leads add column if not exists utm_source          text;
alter table public.crm_leads add column if not exists utm_content         text;
alter table public.crm_leads add column if not exists loss_reason         text;
alter table public.crm_leads add column if not exists lost_from_status_id bigint;
alter table public.crm_leads add column if not exists group_id            bigint;
alter table public.crm_leads add column if not exists closed_at           timestamptz;
alter table public.crm_leads add column if not exists cf                  jsonb;

create index if not exists crm_leads_company_created_idx on public.crm_leads (company_id, crm_created_at desc);

-- Voronka/bosqich/foydalanuvchi/maydon ro'yxati (sinxron yozadi) va
-- dashboard sozlamalari (pul maydonlari, "potensial" bosqichlar, menejer ↔ operator).
alter table public.company_integrations add column if not exists pull_meta      jsonb;
alter table public.company_integrations add column if not exists sales_settings jsonb;

-- Hamma bitimni qaytadan o'qish uchun (avval faqat to'lovlilar saqlangan edi).
update public.company_integrations set pull_cursor = null, pull_events_cursor = null where provider = 'amocrm';

-- Reja: oylik (voronka yoki butun biznes) va zapusk (ixtiyoriy oraliq).
create table if not exists public.crm_plans (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete cascade,
  kind         text not null check (kind in ('monthly', 'launch')),
  pipeline_id  bigint,              -- null = butun biznes
  title        text,
  period_from  date not null,
  period_to    date not null,
  amount       numeric not null check (amount >= 0),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists crm_plans_company_idx on public.crm_plans (company_id, kind, period_to desc);
alter table public.crm_plans enable row level security;

notify pgrst, 'reload schema';

-- Tekshiruv: ikkala qiymat ham chiqishi kerak.
select to_regclass('public.crm_plans') as rejalar,
       (select count(*) from information_schema.columns where table_name = 'crm_leads' and column_name in ('source', 'cf', 'group_id')) as yangi_ustunlar;
