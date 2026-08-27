-- ============================================================
-- Part D to'liq qayta qurilishi: to'lov + chek + proratsiya + muddatli kod.
-- Bu fayl supabase/tariff_unlock_bots.sql'ni ALMASHTIRMAYDI — o'sha fayldagi
-- `tariffs`/`bot_deeplink_tokens`/`telegram_bot_sessions` jadvallari qoladi
-- va ishlatilishda davom etadi. FAQAT eskirgan `tariff_requests`ga asoslangan
-- bot-oqimi (src/telegram/tariffFlow.ts, src/lib/tariffRequests.ts) shu
-- fayldagi yangi jadvallarga o'tkaziladi — `tariff_requests` jadvalining
-- o'zi bazada QOLADI (tarixiy ma'lumot, o'chirilmaydi), lekin kod endi unga
-- yozmaydi.
--
-- `company_sections` / `section_unlock_codes` / POST /company/sections/unlock
-- / POST /admin/section-codes — BULAR HAM O'ZGARMAYDI (SalesPulse admin
-- qo'lda, botsiz bitta bo'lim uchun kod berishi kerak bo'lgan holatlar
-- uchun alohida, mustaqil yo'l bo'lib qoladi). Yangi POST /company/tariff/
-- unlock esa QO'SHIMCHA yo'l — bot orqali to'langan, butun tarifni bir
-- yo'la ochadigan kod uchun.
--
-- REVIZIYA 2 — birinchi versiya multi-agent adversarial review'dan o'tkazildi
-- (9 ta tasdiqlangan xato topildi, hammasi shu revizoyada tuzatildi):
--   1. Tasdiqlash (approve) ikki marta bosilsa/qayta yuborilsa idempotent
--      emas edi (ikkita kod, ikkita subscriptions qatori). Endi
--      approve_key_request()/approve_tariff_change_request() BUTUN amalni
--      (status flip + companies.tariff_id + subscriptions + kod) bitta
--      `for update` bilan qulflangan tranzaksiyada bajaradi — xuddi
--      redeem_unlock_code() kabi.
--   2. subscriptions insert xatosi jim yutib yuborilardi (keyin "Tarifni
--      o'zgartirish" abadiy ishlamay qolardi). Endi bitta tranzaksiya
--      ichida — xato bo'lsa HAMMASI orqaga qaytadi, admin xato ko'radi.
--   3. redeem_unlock_code() kompaniya tekshiruvisiz ISHLAGAN — Company A
--      Company B'ning kodini ishlata olardi. Endi p_company_id majburiy va
--      solishtiriladi.
--   4. Pastroq tarifga o'tishda eski (yuqori tarif) bo'limlar abadiy ochiq
--      qolardi. Endi redeem_unlock_code() avval yangi tarifga kirmaydigan
--      bo'limlarni qulflaydi, keyin yangilarini ochadi.
--   5. included_sections'da LOCKABLE_SECTIONS'dan tashqari (masalan yozuv
--      xatosi) qiymat sukut bo'yicha jim qabul qilinardi. Endi noma'lum
--      section_key uchun xato beriladi.
--   6. Telefon raqami ANIQ MOS KELISHI kerak edi (+998901234567 va
--      998 90 123 45 67 boshqa-boshqa hisoblanardi) — subscriptions.phone
--      endi normalize_phone() bilan saqlanadi/qidiriladi (oxirgi 9 raqam,
--      src/routes/crm.ts'dagi normalizePhone() bilan bir xil qoida).
--   7. key_requests uchun paid_amount tasdiqlash PAYTIDAGI (jonli)
--      tariffs.price'dan olinardi, so'rov YARATILGAN paytdagi narxdan emas
--      — narx orada o'zgarsa, mijoz to'lamagan summasi qayd etilardi. Endi
--      key_requests.quoted_price so'rov yaratilganda saqlanadi va shundan
--      foydalaniladi (tariff_change_requests.final_price allaqachon shunday
--      ishlagan edi).
--   8. Proratsiyasiz (finalPrice=0, past tarifga o'tishda) holatda ham chek
--      surati talab qilinardi. (Bu tuzatish Node tomonida — tariffFlow.ts.)
--   9. Bot 2'ga yuborilgan caption'da parse_mode:'Markdown' bilan foydalanuvchi
--      matni (ism/username) escape qilinmagan edi — pastki chiziqli username
--      butun xabarni yuborilmay qulatardi. (Bu tuzatish ham Node tomonida.)
--
-- Supabase Dashboard -> SQL Editor -> Run. Idempotent.
-- ============================================================

-- ------------------------------------------------------------
-- 0) tariffs.price — flat narx (D.1). Mavjud `codes_per_unlock` ustuni
-- endi yangi oqimda ishlatilmaydi (har doim bitta, butun-tarif kodi
-- beriladi), lekin eski POST /admin/section-codes yo'li bilan
-- bog'liqligi yo'q, shu sabab o'chirilmaydi (zararsiz meros ustun).
--
-- DIQQAT — NARXLAR PLACEHOLDER: consolidated prompt D.3'da faqat 3 ta
-- misol narx berilgan ("400 000 / 799 000 / 1 099 000 so'm"), lekin bu
-- bazada 4 ta tarif bor (start/standart/pro/max_plus). Quyidagi qiymatlar
-- shu 3 ta misolni standart/pro/max_plus'ga bog'lab, start uchun oqilona
-- boshlang'ich narx qo'shib qo'yilgan — HAQIQIY narxlar emas, ishga
-- tushirishdan oldin marketing/direktor bilan tasdiqlab, UPDATE bilan
-- almashtiring:
--   update public.tariffs set price = <haqiqiy narx> where key = '<key>';
-- ------------------------------------------------------------
alter table public.tariffs add column if not exists price numeric not null default 0;

update public.tariffs set price = 250000  where key = 'start'    and price = 0;
update public.tariffs set price = 400000  where key = 'standart' and price = 0;
update public.tariffs set price = 799000  where key = 'pro'      and price = 0;
update public.tariffs set price = 1099000 where key = 'max_plus' and price = 0;

-- Audit topilgan bo'shliq: `managers`/`criteria_categories`/`criteria`
-- LOCKABLE_SECTIONS'ga qo'shilgan (src/lib/companySections.ts), lekin
-- hech qaysi tarifning included_sections'ida yo'q edi — demak bironta
-- kompaniya ularni sotib olish orqali HECH QACHON ocholmasdi. Yuqori ikki
-- tarifga (pro/max_plus — boshqaruv funksiyalari) qo'shib qo'yamiz.
update public.tariffs
   set included_sections = array['call_analytics','reports','campaigns','managers','criteria_categories','criteria']
 where key in ('pro', 'max_plus');

-- ------------------------------------------------------------
-- 1) key_requests — "Kalit olish" (birinchi xarid), D.2
-- ------------------------------------------------------------
-- DIQQAT — spec'ning D.2/D.3'idan ikkita ustun qo'shildi:
--  - `phone`: D.4 "look up latest subscriptions row by phone" deb talab
--    qiladi, lekin D.3 umuman telefon so'ramaydi — shu holda birinchi
--    xarid bilan keyingi "Tarifni o'zgartirish" so'rovini telefon orqali
--    bog'lashning iloji yo'q edi. Shu sabab tariffFlow.ts'dagi "Kalit
--    olish" oqimida ham (ism so'ralgandan keyin) telefon so'raladi.
--  - `quoted_price`: so'rov YARATILGANDA (mijoz chekni yuborayotganda
--    ko'rgan) tarif narxi shu yerda "muzlatiladi" — tasdiqlash operatsiyasi
--    (pastdagi approve_key_request()) buni ishlatadi, tasdiqlash PAYTIDAGI
--    (o'zgargan bo'lishi mumkin) jonli tariffs.price'ni emas (Reviziya 2,
--    band 7).
create table if not exists public.key_requests (
  id                uuid primary key default gen_random_uuid(),
  company_id        uuid not null references public.companies(id) on delete cascade,
  tariff_id         uuid not null references public.tariffs(id),
  full_name         text not null,
  phone             text not null,
  telegram_id       text not null,
  receipt_file_id   text not null,
  quoted_price      numeric not null default 0,
  paid_amount       numeric not null default 0,  -- admin tasdiqlaganda quoted_price'ga tenglashadi
  status            text not null default 'pending' check (status in ('pending','approved','rejected')),
  rejection_reason  text,
  resolved_by       text,
  created_at        timestamptz not null default now(),
  resolved_at       timestamptz
);
create index if not exists idx_key_requests_company on public.key_requests(company_id);
create index if not exists idx_key_requests_status  on public.key_requests(status);

-- ------------------------------------------------------------
-- 2) tariff_change_requests — "Tarifni o'zgartirish" (proratsiya), D.2
-- ------------------------------------------------------------
-- DIQQAT — yana ikkita zarur ustun:
--  - `telegram_id`: D.2'da yo'q, lekin D.5 "Bot 1 -> user: ..." deb,
--    tasdiqlash/rad etishda QAYSI Telegram foydalanuvchisiga xabar yozish
--    kerakligini bilishni talab qiladi.
--  - `receipt_file_id` NULLABLE qilindi (spec'da NOT NULL): proratsiya
--    natijasida final_price=0 bo'lishi mumkin (masalan past tarifga
--    o'tishda, oldin to'langan summa yangi narxni to'liq qoplasa) — bunda
--    to'lov umuman bo'lmaydi, demak chek ham bo'lmaydi (Reviziya 2, band 8).
create table if not exists public.tariff_change_requests (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references public.companies(id) on delete cascade,
  full_name          text not null,
  phone              text not null,
  telegram_id        text not null,
  old_tariff_id      uuid references public.tariffs(id),
  new_tariff_id      uuid not null references public.tariffs(id),
  discount_applied   numeric not null default 0,
  final_price        numeric not null,
  receipt_file_id    text,
  status             text not null default 'pending' check (status in ('pending','approved','rejected')),
  rejection_reason   text,
  resolved_by        text,
  created_at         timestamptz not null default now(),
  resolved_at        timestamptz
);
create index if not exists idx_tariff_change_requests_company on public.tariff_change_requests(company_id);
create index if not exists idx_tariff_change_requests_status  on public.tariff_change_requests(status);

-- ------------------------------------------------------------
-- 3) subscriptions — har bir muvaffaqiyatli to'lov tarixi, D.2.
--
-- DIQQAT — spec'dagi bo'shliq to'ldirildi: D.5 faqat tariff_change_requests
-- tasdiqlanganda subscriptions qatori yaratilishini aytadi, lekin D.4'ning
-- o'zi "look up latest subscriptions row by phone" deb, "topilmasa avval
-- Kalit olish orqali ro'yxatdan o'ting" deb talab qiladi — agar
-- key_requests tasdiqlanganda ham subscriptions yaratilmasa, ENG BIRINCHI
-- marta "Kalit olish" orqali xarid qilgan kompaniya "Tarifni o'zgartirish"ni
-- HECH QACHON ishlata olmaydi (o'ziga xos qulflanib qolish). Shu sabab
-- key_requests tasdiqlanganda HAM subscriptions qatori yaratiladi (pastga,
-- approve_key_request()ga qarang) — tizim ichki izchil bo'lishi uchun
-- zarur qaror.
-- ------------------------------------------------------------
create table if not exists public.subscriptions (
  id           uuid primary key default gen_random_uuid(),
  company_id   uuid not null references public.companies(id) on delete cascade,
  full_name    text not null,
  phone        text not null,  -- normalize_phone() bilan saqlanadi (Reviziya 2, band 6)
  tariff_id    uuid not null references public.tariffs(id),
  paid_amount  numeric not null,
  paid_at      timestamptz not null default now(),
  expires_at   timestamptz not null
);
create index if not exists idx_subscriptions_company on public.subscriptions(company_id, paid_at desc);
create index if not exists idx_subscriptions_phone    on public.subscriptions(phone, paid_at desc);

-- ------------------------------------------------------------
-- 4) unlock_codes — bitta kod, BUTUN tarifni bir yo'la ochadi, D.2.
-- Kod OCHIQ MATNDA saqlanadi (section_unlock_codes'dagi bcrypt hash'dan
-- farqli) — spec shunday belgilagan (`code text not null unique`), va
-- 13 belgi + 30 daqiqa muddat + bir martalik ishlatish yetarli himoya
-- beradi (taxminlash amaliy emas, muddati tez tugaydi).
-- ------------------------------------------------------------
create table if not exists public.unlock_codes (
  id                 uuid primary key default gen_random_uuid(),
  company_id         uuid not null references public.companies(id) on delete cascade,
  tariff_id          uuid not null references public.tariffs(id),
  code               text not null unique,
  source_request_id  uuid,
  expires_at         timestamptz not null,
  used               boolean not null default false,
  used_at            timestamptz,
  created_at         timestamptz not null default now()
);
create index if not exists idx_unlock_codes_company on public.unlock_codes(company_id);

-- ------------------------------------------------------------
-- 5) normalize_phone — telefon raqamlarni solishtirish uchun kanonik
-- shaklga keltiradi (raqam bo'lmagan belgilarni olib tashlaydi, oxirgi 9
-- ta raqamni oladi) — src/routes/crm.ts'dagi normalizePhone() bilan bir
-- xil qoida, shu bazada bir marta yozilgan (Reviziya 2, band 6).
-- ------------------------------------------------------------
create or replace function public.normalize_phone(p_phone text)
returns text
language sql
immutable
as $$
  select case
    when length(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g')) <= 9
      then regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g')
    else right(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g'), 9)
  end;
$$;

-- ------------------------------------------------------------
-- 6) issue_unlock_code — 13 belgili (A-Z + 2-9, 0/O/1/I yo'q) kod
-- generatsiya qiladi va unlock_codes'ga yozadi; to'qnashsa (juda kam
-- ehtimollik — 29^13 kombinatsiya) bir necha marta qayta uriniladi.
-- Faqat approve_key_request()/approve_tariff_change_request() ichidan
-- chaqiriladi — ular allaqachon tranzaksiya ichida bo'ladi.
-- ------------------------------------------------------------
create or replace function public.issue_unlock_code(
  p_company_id uuid,
  p_tariff_id uuid,
  p_source_request_id uuid,
  p_expires_at timestamptz
)
returns text
language plpgsql
as $$
declare
  v_code    text;
  v_attempt int := 0;
  v_chars   text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
begin
  loop
    v_attempt := v_attempt + 1;
    select string_agg(substr(v_chars, (floor(random() * length(v_chars)))::int + 1, 1), '')
      into v_code
      from generate_series(1, 13);
    begin
      insert into public.unlock_codes (company_id, tariff_id, code, source_request_id, expires_at)
      values (p_company_id, p_tariff_id, v_code, p_source_request_id, p_expires_at);
      return v_code;
    exception when unique_violation then
      if v_attempt >= 5 then
        raise exception 'UNLOCK_CODE_GENERATION_FAILED';
      end if;
      -- davom etamiz, keyingi urinishda yangi tasodifiy kod sinaladi
    end;
  end loop;
end;
$$;

-- ------------------------------------------------------------
-- 7) approve_key_request — D.5 "Kalit olish" tasdiqlash, BUTUNLAY
-- ATOMIK: so'rov qatori `for update` bilan qulflanadi, shu sabab ikki
-- marta bosilsa/qayta yuborilsa ikkinchi chaqiruv REQUEST_ALREADY_RESOLVED
-- bilan xato beradi (Reviziya 2, band 1) va subscriptions/kod yaratish
-- xatosi BUTUN amalni orqaga qaytaradi (Reviziya 2, band 2).
-- ------------------------------------------------------------
create or replace function public.approve_key_request(p_request_id uuid, p_admin_telegram_id text)
returns jsonb
language plpgsql
as $$
declare
  v_req     public.key_requests%rowtype;
  v_tariff  public.tariffs%rowtype;
  v_code    text;
  v_paid_at timestamptz := now();
begin
  select * into v_req from public.key_requests where id = p_request_id for update;
  if not found then
    raise exception 'REQUEST_NOT_FOUND';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'REQUEST_ALREADY_RESOLVED';
  end if;

  select * into v_tariff from public.tariffs where id = v_req.tariff_id;
  if not found then
    raise exception 'TARIFF_MISSING';
  end if;

  update public.key_requests
     set status = 'approved',
         paid_amount = v_req.quoted_price,
         resolved_by = p_admin_telegram_id,
         resolved_at = now()
   where id = p_request_id;

  update public.companies set tariff_id = v_tariff.id where id = v_req.company_id;

  insert into public.subscriptions (company_id, full_name, phone, tariff_id, paid_amount, paid_at, expires_at)
  values (v_req.company_id, v_req.full_name, public.normalize_phone(v_req.phone), v_tariff.id, v_req.quoted_price, v_paid_at, v_paid_at + interval '30 days');

  v_code := public.issue_unlock_code(v_req.company_id, v_tariff.id, p_request_id, now() + interval '30 minutes');

  return jsonb_build_object('company_id', v_req.company_id, 'telegram_id', v_req.telegram_id, 'tariff_name', v_tariff.name, 'code', v_code);
end;
$$;

create or replace function public.reject_key_request(p_request_id uuid, p_admin_telegram_id text, p_reason text)
returns jsonb
language plpgsql
as $$
declare
  v_req public.key_requests%rowtype;
begin
  select * into v_req from public.key_requests where id = p_request_id for update;
  if not found then
    raise exception 'REQUEST_NOT_FOUND';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'REQUEST_ALREADY_RESOLVED';
  end if;

  update public.key_requests
     set status = 'rejected', rejection_reason = p_reason, resolved_by = p_admin_telegram_id, resolved_at = now()
   where id = p_request_id;

  return jsonb_build_object('company_id', v_req.company_id, 'telegram_id', v_req.telegram_id);
end;
$$;

-- ------------------------------------------------------------
-- 8) approve_tariff_change_request / reject_tariff_change_request —
-- D.5 "Tarifni o'zgartirish" tasdiqlash/rad etish, xuddi yuqoridagi
-- kabi ATOMIK.
-- ------------------------------------------------------------
create or replace function public.approve_tariff_change_request(p_request_id uuid, p_admin_telegram_id text)
returns jsonb
language plpgsql
as $$
declare
  v_req     public.tariff_change_requests%rowtype;
  v_tariff  public.tariffs%rowtype;
  v_code    text;
  v_paid_at timestamptz := now();
begin
  select * into v_req from public.tariff_change_requests where id = p_request_id for update;
  if not found then
    raise exception 'REQUEST_NOT_FOUND';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'REQUEST_ALREADY_RESOLVED';
  end if;

  select * into v_tariff from public.tariffs where id = v_req.new_tariff_id;
  if not found then
    raise exception 'TARIFF_MISSING';
  end if;

  update public.tariff_change_requests
     set status = 'approved', resolved_by = p_admin_telegram_id, resolved_at = now()
   where id = p_request_id;

  update public.companies set tariff_id = v_tariff.id where id = v_req.company_id;

  insert into public.subscriptions (company_id, full_name, phone, tariff_id, paid_amount, paid_at, expires_at)
  values (v_req.company_id, v_req.full_name, public.normalize_phone(v_req.phone), v_tariff.id, v_req.final_price, v_paid_at, v_paid_at + interval '30 days');

  v_code := public.issue_unlock_code(v_req.company_id, v_tariff.id, p_request_id, now() + interval '30 minutes');

  return jsonb_build_object('company_id', v_req.company_id, 'telegram_id', v_req.telegram_id, 'tariff_name', v_tariff.name, 'code', v_code);
end;
$$;

create or replace function public.reject_tariff_change_request(p_request_id uuid, p_admin_telegram_id text, p_reason text)
returns jsonb
language plpgsql
as $$
declare
  v_req public.tariff_change_requests%rowtype;
begin
  select * into v_req from public.tariff_change_requests where id = p_request_id for update;
  if not found then
    raise exception 'REQUEST_NOT_FOUND';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'REQUEST_ALREADY_RESOLVED';
  end if;

  update public.tariff_change_requests
     set status = 'rejected', rejection_reason = p_reason, resolved_by = p_admin_telegram_id, resolved_at = now()
   where id = p_request_id;

  return jsonb_build_object('company_id', v_req.company_id, 'telegram_id', v_req.telegram_id);
end;
$$;

-- ------------------------------------------------------------
-- 9) redeem_unlock_code — D.6ning "hammasi bitta tranzaksiyada" talabi.
-- Reviziya 2 tuzatishlari:
--   - p_company_id MAJBURIY va kod egasi bilan solishtiriladi (band 3 —
--     tenant-isolation buzilishi edi).
--   - Yangi tarifga kirmaydigan, lekin ilgari ochilgan bo'limlar avval
--     qulflanadi (band 4 — past tarifga o'tishda eski huquqlar abadiy
--     saqlanib qolardi).
--   - included_sections'dagi har bir qiymat LOCKABLE_SECTIONS to'plamida
--     ekanligi tekshiriladi (band 5 — noma'lum kalit jim yutib yuborilardi).
-- ------------------------------------------------------------
create or replace function public.redeem_unlock_code(p_code text, p_company_id uuid, p_user_id uuid default null)
returns jsonb
language plpgsql
as $$
declare
  v_row    public.unlock_codes%rowtype;
  v_tariff public.tariffs%rowtype;
  v_section text;
  v_known_sections text[] := array['call_analytics','reports','campaigns','managers','criteria_categories','criteria'];
begin
  select * into v_row from public.unlock_codes where code = p_code for update;

  if not found then
    raise exception 'UNLOCK_CODE_NOT_FOUND';
  end if;

  if v_row.used then
    raise exception 'UNLOCK_CODE_USED';
  end if;

  if now() > v_row.expires_at then
    raise exception 'UNLOCK_CODE_EXPIRED';
  end if;

  if p_company_id is null or v_row.company_id <> p_company_id then
    raise exception 'UNLOCK_CODE_WRONG_COMPANY';
  end if;

  select * into v_tariff from public.tariffs where id = v_row.tariff_id;
  if not found then
    raise exception 'UNLOCK_CODE_TARIFF_MISSING';
  end if;

  foreach v_section in array v_tariff.included_sections loop
    if not (v_section = any(v_known_sections)) then
      raise exception 'UNKNOWN_SECTION_KEY: %', v_section;
    end if;
  end loop;

  update public.unlock_codes set used = true, used_at = now() where id = v_row.id;

  update public.companies set tariff_id = v_row.tariff_id where id = v_row.company_id;

  -- Avval: yangi tarifga kirmaydigan, lekin ilgari ochilgan bo'limlarni
  -- qulflaymiz — pastroq tarifga o'tishda eski (yuqori tarif) huquqlar
  -- abadiy saqlanib qolmasin.
  update public.company_sections
     set is_locked = true
   where company_id = v_row.company_id
     and is_locked = false
     and not (section_key = any(v_tariff.included_sections));

  -- Keyin: yangi tarifga kiruvchi bo'limlarni ochamiz.
  foreach v_section in array v_tariff.included_sections loop
    insert into public.company_sections (company_id, section_key, is_locked, unlocked_at, unlocked_by)
    values (v_row.company_id, v_section, false, now(), p_user_id)
    on conflict (company_id, section_key)
    do update set is_locked = false, unlocked_at = now(),
                  unlocked_by = coalesce(excluded.unlocked_by, public.company_sections.unlocked_by);
  end loop;

  return jsonb_build_object(
    'company_id', v_row.company_id,
    'tariff_id', v_row.tariff_id,
    'tariff_key', v_tariff.key,
    'unlocked_sections', to_jsonb(v_tariff.included_sections)
  );
end;
$$;

-- RLS: qolgan jadvallar kabi — server service_role klient bilan ishlaydi.
alter table public.key_requests           disable row level security;
alter table public.tariff_change_requests disable row level security;
alter table public.subscriptions          disable row level security;
alter table public.unlock_codes           disable row level security;

notify pgrst, 'reload schema';
