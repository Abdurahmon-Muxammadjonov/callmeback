-- ============================================================
-- Bo'lim qulflash tizimi + har-kompaniya mustaqil webhook
-- Supabase Dashboard -> SQL Editor -> Run. Idempotent.
-- ============================================================

-- ------------------------------------------------------------
-- 1) company_sections — qaysi bo'lim ochilgan/qulflangan
-- ------------------------------------------------------------
-- dashboard va webhook_integration bu jadvalda UMUMAN saqlanmaydi (spec
-- shart qilgan ikkita variantdan soddarog'ini tanladik) — backend kodida
-- ALWAYS_UNLOCKED_SECTIONS ro'yxati orqali har doim ochiq deb hisoblanadi.
create table if not exists public.company_sections (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete cascade,
  section_key  text not null,
  is_locked    boolean not null default true,
  unlocked_at  timestamptz,
  unlocked_by  uuid references public.users(id) on delete set null,
  created_at   timestamptz not null default now(),
  unique (company_id, section_key)
);
create index if not exists idx_company_sections_company on public.company_sections(company_id);

-- DIQQAT: yangi kompaniya yaratilganda bu yerga qatorlar OLDINDAN
-- yozilmaydi (spec'dagi "seed" qadami ataylab qilinmagan) — chunki
-- is_locked default'i TRUE, "qator yo'q" holati kod darajasida ham
-- "qulflangan" deb talqin qilinadi (src/routes/company-sections.ts'dagi
-- GET /company/sections shuni sintez qiladi). Bu register-company'ni
-- soddaligicha qoldiradi (yangi bosqich = yangi muvaffaqiyatsizlik nuqtasi
-- qo'shmaydi) va bir xil natijani beradi.

-- ------------------------------------------------------------
-- 2) section_unlock_codes — SalesPulse admin tomonidan berilgan, bir martalik
-- ------------------------------------------------------------
-- `code` ustuni HASH saqlaydi (bcrypt), hech qachon ochiq matn emas —
-- src/lib/sectionUnlockCode.ts'dagi hashUnlockCode()/verifyUnlockCode().
create table if not exists public.section_unlock_codes (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete cascade,
  section_key  text not null,
  code         text not null,           -- bcrypt hash, ochiq matn emas
  used         boolean not null default false,
  used_at      timestamptz,
  created_by   text,                    -- SalesPulse admin identifikatori (email/nom) — users.id emas, chunki admin bu kompaniyaning xodimi emas
  created_at   timestamptz not null default now()
);
create index if not exists idx_unlock_codes_lookup on public.section_unlock_codes(company_id, section_key, used);

-- ------------------------------------------------------------
-- 3) webhooks — har kompaniya uchun MUSTAQIL webhook ulanishi
-- ------------------------------------------------------------
-- DIQQAT — muhim me'moriy qaror: bu jadval va POST /webhooks/incoming/:slug
-- (yangi, mustaqil endpoint) FAQAT yangi ko'p-tenantli kompaniyalar uchun.
-- Hozir jonli ishlab turgan /crm/webhook/pbx (OnlinePBX -> KIA, haqiqiy
-- production trafigi bilan) BUTUNLAY DAXLSIZ qoldirildi — uni shu ishga
-- moslab qayta qurish real qo'ng'iroqlarni uzib qo'yish xavfini
-- tug'dirardi. `crm_integrations` (eski, global PBX sozlamasi) shu sabab
-- o'zgartirilmadi.
--
-- secret_token OCHIQ SAQLANMAYDI — Supabase Vault emas (bu loyihada
-- ishlatilmagan/tekshirilmagan), balki server tomonda AES-256-GCM bilan
-- shifrlanadi (src/lib/webhookSecret.ts, kalit — env AISHA... kabi emas,
-- WEBHOOK_SECRET_ENC_KEY). Sabab: Vault RPC'lari bu Supabase loyihasida
-- mavjudligi tasdiqlanmagan, ilova darajasidagi shifrlash esa har doim
-- ishlaydi va tekshirilishi oson.
create table if not exists public.webhooks (
  id                      uuid primary key default gen_random_uuid(),
  company_id              uuid not null references public.companies(id) on delete cascade,
  crm_type                text not null,
  endpoint_slug           text not null unique,   -- POST /webhooks/incoming/{slug}
  secret_token_encrypted  text not null,
  status                  text not null default 'connected' check (status in ('connected', 'disconnected')),
  created_at              timestamptz not null default now()
);
create index if not exists idx_webhooks_company on public.webhooks(company_id);

-- ------------------------------------------------------------
-- 4) calls.company_id + AI-gating uchun status qiymati
-- ------------------------------------------------------------
-- calls.company_id allaqachon supabase/company_branding.sql'da qo'shilgan
-- (nullable). Bu yerda faqat "pending_unlock" statusi izohlanadi — alohida
-- ustun/CHECK constraint kerak emas, `calls.status` allaqachon erkin text.
-- pending_unlock: audio/qo'ng'iroq SAQLANGAN, lekin bo'lim qulf bo'lgani
-- uchun AI tahlili ATAYLAB ishga tushirilmagan (src/routes/analyze-call.ts,
-- processOneBatchCall). Bo'lim ochilganda backfill avtomatik shu
-- statusdagilarni qayta navbatga qo'yadi (src/routes/company-sections.ts).
