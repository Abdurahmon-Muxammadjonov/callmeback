-- ============================================================================
-- Kompaniya CRM integratsiyalari (amoCRM, webhook — 5CRM va boshqalar). 2026-10-16.
--
-- NEGA: foydalanuvchi talabi — "CRM'ni sistemaga ulash va obrabotkasini
-- avtomatik qilish". Hozirgi amoCRM ulanishi (crm_accounts, id='amocrm')
-- BUTUN TIZIM uchun bitta akkaunt edi — kompaniyalarga ajratilmagan. Bu
-- jadval har kompaniyaning o'z CRM'ini saqlaydi; har tahlil qilingan
-- qo'ng'iroq natijasi (ball, xulosa, lid sifati va sababi) o'sha CRM'ga
-- avtomatik yoziladi (src/lib/crmPush.ts):
--   amocrm  — mijoz raqami bo'yicha kontakt/bitim topilib, izoh qo'shiladi
--             (config: subdomain + uzoq muddatli token, token SHIFRLANGAN);
--   webhook — 5CRM yoki boshqa tizim: JSON POST, HMAC imzo bilan
--             (config: url + secret, secret SHIFRLANGAN).
--
-- Qayta ishga tushirsa xato bermaydi.
-- ============================================================================

create table if not exists public.company_integrations (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  provider      text not null check (provider in ('amocrm', 'webhook')),
  config        jsonb not null default '{}'::jsonb,
  enabled       boolean not null default true,
  last_push_at  timestamptz,
  last_error    text,
  pushed_count  integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (company_id, provider)
);

-- Faqat backend (service_role).
alter table public.company_integrations enable row level security;

notify pgrst, 'reload schema';

-- Tekshiruv: 1 qator chiqishi kerak.
select to_regclass('public.company_integrations') as jadval;
