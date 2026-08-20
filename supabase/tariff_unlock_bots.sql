-- ============================================================
-- Telegram bot orqali tarif ochish (to'lov tasdiqlash + kod yuborish)
-- Supabase Dashboard -> SQL Editor -> Run. Idempotent.
-- ============================================================

-- ------------------------------------------------------------
-- 1.1 tariffs
-- ------------------------------------------------------------
create table if not exists public.tariffs (
  id                uuid primary key default gen_random_uuid(),
  key               text unique not null,
  name              text not null,
  included_sections text[] not null,
  codes_per_unlock  int not null,
  "order"           int not null default 0  -- yuqoriroq tarif = kattaroq son (upgrade uchun "hozirgidan kattaroqlarini" filtrlash)
);

alter table public.companies add column if not exists tariff_id uuid references public.tariffs(id);

-- Boshlang'ich 4 ta tarif — mavjud marketing tariflari (telegram-bot/pricing.js)
-- bilan nom jihatidan mos, lekin bu jadval STRUKTURA jihatidan boshqa narsa:
-- bu yerda "qaysi bo'limlar ochiladi" va "nechta kod beriladi" belgilanadi,
-- narx bilan bog'liq emas (narx hisob-kitobi hamon pricing.js'da).
--
-- codes_per_unlock QASDAN included_sections uzunligiga TENG qilib qo'yilgan
-- (misolda "start uchun 4, pro uchun 5" deyilgan edi, lekin hozir tizimda
-- FAQAT 3 ta qulflanadigan bo'lim bor — call_analytics/reports/campaigns —
-- shu sabab "bitta kod = bitta bo'lim" qoidasiga (2.2-band) mos, real
-- ishlaydigan son tanlandi. Backend "hali ochilmagan bo'lim uchun kod"
-- mantig'ida ishlaydi (src/telegram/tariffFlow.ts), shu sabab kelajakda
-- yangi bo'lim qo'shilsa, bu yerga ham qo'shish kifoya).
insert into public.tariffs (key, name, included_sections, codes_per_unlock, "order")
values
  ('start',    'START',    array['call_analytics'],                          1, 1),
  ('standart', 'STANDART', array['call_analytics','reports'],                2, 2),
  ('pro',      'PRO',      array['call_analytics','reports','campaigns'],    3, 3),
  ('max_plus', 'MAX+',     array['call_analytics','reports','campaigns'],    3, 4)
on conflict (key) do nothing;

-- ------------------------------------------------------------
-- 1.2 tariff_requests
-- ------------------------------------------------------------
create table if not exists public.tariff_requests (
  id                       uuid primary key default gen_random_uuid(),
  company_id               uuid not null references public.companies(id) on delete cascade,
  requested_tariff_id      uuid not null references public.tariffs(id),
  requested_by_telegram_id text not null,
  requested_by_phone       text,
  type                     text not null check (type in ('initial_purchase', 'upgrade')),
  status                   text not null default 'pending' check (status in ('pending','approved','rejected')),
  rejection_reason         text,
  resolved_by              text,
  created_at               timestamptz default now(),
  resolved_at              timestamptz
);
create index if not exists idx_tariff_requests_company on public.tariff_requests(company_id);
create index if not exists idx_tariff_requests_status  on public.tariff_requests(status);

-- ------------------------------------------------------------
-- 1.3 bot_deeplink_tokens
-- ------------------------------------------------------------
create table if not exists public.bot_deeplink_tokens (
  token       text primary key,
  company_id  uuid not null references public.companies(id) on delete cascade,
  purpose     text not null check (purpose in ('get_code', 'upgrade')),
  expires_at  timestamptz not null,
  used        boolean not null default false,
  created_at  timestamptz not null default now()
);
create index if not exists idx_deeplink_tokens_company on public.bot_deeplink_tokens(company_id);

-- Har-kompaniya so'rov chastotasi (Part 6: soatiga 5 tadan ortiq bo'lmasin).
create index if not exists idx_deeplink_tokens_company_created on public.bot_deeplink_tokens(company_id, created_at);

-- ------------------------------------------------------------
-- Bot FSM holati — DB'da (Express instance qayta ishga tushsa/ko'p nusxada
-- ishlasa ham holat yo'qolmasligi uchun; xotiradagi Map emas).
-- ------------------------------------------------------------
-- PK (telegram_id, bot) — birlashtirilgan, chunki bitta odam (masalan admin)
-- Bot 1'ga ham "mijoz" sifatida, Bot 2'ga ham admin sifatida yozishi mumkin;
-- ikkalasi bir-birining holatini bosib qolmasin.
create table if not exists public.telegram_bot_sessions (
  telegram_id  text not null,
  bot          int not null check (bot in (1, 2)),
  current_step text,
  context      jsonb not null default '{}'::jsonb,
  updated_at   timestamptz not null default now(),
  primary key (telegram_id, bot)
);

-- ------------------------------------------------------------
-- Bot 2'dan admin harakatlarini audit_logs'ga yozish uchun — audit_logs
-- allaqachon mavjud (supabase/multi_tenant_saas_rate_limit_audit.sql),
-- lekin bu yerda user_id har doim NULL bo'ladi (admin bu kompaniyaning
-- xodimi emas, Telegram ID logda ip_address o'rniga metadata'da saqlanadi).
-- Qo'shimcha ustun kerak emas — mavjud audit_logs.metadata jsonb yetarli.
