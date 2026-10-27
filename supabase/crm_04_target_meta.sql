-- ============================================================================
-- TARGET TAHLIL — Meta Ads (Facebook/Instagram) — 2026-10-27.
--
-- NEGA: foydalanuvchi talabi — "target analiz qo'sh". Reklama xarajati Meta
-- Marketing API'dan (src/lib/metaAds.ts, worker har soatda), lidlar/sotuvlar
-- amoCRM'dan (crm_leads.utm_content = kreativ nomi, masalan "reels2"),
-- lid sifati — AI qo'ng'iroq tahlilidan (telefon raqami bo'yicha).
--
-- Qayta ishga tushirsa xato bermaydi. Hech narsa o'chirilmaydi.
-- ============================================================================

-- company_integrations: yangi provayder 'meta' (token SHIFRLANGAN, config.token_enc).
alter table public.company_integrations drop constraint if exists company_integrations_provider_check;
alter table public.company_integrations add constraint company_integrations_provider_check
  check (provider in ('amocrm', 'webhook', 'meta'));

-- Kunlik reklama ko'rsatkichlari (kreativ = ad darajasida).
create table if not exists public.meta_ad_insights (
  company_id     uuid not null references public.companies(id) on delete cascade,
  day            date not null,
  ad_id          text not null,
  ad_name        text,
  adset_id       text,
  adset_name     text,
  campaign_id    text,
  campaign_name  text,
  spend          numeric not null default 0,
  impressions    bigint not null default 0,
  clicks         bigint not null default 0,
  reach          bigint not null default 0,
  leads          integer not null default 0,   -- Meta "lead" harakatlari (forma)
  messages       integer not null default 0,   -- yozishuv boshlangan (Direct/Messenger)
  currency       text,
  synced_at      timestamptz not null default now(),
  primary key (company_id, day, ad_id)
);
create index if not exists meta_ad_insights_company_day_idx on public.meta_ad_insights (company_id, day desc);
alter table public.meta_ad_insights enable row level security;

-- Kreativ ma'lumoti (rasm, holat).
create table if not exists public.meta_ads (
  company_id     uuid not null references public.companies(id) on delete cascade,
  ad_id          text not null,
  name           text,
  status         text,
  campaign_id    text,
  adset_id       text,
  thumbnail_url  text,
  updated_at     timestamptz not null default now(),
  primary key (company_id, ad_id)
);
alter table public.meta_ads enable row level security;

-- amoCRM lidining UTM'lari (kampaniya bo'yicha bog'lash uchun).
alter table public.crm_leads add column if not exists utm_campaign text;
alter table public.crm_leads add column if not exists utm_medium   text;

notify pgrst, 'reload schema';

-- Tekshiruv: ikkala jadval ham chiqishi kerak.
select to_regclass('public.meta_ad_insights') as insights, to_regclass('public.meta_ads') as ads;
