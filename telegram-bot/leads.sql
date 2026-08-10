-- Supabase SQL Editor'da bir marta ishga tushiring.
-- Nom ataylab `bot_leads` (`leads` emas) — asosiy backend'da xuddi shu nom bilan,
-- lekin butunlay boshqa sxemadagi jadval allaqachon mavjud, to'qnashmasin.

create table if not exists bot_leads (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint not null,
  telegram_username text,
  full_name text not null,
  phone text not null,
  company_name text not null,
  tariff text not null,
  employee_count int not null,
  duration_months int not null,
  price_per_employee numeric not null,
  monthly_total numeric not null,
  period_total numeric not null,
  created_at timestamptz not null default now()
);

-- Ixtiyoriy: analitika uchun yengil interaction jurnali
create table if not exists bot_events (
  id bigserial primary key,
  telegram_user_id bigint not null,
  event_type text not null,   -- masalan: 'start', 'view_pricing', 'faq_question', 'lead_completed'
  payload jsonb,
  created_at timestamptz not null default now()
);
