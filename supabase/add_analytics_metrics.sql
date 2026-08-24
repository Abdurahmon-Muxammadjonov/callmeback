-- ============================================================
-- Prosell · "Analitika" sahifasi — yangi sub-metrikalar + norma sozlamalari
-- Supabase Dashboard → SQL Editor → Run. Idempotent.
-- ============================================================

-- calls.incoming_count / outgoing_count / unanswered_count / bad_leads_count
-- allaqachon mavjud (supabase/schema.sql) — bu yerda faqat Gemini audit
-- endi qo'shimcha hisoblab beradigan 3 ta yangi metrika qo'shiladi.
alter table public.calls add column if not exists new_leads_count      integer not null default 0 check (new_leads_count >= 0);
alter table public.calls add column if not exists sent_to_dealer_count integer not null default 0 check (sent_to_dealer_count >= 0);
alter table public.calls add column if not exists closed_deals_count  integer not null default 0 check (closed_deals_count >= 0);

-- ============================================================
-- company_settings — har kompaniya o'zining KPI norma chegaralarini
-- sozlashi uchun ("Analitika" sahifasidagi ogohlantirish banneri va
-- xodim kartalaridagi "NORMA OSTIDA" belgisi shu qiymatlarga tayanadi).
-- Yozuv yo'q bo'lsa backend standart qiymatlar bilan javob beradi —
-- shu sabab hech qanday seed/insert qadami shart emas.
-- ============================================================
create table if not exists public.company_settings (
  company_id                 uuid primary key references public.companies(id) on delete cascade,
  qualified_call_seconds     integer not null default 60  check (qualified_call_seconds > 0),
  min_qualified_calls_day    integer not null default 40  check (min_qualified_calls_day >= 0),
  min_qualified_calls_week   integer not null default 160 check (min_qualified_calls_week >= 0),
  min_qualified_calls_month  integer not null default 640 check (min_qualified_calls_month >= 0),
  min_efficiency_score       integer not null default 50  check (min_efficiency_score between 0 and 100),
  updated_at                 timestamptz not null default now()
);

-- (set_updated_at supabase/add_analytics.sql'da ham yaratiladi — bu fayl
-- mustaqil ishga tushirilsa ham xato bermasin deb shu yerda ham beriladi.)
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_company_settings_updated_at on public.company_settings;
create trigger trg_company_settings_updated_at
  before update on public.company_settings
  for each row execute function public.set_updated_at();

-- RLS: server secret kalit bilan ishlaydi — bu jadval uchun RLS shart emas
-- (xuddi company_sections/tariff_requests kabi boshqa company_id-based jadvallar kabi).
alter table public.company_settings disable row level security;

notify pgrst, 'reload schema';
