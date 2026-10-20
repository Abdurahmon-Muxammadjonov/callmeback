-- ============================================================================
-- amoCRM'dan PUL MA'LUMOTLARI (2026-10-20).
--
-- NEGA: foydalanuvchi talabi — "CRM'ni ulab, ichidagi pul ma'lumotlarini
-- olish" (audio UTel'dan keladi, CRM'dan — to'lovlar). Har kompaniyaning
-- amoCRM'idan bitimlar o'qiladi (src/lib/crmDeals.ts, worker har 10 daqiqa):
--   price      — amoCRM «Бюджет» = TO'LANGAN summa
--   deal_sum   — «Kelishuv Summasi» = shartnoma summasi
--   debt       — «Qarzdorlik» (= Kelishuv − to'langan)
--   pay_kind   — bosqich turi: partial (bron/predoplata/30%/50%/bo'lib),
--                pending (to'liq to'lov — chek hali tekshirilmagan),
--                full (chek tekshirildi va undan keyin), lost, none
--   stage_at   — joriy bosqichga o'tgan vaqt (amoCRM hodisalaridan)
--   operator_ext — mijoz raqami bo'yicha UTel qo'ng'iroqlaridan topilgan operator
-- Faqat pulga aloqador bitimlar saqlanadi (to'lov bosqichi yoki summa bor).
--
-- Qayta ishga tushirsa xato bermaydi.
-- ============================================================================

create table if not exists public.crm_leads (
  company_id        uuid not null references public.companies(id) on delete cascade,
  provider          text not null default 'amocrm',
  lead_id           bigint not null,
  name              text,
  pipeline_id       bigint,
  pipeline_name     text,
  status_id         bigint,
  status_name       text,
  pay_kind          text not null default 'none' check (pay_kind in ('none', 'partial', 'pending', 'full', 'lost')),
  price             numeric not null default 0,
  deal_sum          numeric not null default 0,
  debt              numeric not null default 0,
  payment_type      text,
  responsible_id    bigint,
  responsible_name  text,
  contact_id        bigint,
  client_phone9     text,
  operator_ext      text,
  call_id           uuid,
  stage_at          timestamptz,
  first_paid_at     timestamptz,
  crm_created_at    timestamptz,
  crm_updated_at    timestamptz,
  synced_at         timestamptz not null default now(),
  primary key (company_id, provider, lead_id)
);

create index if not exists crm_leads_company_stage_idx on public.crm_leads (company_id, pay_kind, stage_at desc);
create index if not exists crm_leads_company_debt_idx on public.crm_leads (company_id) where debt > 0;

-- Faqat backend (service_role).
alter table public.crm_leads enable row level security;

-- Sinxron holati (integratsiya qatorida).
alter table public.company_integrations add column if not exists pull_cursor        bigint;
alter table public.company_integrations add column if not exists pull_events_cursor bigint;
alter table public.company_integrations add column if not exists pull_at            timestamptz;
alter table public.company_integrations add column if not exists pull_error         text;

notify pgrst, 'reload schema';

-- Tekshiruv: 1 qator chiqishi kerak.
select to_regclass('public.crm_leads') as jadval;
