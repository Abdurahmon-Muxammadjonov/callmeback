-- ============================================================
-- amoCRM integratsiyasi: crm_id ustunlari + OAuth token saqlash.
-- Supabase Dashboard → SQL Editor ga yopishtirib RUN bosing. Idempotent.
-- ============================================================

-- 1) crm_id — CRM yozuvini lokal yozuvga bog'laydi (takror yaratilmasin).
--    Oddiy unique index: Postgres'da bir nechta NULL ruxsat etiladi, shu sabab
--    CRM'siz (qo'lda) menejer/qo'ng'iroqlar ham bemalol yashaydi.
alter table public.managers add column if not exists crm_id text;
create unique index if not exists uq_managers_crm_id on public.managers(crm_id);

alter table public.calls add column if not exists crm_id text;
create unique index if not exists uq_calls_crm_id on public.calls(crm_id);

-- 2) amoCRM OAuth hisobi (bitta qator, id='amocrm'). Service-role bilan ishlanadi.
create table if not exists public.crm_accounts (
  id            text primary key default 'amocrm',
  subdomain     text,           -- masalan: company.amocrm.ru
  client_id     text,
  client_secret text,
  redirect_uri  text,
  access_token  text,
  refresh_token text,
  expires_at    timestamptz,    -- access_token amal qilish muddati
  last_sync     timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Service-role kalit RLS'ni aylanib o'tadi; aniqlik uchun o'chiramiz.
alter table public.crm_accounts disable row level security;

-- PostgREST schema cache'ni yangilash.
notify pgrst, 'reload schema';
