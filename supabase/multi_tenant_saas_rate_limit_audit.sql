-- ============================================================================
-- SalesPulse — invite_code xavfsizligi: rate limiting + audit log
-- ============================================================================
-- OLDIN supabase/multi_tenant_saas.sql ishga tushirilgan bo'lishi shart —
-- bu fayl o'sha jadvallarga (companies, users) tayanadi.
-- ============================================================================

-- ============================================================================
-- 1) invite_code — allaqachon avtomatik generatsiya qilinadi
-- ============================================================================
-- Bu qism qo'shimcha ish talab qilmaydi: multi_tenant_saas.sql'da
-- `public.generate_invite_code()` (9 belgi, 0/O/1/I chiqarib tashlangan,
-- collision'da qayta urinadigan loop) va
-- `companies.invite_code default generate_invite_code()` allaqachon bor.
-- Yangi kompaniya yaratilganda invite_code avtomatik to'ldiriladi.

-- ============================================================================
-- 3) Rate limiting — /auth/register uchun (Supabase/Postgres'ning o'zida,
--    Redis kabi qo'shimcha infra kerak emas — loyihada hozircha Redis
--    ishlatilmaydi, shu sabab yangi tashqi bog'liqlik qo'shmaslik uchun
--    Postgres tanlandi)
-- ============================================================================
-- Ikkita jadval: har bir MUVAFFAQIYATSIZ urinish log qilinadi (1), va faol
-- bloklar alohida saqlanadi (2) — shunda "bloklanganmi?" tekshiruvi har safar
-- log jadvalini sanash o'rniga PRIMARY KEY bo'yicha bitta tez qidiruv bilan
-- bajariladi.
create table public.invite_code_failed_attempts (
  id         bigserial primary key,
  ip_address inet not null,
  created_at timestamptz not null default now()
);
create index idx_invite_failed_ip_time on public.invite_code_failed_attempts(ip_address, created_at);

create table public.ip_blocks (
  ip_address    inet primary key,
  blocked_until timestamptz not null,
  reason        text
);

-- Muvaffaqiyatsiz urinishni yozadi va 1 daqiqada 5+ bo'lsa 15 daqiqaga
-- bloklaydi. PLPGSQL funksiya ichida bajarilishi MUHIM: insert+count+block
-- bitta atomik operatsiya bo'lishi kerak, aks holda ikkita parallel so'rov
-- ikkalasi ham "hali 4 ta" deb ko'rib, chegaradan oshib ketishi mumkin edi.
create or replace function public.record_invite_failure_and_maybe_block(p_ip inet)
returns boolean -- true = shu urinishdan keyin bloklandi
language plpgsql
as $$
declare
  v_recent_count int;
begin
  insert into public.invite_code_failed_attempts (ip_address) values (p_ip);

  select count(*) into v_recent_count
  from public.invite_code_failed_attempts
  where ip_address = p_ip and created_at > now() - interval '1 minute';

  -- Eski (bloklanmagan) urinish yozuvlarini yig'ishtirib turamiz — jadval
  -- cheksiz o'sib ketmasligi uchun (rate-limit oynasi 1 daqiqa, shu sabab
  -- 15 daqiqadan eskisi endi hech qanday hisobga kerak emas).
  delete from public.invite_code_failed_attempts where created_at < now() - interval '15 minutes';

  if v_recent_count >= 5 then
    insert into public.ip_blocks (ip_address, blocked_until, reason)
    values (p_ip, now() + interval '15 minutes', '1 daqiqada 5+ muvaffaqiyatsiz invite_code urinishi')
    on conflict (ip_address) do update
      set blocked_until = excluded.blocked_until, reason = excluded.reason;
    return true;
  end if;

  return false;
end;
$$;

create or replace function public.is_ip_blocked(p_ip inet)
returns boolean
language sql
stable
as $$
  select exists (
    select 1 from public.ip_blocks
    where ip_address = p_ip and blocked_until > now()
  )
$$;

-- Rate-limit funksiyalari anon/authenticated'ga ham EXECUTE qilinadi, chunki
-- /auth/register HALI login qilmagan foydalanuvchi tomonidan chaqiriladi —
-- lekin backend bu funksiyalarni service_role klient orqali chaqiradi
-- (src/multi-tenant/lib/rateLimit.ts), shu sabab qo'shimcha xavf yo'q; baribir
-- ehtiyot uchun faqat shu ikki funksiyaga ruxsat beramiz, jadvallarning o'ziga
-- to'g'ridan-to'g'ri kirish yopiq qoladi (pastda RLS).
alter table public.invite_code_failed_attempts enable row level security;
alter table public.ip_blocks enable row level security;
-- Policy ATAYLAB berilmagan — hech kim (service_role'dan boshqa) bu ikki
-- jadvalga to'g'ridan-to'g'ri kira olmaydi, faqat yuqoridagi SECURITY
-- DEFINER bo'lmagan (lekin service_role orqali chaqiriladigan) funksiyalar
-- orqali.

-- ============================================================================
-- 4) audit_logs — muhim harakatlar tarixi
-- ============================================================================
-- user_id NULLABLE: ba'zi harakatlar (masalan /auth/register'da invite_code
-- NOTO'G'RI bo'lganda) hali public.users'da yozuvi yo'q anonim so'rovchi
-- tomonidan qilinadi — bu holatda user_id yo'q, faqat ip_address bor.
-- (Diqqat: bu loyihada invite_code muvaffaqiyatsizliklari audit_logs'ga
-- EMAS, maxsus invite_code_failed_attempts'ga yoziladi — lekin user_id
-- nullable bo'lishi baribir to'g'ri, chunki kelajakda boshqa anonim
-- harakatlar ham shu jadvalga tushishi mumkin, masalan "muvaffaqiyatsiz
-- login urinishi".)
create table public.audit_logs (
  id         uuid primary key default gen_random_uuid(),
  company_id uuid not null references public.companies(id) on delete cascade,
  user_id    uuid references public.users(id) on delete set null,
  action     text not null,          -- masalan: 'register', 'invite_code_regenerated',
                                      -- 'crm_credentials_updated', 'role_changed'
  ip_address inet,
  metadata   jsonb not null default '{}'::jsonb,  -- harakatga oid qo'shimcha kontekst
  created_at timestamptz not null default now()
);
create index idx_audit_logs_company_created on public.audit_logs(company_id, created_at desc);

alter table public.audit_logs enable row level security;

-- Faqat owner/admin audit tarixini ko'radi (agent/manager emas — bu yerda
-- rol o'zgarishi, CRM kalitlari kabi nozik harakatlar qayd etiladi).
create policy audit_logs_select_admin on public.audit_logs
  for select using (
    company_id = auth.user_company_id()
    and exists (
      select 1 from public.users
      where id = auth.uid() and role in ('owner', 'admin')
    )
  );
-- INSERT policy ATAYLAB berilmagan: audit yozuvlarini FAQAT backend
-- (service_role, RLS'ni chetlab o'tadi) yozadi. Oddiy foydalanuvchi hatto
-- o'z harakatini ham qo'lda audit_logs'ga yoza olmasligi kerak — aks holda
-- audit tarixi ishonchli bo'lmay qoladi (soxta yozuv qo'shish mumkin
-- bo'lardi). Xuddi shu sabab UPDATE/DELETE policy ham yo'q — audit
-- yozuvlari o'zgartirilmaydi/o'chirilmaydi (append-only).
