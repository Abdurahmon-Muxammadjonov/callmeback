-- ============================================================================
-- calls_analysis_status — /analytics/analysis-status uchun (bir kun).
-- 2026-10-12. perf_01_report_helpers.sql DAN KEYIN ishga tushirilsin.
--
-- NEGA: endpoint kunning BARCHA qo'ng'iroqlarini transkript matni bilan
-- (ishlatilmasa ham) fetchAllRows bilan tortib Node'da sanardi.
--
-- Natija jsonb:
--   total                — kundagi BARCHA qo'ng'iroqlar (filtrsiz)
--   operator_calls       — ulardan operator qo'ng'iroqlari (perf_01 ta'rifi)
--   analyzed / analyzed_seconds          — kpi_score > 0
--   not_analyzed / not_analyzed_seconds  — qolganlari
--   reasons   — [{reason, count, seconds}] tahlil qilinmaganlar sababi;
--               bo'sh/null sabab => 'Sabab yozilmagan' (eski kod bilan bir xil)
--   operators — [{ext, analyzed, skipped, analyzed_seconds, limit_reached}];
--               ichki raqami bo'sh/null => '—' (eski kod bilan bir xil)
-- seconds = sum(max(0, duration)). Daqiqaga o'girish, saralash, matnlar Node'da.
--
-- FARQ: kun oxiri avval 23:59:59.999 (lte) edi; endi [from, to) — 1 ms.
--
-- Xavfsizlik: faqat service_role (backend) chaqira oladi.
-- ============================================================================

create or replace function public.calls_analysis_status(
  p_company_id uuid,
  p_from       timestamptz,
  p_to         timestamptz
)
returns jsonb
language sql
stable
as $$
  with c as (
    select coalesce(c.kpi_score, 0) > 0                                   as ok,
           greatest(coalesce(c.duration, 0), 0)                           as sec,
           coalesce(nullif(c.dropped_reason, ''), 'Sabab yozilmagan')     as reason,
           c.dropped_reason,
           coalesce(nullif(c.operator_ext, ''), '—')                      as ext,
           public.call_is_operator(c.operator_ext, c.manager_id)         as is_op
    from public.calls c
    where c.company_id = p_company_id
      and c.created_at >= p_from
      and c.created_at <  p_to
  )
  select jsonb_build_object(
    'total',                (select count(*) from c),
    'operator_calls',       (select count(*) from c where is_op),
    'analyzed',             (select count(*) from c where ok),
    'analyzed_seconds',     (select coalesce(sum(sec), 0) from c where ok),
    'not_analyzed',         (select count(*) from c where not ok),
    'not_analyzed_seconds', (select coalesce(sum(sec), 0) from c where not ok),
    'reasons', (
      select coalesce(jsonb_agg(jsonb_build_object('reason', reason, 'count', n, 'seconds', s)
                                order by n desc, reason), '[]'::jsonb)
      from (select reason, count(*) as n, coalesce(sum(sec), 0) as s
            from c where not ok group by reason) r
    ),
    'operators', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'ext', ext, 'analyzed', a, 'skipped', k,
               'analyzed_seconds', s, 'limit_reached', lim)
             order by a desc, ext), '[]'::jsonb)
      from (select ext,
                   count(*) filter (where ok)                                   as a,
                   count(*) filter (where not ok)                               as k,
                   coalesce(sum(sec) filter (where ok), 0)                      as s,
                   coalesce(bool_or(dropped_reason = 'Kunlik limitdan oshdi'), false) as lim
            from c group by ext) o
    )
  );
$$;

revoke execute on function public.calls_analysis_status(uuid, timestamptz, timestamptz) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function public.calls_analysis_status(uuid, timestamptz, timestamptz) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke execute on function public.calls_analysis_status(uuid, timestamptz, timestamptz) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.calls_analysis_status(uuid, timestamptz, timestamptz) to service_role;
  end if;
end $$;

notify pgrst, 'reload schema';
