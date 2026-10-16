-- ============================================================================
-- Telegram hisobot boti — ulangan chatlar. 2026-10-16.
--
-- NEGA: foydalanuvchi talabi — "Telegramdan hisobot qo'shish, bot qilish".
-- Direktor saytdagi "Telegramga ulash" tugmasini bosadi -> SalesPulse boti
-- (TELEGRAM_BOT1) bir martalik havola orqali shu chatni (shaxsiy yoki guruh)
-- kompaniyaga bog'laydi. Har kuni ish yakunida (standart 20:05, Toshkent)
-- kun hisoboti shu chatlarga yuboriladi; chatda /hisobot — darhol hisobot.
--
--  1) bot_deeplink_tokens.purpose ga 'report' qo'shiladi (havola turi);
--  2) telegram_report_chats — kompaniya <-> chat, oxirgi yuborilgan kun.
--
-- Qayta ishga tushirsa xato bermaydi.
-- ============================================================================

do $$ begin
  alter table public.bot_deeplink_tokens drop constraint if exists bot_deeplink_tokens_purpose_check;
  alter table public.bot_deeplink_tokens
    add constraint bot_deeplink_tokens_purpose_check check (purpose in ('get_code', 'upgrade', 'report'));
end $$;

create table if not exists public.telegram_report_chats (
  id             uuid primary key default gen_random_uuid(),
  company_id     uuid not null references public.companies(id) on delete cascade,
  chat_id        bigint not null,
  title          text,
  enabled        boolean not null default true,
  last_sent_day  date,
  created_at     timestamptz not null default now(),
  unique (company_id, chat_id)
);

create index if not exists telegram_report_chats_company_idx on public.telegram_report_chats(company_id);

-- Faqat backend (service_role) o'qiydi/yozadi.
alter table public.telegram_report_chats enable row level security;

notify pgrst, 'reload schema';

-- Tekshiruv: 2 qator chiqishi kerak.
select 'purpose check' as nima, pg_get_constraintdef(oid) as qiymat
from pg_constraint where conname = 'bot_deeplink_tokens_purpose_check'
union all
select 'jadval', to_regclass('public.telegram_report_chats')::text;
