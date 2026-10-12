-- ============================================================================
-- calls_range_stats — /analytics/overview va /analytics/pop uchun.
-- 2026-10-12. perf_01_report_helpers.sql DAN KEYIN ishga tushirilsin.
--
-- NEGA: popStatsInNode() kompaniyaning oxirgi ~2 oylik BARCHA qatorini
-- fetchAllRows bilan 1000 tadan ketma-ket tortib (kuniga 1300+ qo'ng'iroq =>
-- 40 dan ortiq so'rov, har biri ~0.6 s) Node'da sanardi. Endi bitta RPC:
-- har bir vaqt oynasi uchun son/yig'indi bazada hisoblanadi.
--
-- Oynalar (kun/hafta/oy, joriy va oldingi) Node'da hisoblanib p_ranges
-- sifatida beriladi: [{"from": iso, "to": iso | null}, ...]. "to" = null —
-- yuqori chegara yo'q (eski Node kodidagi `to === undefined` bilan bir xil).
-- Shart: from <= created_at < to (eski agg() bilan aynan bir xil).
--
-- QAYTARILADI (har oyna uchun bitta qator, idx = massivdagi tartib 0..n-1):
--   calls          — barcha qo'ng'iroqlar soni
--   operator_calls — operator qo'ng'iroqlari (perf_01 dagi ta'rif)
--   seconds        — sum(duration) (eski kod kabi manfiy qiymat kesilmaydi)
--   kpi_sum/kpi_n  — o'rtacha KPI uchun (null kpi hisobga olinmaydi — eski
--                    kod ham null'larni tashlab o'rtacha olardi; ustun
--                    NOT NULL bo'lgani uchun amalda hamma qator kiradi)
-- Yaxlitlash va foiz (popPct, round1/round2) Node'da — JSON aynan avvalgidek.
--
-- Xavfsizlik: p_company_id har doim backend'dagi req.auth.companyId'dan.
-- Funksiya anon/authenticated rollariga YOPIQ — faqat service_role (backend).
-- ============================================================================

create or replace function public.calls_range_stats(p_company_id uuid, p_ranges jsonb)
returns table (
  idx            integer,
  calls          bigint,
  operator_calls bigint,
  seconds        bigint,
  kpi_sum        bigint,
  kpi_n          bigint
)
language sql
stable
as $$
  with r as (
    select (e.ord - 1)::int                                               as idx,
           (e.val->>'from')::timestamptz                                  as f,
           coalesce((e.val->>'to')::timestamptz, 'infinity'::timestamptz) as t
    from jsonb_array_elements(p_ranges) with ordinality as e(val, ord)
  )
  select r.idx,
         count(c.id),
         count(c.id) filter (where public.call_is_operator(c.operator_ext, c.manager_id)),
         coalesce(sum(c.duration), 0)::bigint,
         coalesce(sum(c.kpi_score), 0)::bigint,
         count(c.kpi_score)
  from r
  left join public.calls c
    on c.company_id = p_company_id
   and c.created_at >= r.f
   and c.created_at <  r.t
  group by r.idx
  order by r.idx;
$$;

revoke execute on function public.calls_range_stats(uuid, jsonb) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function public.calls_range_stats(uuid, jsonb) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke execute on function public.calls_range_stats(uuid, jsonb) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.calls_range_stats(uuid, jsonb) to service_role;
  end if;
end $$;

notify pgrst, 'reload schema';
