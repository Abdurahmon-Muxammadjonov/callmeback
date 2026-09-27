-- ============================================================================
-- calls.key_moments / is_problem / problem_severity / problem_reason
-- 2026-09-27.
--
-- NEGA: har bir qo'ng'iroq uchun AI endi uch narsa qo'shimcha beradi:
--   1) qisqa xulosa (mavjud summary ustuniga yoziladi, yangi ustun kerak emas)
--   2) MUHIM JOYLAR — vaqt belgisi bilan: dashboardda "02:14 · narx aytildi"
--      ko'rinishida chiqadi, bosilganda audio o'sha joyga o'tadi
--   3) MUAMMOLI QO'NG'IROQ belgisi — rahbar darhol ko'rishi uchun
--      (qo'pol muomala, jahli chiqqan mijoz, qo'ldan ketgan issiq lid,
--       noto'g'ri narx/ma'lumot, kelishuvsiz yakunlangan va'da)
--
-- key_moments jsonb: [{"time": 134, "label": "narx aytildi", "kind": "good"}]
-- kind: good | bad | neutral
--
-- Xavfsiz: faqat ustun qo'shadi, mavjud ma'lumotga tegmaydi. Qayta ishga
-- tushirilsa xato bermaydi.
-- ============================================================================

alter table public.calls
  add column if not exists key_moments jsonb,
  add column if not exists is_problem boolean not null default false,
  add column if not exists problem_severity text,
  add column if not exists problem_reason text;

comment on column public.calls.key_moments is
  'AI topgan muhim joylar: [{time (sekund), label, kind: good|bad|neutral}]';
comment on column public.calls.is_problem is
  'AI qo''ng''iroqni rahbar ko''rishi kerak deb belgilagani (qo''pol muomala, norozi mijoz, qo''ldan ketgan lid va h.k.)';

-- "Muammoli qo'ng'iroqlar" ro'yxati tez ochilishi uchun.
create index if not exists idx_calls_company_problem
  on public.calls (company_id, created_at desc)
  where is_problem;
