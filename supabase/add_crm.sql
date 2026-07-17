-- ============================================================
-- amoCRM integratsiyasi: crm_id ustunlari + OAuth token saqlash.
-- Supabase Dashboard → SQL Editor ga yopishtirib RUN bosing. Idempotent.
-- ============================================================

-- 1) crm_id — CRM yozuvini lokal yozuvga bog'laydi (takror yaratilmasin).
--    Oddiy unique index: Postgres'da bir nechta NULL ruxsat etiladi, shu sabab
--    CRM'siz (qo'lda) menejer/qo'ng'iroqlar ham bemalol yashaydi.
alter table public.managers add column if not exists crm_id text;
create unique index if not exists uq_managers_crm_id on public.managers(crm_id);
alter table public.managers add column if not exists pbx_id text;
create unique index if not exists uq_managers_pbx_id on public.managers(pbx_id);

alter table public.calls add column if not exists crm_id text;
create unique index if not exists uq_calls_crm_id on public.calls(crm_id);
alter table public.calls add column if not exists pbx_call_id text;
alter table public.calls add column if not exists pbx_id text;
create unique index if not exists uq_calls_pbx_id on public.calls(pbx_id);
alter table public.calls add column if not exists direction text not null default 'unknown'
  check (direction in ('incoming','outgoing','unknown'));
alter table public.calls add column if not exists client_id uuid references public.users(id) on delete set null;
alter table public.calls add column if not exists client_name text;
alter table public.calls add column if not exists client_phone text;
alter table public.calls add column if not exists audio_source_url text;
alter table public.calls add column if not exists audio_storage_url text;
alter table public.calls add column if not exists audio_storage_path text;

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
  webhook_url   text,           -- PBX webhook manzili (simple ulanish uchun)
  api_key       text,           -- PBX webhook API key (simple ulanish uchun)
  last_sync     timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Eski bazalarda ham simple ulanish ustunlari bo'lishi uchun (idempotent).
alter table public.crm_accounts add column if not exists webhook_url text;
alter table public.crm_accounts add column if not exists api_key text;

-- 3) Simple PBX integratsiya sozlamalari (frontend CRM settings uchun)
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

-- Service-role kalit RLS'ni aylanib o'tadi; aniqlik uchun o'chiramiz.
alter table public.crm_accounts disable row level security;
alter table public.crm_integrations disable row level security;

-- PostgREST schema cache'ni yangilash.
notify pgrst, 'reload schema';
