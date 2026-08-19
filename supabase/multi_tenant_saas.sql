-- ============================================================================
-- SalesPulse — Multi-tenant SaaS migration
-- ============================================================================
-- Maqsad: har bir kompaniya (avtosalon/dilercentr) alohida tenant bo'lib,
-- boshqa kompaniyalar ma'lumotidan RLS orqali to'liq izolyatsiya qilinishi.
--
-- Supabase Dashboard → SQL Editor'da bir marta ishga tushiring. Idempotent
-- emas (jadval nomlari mavjud loyihadagi eski single-tenant schema bilan
-- to'qnashishi mumkin) — yangi/alohida loyihada yoki eski jadvallarni
-- ko'chirib bo'lgandan keyin qo'llang.
-- ============================================================================

create extension if not exists pgcrypto;   -- gen_random_uuid() uchun
create extension if not exists supabase_vault; -- crm_credentials'ni shifrlash uchun

-- ============================================================================
-- 1) companies — har bir tenant (dilercentr)
-- ============================================================================
-- crm_credentials MAXSUS: talabga ko'ra plain-text taqiqlangan. Oddiy jsonb
-- ustun har doim ham "shifrlangan" bo'la olmaydi — bazaga to'g'ridan-to'g'ri
-- kirgan odam (yoki backup) uni ochiq o'qiy oladi. Shu sabab haqiqiy Supabase
-- Vault ishlatiladi: kalitlar (client_id/client_secret/token) JSON→text
-- ko'rinishida `vault.create_secret()` orqali shifrlab saqlanadi, bu yerda esa
-- FAQAT o'sha maxfiy yozuvga ishora qiluvchi uuid saqlanadi. Ochiq matn hech
-- qachon `companies` jadvaliga tushmaydi. O'qish/yozish uchun pastdagi
-- `public.set_crm_credentials()` / `public.get_crm_credentials()` funksiyalarini
-- ishlating (ikkalasi ham SECURITY DEFINER — faqat service_role chaqira oladi).
create table public.companies (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  invite_code        text unique,                 -- pastda avtomatik to'ldiriladi (bo'lim D)
  crm_type           text,                         -- 'bitrix24' | 'amocrm' | boshqa | null
  crm_credentials_id uuid references vault.secrets(id) on delete set null,
  plan               text not null default 'starter'
                       check (plan in ('starter', 'pro', 'enterprise')),
  status             text not null default 'active'
                       check (status in ('active', 'suspended')),
  created_at         timestamptz not null default now()
);

comment on column public.companies.crm_credentials_id is
  'vault.secrets(id) ga ishora — haqiqiy CRM kalitlari shu yerda emas, Vault''da shifrlangan holda saqlanadi.';

-- ============================================================================
-- 2) users — auth.users bilan 1:1, profil + tenant biriktiruvi
-- ============================================================================
create table public.users (
  id         uuid primary key references auth.users(id) on delete cascade,
  company_id uuid not null references public.companies(id) on delete cascade,
  role       text not null default 'agent'
               check (role in ('owner', 'admin', 'manager', 'agent')),
  full_name  text,
  created_at timestamptz not null default now()
);

-- ============================================================================
-- 3) campaigns — har bir tenant o'zining sotuv skript(lar)i
-- ============================================================================
create table public.campaigns (
  id            uuid primary key default gen_random_uuid(),
  company_id    uuid not null references public.companies(id) on delete cascade,
  name          text not null,
  script_stages jsonb not null default '[]'::jsonb,  -- 7 bosqichli skript strukturasi
  created_at    timestamptz not null default now()
);

-- ============================================================================
-- 4) calls — AI audit qilingan qo'ng'iroqlar
-- ============================================================================
-- campaign_id ON DELETE SET NULL (pastda E bo'limida izohlangan) — shu sabab
-- bu yerda NOT NULL qilinmagan, aks holda SET NULL ishlay olmas edi.
-- agent_id: asl talabda yo'q edi, lekin backend'dagi "agent faqat o'z
-- qo'ng'irog'ini ko'radi" RBAC qoidasi buni talab qiladi — qaysi qo'ng'iroq
-- qaysi xodimga tegishli ekanini bilmasdan bu qoidani amalga oshirib
-- bo'lmaydi. SET NULL: xodim tizimdan o'chirilsa (masalan ishdan bo'shagan),
-- uning qo'ng'iroq TARIXI yo'qolmasligi kerak — xuddi campaign_id kabi.
create table public.calls (
  id          uuid primary key default gen_random_uuid(),
  company_id  uuid not null references public.companies(id) on delete cascade,
  campaign_id uuid references public.campaigns(id) on delete set null,
  agent_id    uuid references public.users(id) on delete set null,
  audio_url   text,
  transcript  text,
  score_json  jsonb,                                -- 7 bosqich bo'yicha baholash natijasi
  created_at  timestamptz not null default now()
);

-- ============================================================================
-- 5) api_keys — tashqi integratsiyalar (Telegram bot, CRM webhook)
-- ============================================================================
-- Kalitning o'zi HECH QACHON saqlanmaydi — faqat hash (masalan sha256).
-- Tekshirishda: kelgan kalitni hash qilib, key_hash bilan solishtiring.
create table public.api_keys (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  key_hash   text not null,
  scopes     text[] not null default '{}',           -- masalan: {calls:write, campaigns:read}
  created_at timestamptz not null default now()
);

-- Bir xil hash ikki marta yozilib qolmasin (amaliyotda deyarli imkonsiz, lekin
-- himoya sifatida) + tenant bo'yicha tez qidiruv uchun.
create unique index uq_api_keys_key_hash on public.api_keys(key_hash);

-- ============================================================================
-- Indekslar — RLS har bir so'rovga "company_id = ..." filtrini avtomatik
-- qo'shadi (pastga qarang), shu sabab bu ustunlarda indeks bo'lmasa RLS
-- ISHLAYDI lekin har bir so'rov to'liq jadval skanini qiladi. Ko'p-tenant
-- muhitda bu majburiy, ixtiyoriy emas.
-- ============================================================================
create index idx_users_company_id     on public.users(company_id);

-- Bir kompaniyada faqat bitta 'owner' bo'lishini DB darajasida kafolatlaydi
-- (backend/auth.ts'dagi POST /auth/register shu chegaraga tayanadi — ikki kishi
-- bir vaqtda ro'yxatdan o'tsa ham, faqat bittasi owner bo'la oladi).
create unique index uq_users_one_owner_per_company
  on public.users(company_id) where (role = 'owner');
create index idx_campaigns_company_id on public.campaigns(company_id);
create index idx_calls_company_id     on public.calls(company_id);
create index idx_calls_campaign_id    on public.calls(campaign_id);
create index idx_calls_agent_id       on public.calls(agent_id);
create index idx_api_keys_company_id  on public.api_keys(company_id);

-- ============================================================================
-- B) Helper: auth.user_company_id() — joriy foydalanuvchining tenant'i
-- ============================================================================
-- SECURITY DEFINER bo'lishi SHART: aks holda bu funksiya `public.users`'ni
-- CHAQIRUVCHI huquqi bilan o'qiydi, `public.users`'ning o'zida esa pastda
-- "company_id = auth.user_company_id()" policy'si bor — bu cheksiz
-- rekursiya/qulflanishga olib keladi ("qaysi tenant ekaningni bilish uchun
-- avval qaysi tenant ekaningni bilishing kerak" muammosi). SECURITY DEFINER
-- funksiyani jadval egasi (postgres) huquqi bilan ishlatadi va RLS'ni
-- chetlab o'tadi — faqat shu funksiya ichida, boshqa hech narsaga ta'sir
-- qilmaydi.
create or replace function auth.user_company_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select company_id from public.users where id = auth.uid()
$$;

grant execute on function auth.user_company_id() to authenticated;

-- ============================================================================
-- D) invite_code generatori — 9 belgili, unique, collision'da qayta uriladi
-- ============================================================================
-- Chalkash bo'ladigan belgilar (0/O, 1/I) chiqarib tashlangan — odam qo'lda
-- kiritganda xato qilmasligi uchun (invite_code hodimlarga og'zaki/SMS orqali
-- ham berilishi mumkin).
create or replace function public.generate_invite_code()
returns text
language plpgsql
as $$
declare
  alphabet   text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  new_code   text;
  attempt    int := 0;
  max_tries  int := 20;
begin
  loop
    attempt := attempt + 1;
    if attempt > max_tries then
      raise exception 'generate_invite_code(): % urinishdan keyin ham unique kod topilmadi', max_tries;
    end if;

    select string_agg(substr(alphabet, (floor(random() * length(alphabet)) + 1)::int, 1), '')
    into new_code
    from generate_series(1, 9);

    -- Collision tekshiruvi: agar shu kod allaqachon mavjud bo'lsa, loop davom etadi.
    exit when not exists (select 1 from public.companies where invite_code = new_code);
  end loop;

  return new_code;
end;
$$;

-- Bu DEFAULT sifatida ulanadi — company yaratilganda invite_code avtomatik
-- to'ldiriladi, insert paytida qo'lda berish shart emas. (Juda kam uchraydigan
-- concurrent-insert race'ni jadvaldagi UNIQUE constraint yakuniy himoya
-- sifatida ushlab qoladi — shunday holatda insert xato qaytaradi va ilova
-- qatlamida qayta urinish kifoya, chunki bu operatsiya juda kam sodir bo'ladi.)
alter table public.companies
  alter column invite_code set default public.generate_invite_code();

-- ============================================================================
-- CRM kalitlarini Vault orqali yozish/o'qish — faqat service_role (backend)
-- chaqirishi mumkin, hech qachon anon/authenticated'ga EXECUTE berilmaydi.
-- ============================================================================
create or replace function public.set_crm_credentials(p_company_id uuid, p_credentials jsonb)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old_secret_id uuid;
  v_new_secret_id uuid;
begin
  select crm_credentials_id into v_old_secret_id
  from public.companies where id = p_company_id;

  v_new_secret_id := vault.create_secret(
    p_credentials::text,
    'crm_credentials:' || p_company_id::text,
    'CRM integratsiya kalitlari — ' || p_company_id::text
  );

  update public.companies set crm_credentials_id = v_new_secret_id where id = p_company_id;

  if v_old_secret_id is not null then
    delete from vault.secrets where id = v_old_secret_id;
  end if;
end;
$$;
revoke all on function public.set_crm_credentials(uuid, jsonb) from public, anon, authenticated;

create or replace function public.get_crm_credentials(p_company_id uuid)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select ds.decrypted_secret::jsonb
  from public.companies c
  join vault.decrypted_secrets ds on ds.id = c.crm_credentials_id
  where c.id = p_company_id
$$;
revoke all on function public.get_crm_credentials(uuid) from public, anon, authenticated;

-- ============================================================================
-- A) RLS — barcha jadvallarda yoqiladi
-- ============================================================================
alter table public.companies enable row level security;
alter table public.users     enable row level security;
alter table public.campaigns enable row level security;
alter table public.calls     enable row level security;
alter table public.api_keys  enable row level security;

-- ----------------------------------------------------------------------------
-- C) Policy'lar — har biri "faqat o'z company_id'ing" tamoyili bilan.
-- USING  → mavjud qatorlarni ko'rish/o'zgartirish/o'chirishni cheklaydi.
-- WITH CHECK → yangi/yangilangan qatorning YANGI qiymati ham shu qoidaga mos
--   kelishini majburlaydi (aks holda boshqa tenant nomidan yozish mumkin bo'lardi).
-- ----------------------------------------------------------------------------

-- companies: foydalanuvchi faqat o'z kompaniyasini ko'radi/tahrirlaydi.
-- (Amalda "name"/"plan"/"status" kabi maydonlarni faqat owner/admin
-- o'zgartira olishi kerak — bu granular ruxsat keyingi qadam, hozircha
-- tenant-darajasidagi izolyatsiya ta'minlangan.)
create policy companies_select on public.companies
  for select using (id = auth.user_company_id());
create policy companies_update on public.companies
  for update using (id = auth.user_company_id())
             with check (id = auth.user_company_id());
-- INSERT/DELETE company — atayin policy berilmagan: yangi tenant yaratish va
-- tenant'ni butunlay o'chirish signup/offboarding oqimi orqali, service_role
-- (RLS'ni chetlab o'tadi) tomonidan boshqarilishi kerak, oddiy foydalanuvchi
-- o'zi yangi kompaniya yarata olmasligi yoki o'zining kompaniyasini
-- o'chira olmasligi kerak.

-- users: o'z jamoangdagilarni ko'rasan, faqat o'z profilingni tahrirlaysan.
create policy users_select on public.users
  for select using (company_id = auth.user_company_id());
create policy users_update_self on public.users
  for update using (id = auth.uid())
             with check (id = auth.uid() and company_id = auth.user_company_id());
-- INSERT: yangi xodim qo'shish odatda invite_code orqali signup vaqtida
-- SECURITY DEFINER trigger/service_role bilan bo'ladi (yangi userning
-- company_id'i hali auth.user_company_id() orqali aniqlanmagan bo'ladi —
-- RLS bilan "o'zini-o'zi" ro'yxatdan o'tkazish tabiiy ravishda mumkin emas).
-- DELETE ham xuddi shunday — admin xodimni o'chirish uchun alohida,
-- rol-tekshiruvchi policy/funksiya qo'shilishi kerak (hozircha scope'dan tashqarida).

-- campaigns: to'liq CRUD, faqat o'z kompaniyang doirasida.
create policy campaigns_all on public.campaigns
  for all using (company_id = auth.user_company_id())
          with check (company_id = auth.user_company_id());

-- calls: to'liq CRUD, faqat o'z kompaniyang doirasida.
create policy calls_all on public.calls
  for all using (company_id = auth.user_company_id())
          with check (company_id = auth.user_company_id());

-- api_keys: to'liq CRUD, faqat o'z kompaniyang doirasida.
-- (Amalda faqat owner/admin key yarata olishi kerak — granular rol-tekshiruvi
-- keyingi qadam sifatida `and exists (select 1 from public.users
-- where id = auth.uid() and role in ('owner','admin'))` qo'shib kengaytiring.)
create policy api_keys_all on public.api_keys
  for all using (company_id = auth.user_company_id())
          with check (company_id = auth.user_company_id());

-- ============================================================================
-- E) Foreign key ON DELETE strategiyasi — har biri alohida izohlangan
-- ============================================================================
-- users.id → auth.users(id)               : CASCADE
--   Sabab: bu jadval auth.users bilan 1:1 profil. Login hisobi o'chirilsa
--   (masalan foydalanuvchi hisobini butunlay o'chirish so'rovi — GDPR/shaxsiy
--   ma'lumotni o'chirish huquqi), yetim profil qatori qolmasligi kerak.
--
-- users.company_id → companies(id)        : CASCADE
-- campaigns.company_id → companies(id)    : CASCADE
-- calls.company_id → companies(id)        : CASCADE
-- api_keys.company_id → companies(id)     : CASCADE
--   Sabab: "company o'chirish" — tenant offboarding/hisobni butunlay
--   yopish/GDPR ma'lumot o'chirish so'rovi kabi KAM SODIR BO'LADIGAN, ATAYIN
--   qilinadigan operatsiya. Bunday holatda tenant'ga tegishli HAMMA narsa
--   (xodimlar profili, kampaniyalar, qo'ng'iroqlar, API kalitlar) birga
--   tozalanishi kerak — yarim o'chirilgan, "osilib qolgan" tenant ma'lumoti
--   qolishi xavfsizlik/yaxlitlik nuqtai nazaridan yomonroq (masalan
--   boshqa tenant shu id'ni qayta ololmaydi, eski api_keys yashirincha
--   ishlab qolishi mumkin). RESTRICT bu yerda company'ni hech qachon
--   o'chirib bo'lmasligiga olib keladi (chunki deyarli har doim kamida bitta
--   user/call bog'liq bo'ladi) — bu amaliy emas.
--
-- calls.campaign_id → campaigns(id)       : SET NULL (RESTRICT ham emas, CASCADE ham emas)
--   Sabab: campaign — sotuv skriptining bir versiyasi, vaqt o'tishi bilan
--   qayta tashkil qilinishi/o'chirilishi TABIIY holat (masalan eski skript
--   endi ishlatilmaydi). Lekin calls — qimmatli AUDIT TARIXI: allaqachon
--   tahlil qilingan, ballari hisoblangan qo'ng'iroq yozuvi campaign
--   o'chirilgani uchun yo'qolib ketmasligi kerak (analitika/hisobot uchun
--   ishlatiladi). CASCADE bu yerda noto'g'ri (tarixni yo'q qiladi), RESTRICT
--   ham noto'g'ri (campaign'ni hech qachon o'chirib bo'lmay qoladi, chunki
--   unga bog'liq calls doim bo'ladi). SET NULL — call qoladi, faqat
--   "qaysi campaign ostida bo'lgani" ma'lumoti yo'qoladi, shu sabab
--   calls.campaign_id NOT NULL emas (yuqorida ataylab shunday belgilangan).
-- ============================================================================
