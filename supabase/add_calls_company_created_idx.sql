-- ============================================================================
-- calls (company_id, created_at) indeksi — hisobot so'rovlari uchun. 2026-09-25.
--
-- NEGA: barcha hisobot endpointlari (daily-summary, hourly, analysis-status,
-- staff-stats, daily-minutes) bir xil naqsh bilan so'raydi:
--     where company_id = ? and created_at between ? and ?
-- Indekssiz bu har safar butun jadvalni skanerlaydi. Bugungi holatda
-- kuniga 1300+ qo'ng'iroq kelmoqda, ya'ni jadval tez o'smoqda.
--
-- created_at DESC — ro'yxatlar deyarli har doim yangisidan eskisiga
-- tartiblanadi (/api/calls ham shunday).
--
-- Xavfsiz: faqat indeks qo'shadi, ma'lumotga tegmaydi. Qayta ishga
-- tushirilsa xato bermaydi.
-- ============================================================================

create index if not exists idx_calls_company_created_at
  on public.calls (company_id, created_at desc);

-- Operator kesimidagi so'rovlar uchun (hourly?operator_ext=, xodim
-- statistikasi, kunlik limit tekshiruvi).
create index if not exists idx_calls_company_operator_created
  on public.calls (company_id, operator_ext, created_at desc)
  where operator_ext is not null;
