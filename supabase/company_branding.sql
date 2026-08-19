-- ============================================================
-- Kompaniya profili, statistika va logotip (company_id asosida)
-- Supabase Dashboard -> SQL Editor -> Run. Idempotent.
-- ============================================================

-- 1) companies: /company/me javobida kerak bo'lgan ustunlar
alter table public.companies add column if not exists logo_url text;
alter table public.companies add column if not exists plan text not null default 'starter';

-- 2) calls/managers: company_id (NULLABLE) — /dashboard/stats shu bo'yicha
--    filtrlaydi. NULLABLE ataylab: hozirgi PBX pipeline (webhook orqali
--    keladigan qo'ng'iroqlar) hali company_id yozmaydi — bu ALOHIDA,
--    kattaroq ish (qaysi PBX ulanishi qaysi kompaniyaga tegishli ekanini
--    aniqlash kerak). Hozircha eski yozuvlar company_id=NULL bilan
--    "legacy/tenant'siz" qoladi, yangi kompaniyalar esa tabiiy ravishda 0
--    statistika bilan boshlanadi (talab qilingandek).
alter table public.calls    add column if not exists company_id uuid references public.companies(id) on delete set null;
alter table public.managers add column if not exists company_id uuid references public.companies(id) on delete set null;
create index if not exists idx_calls_company_id    on public.calls(company_id);
create index if not exists idx_managers_company_id on public.managers(company_id);

-- 3) campaigns — /dashboard/stats'da total_campaigns uchun kerak, lekin
--    loyihada hali campaigns jadvali yo'q (bu KIA/PBX loyihasida "kampaniya"
--    tushunchasi umuman ishlatilmagan — bor-yo'g'i managers+calls bor).
--    Hozircha statistikada total_campaigns doim 0 qaytadi (jadval yo'qligi
--    uchun emas, chunki campaigns tushunchasi hali loyihaga kiritilmagan).
--    Kelajakda campaigns jadvali qo'shilsa, shu ustunni ham qo'shish kifoya:
-- create table if not exists public.campaigns (
--   id uuid primary key default gen_random_uuid(),
--   company_id uuid not null references public.companies(id) on delete cascade,
--   name text not null,
--   created_at timestamptz not null default now()
-- );

-- 4) Storage bucket — logotiplar
insert into storage.buckets (id, name, public)
values ('company-logos', 'company-logos', true)
on conflict (id) do nothing;

-- DIQQAT: quyidagi storage.objects RLS policy'lari BU LOYIHADA ISHLAMAYDI
-- va ATAYLAB QO'SHILMAGAN — auth.uid()/auth.user_company_id() Supabase
-- Auth (auth.users) sessiyasiga tayanadi, lekin bu ilova o'z foydalanuvchi
-- tizimini (public.users + bcrypt) ishlatadi, Supabase Auth orqali umuman
-- login qilinmaydi — shu sabab auth.uid() bu yerda doim NULL bo'lardi va
-- policy hech qachon true bermasdi (yuklash 403 bilan qulab tushardi).
--
-- Buning o'rniga: backend (POST/DELETE /company/logo, src/routes/company.ts)
-- service_role klient bilan fayl yuklaydi/o'chiradi — bu RLS'ni chetlab
-- o'tadi, avtorizatsiya esa backend'ning O'Z JWT middleware'ida (requireRole)
-- tekshiriladi. Bucket public=true — o'qish (logo ko'rsatish) hammaga ochiq,
-- lekin yozish FAQAT backend orqali, faqat owner/admin uchun.
