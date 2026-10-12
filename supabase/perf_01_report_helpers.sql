-- ============================================================================
-- HISOBOT YORDAMCHILARI — "operator qo'ng'iroq'i" ning YAGONA ta'rifi.
-- 2026-10-12. Tezlik/izchillik ishi (perf_*) ning BIRINCHI fayli — keyingi
-- perf_02 ... perf_10 funksiyalari shu yerdagi call_is_operator()'ga tayanadi,
-- shuning uchun AVVAL shu fayl ishga tushirilsin.
--
-- NEGA: "operator qo'ng'iroqlari" endpointlarda ikki xil yozilgan edi:
--   - daily-summary/hourly (Node):  r.operator_ext || r.manager_id  (JS
--     truthiness — bo'sh satr '' operator EMAS);
--   - daily-minutes/staff-stats (PostgREST): operator_ext.not.is.null —
--     bo'sh satr '' ham operator hisoblanardi.
-- Endi hamma joy shu bitta funksiyani ishlatadi: ichki raqami (bo'sh emas)
-- yoki biriktirilgan xodimi bor qo'ng'iroq = operator qo'ng'irog'i.
--
-- FARQ: operator_ext = '' bo'lgan qatorlar endi hech qayerda operator emas.
-- 2026-10-12 da prod'da bunday qator 0 ta edi (tekshirildi), ya'ni natija
-- amalda o'zgarmaydi.
--
-- Xavfsiz: faqat funksiya yaratadi. Qayta ishga tushirilsa xato bermaydi.
-- ============================================================================

create or replace function public.call_is_operator(p_operator_ext text, p_manager_id uuid)
returns boolean
language sql
immutable
as $$
  select coalesce(p_operator_ext, '') <> '' or p_manager_id is not null;
$$;

notify pgrst, 'reload schema';
