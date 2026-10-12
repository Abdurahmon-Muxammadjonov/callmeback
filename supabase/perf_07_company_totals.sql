-- ============================================================================
-- Kompaniya bo'yicha BUTUN TARIX yig'indilari.
-- 2026-10-12. Mustaqil fayl (perf_01'ga bog'liq emas), lekin tartib uchun
-- perf_06 dan keyin ishga tushirilsin.
--
-- 1) company_call_totals — GET /dashboard/stats
--    NEGA: avg_score uchun kompaniyaning BUTUN tarixidagi kpi_score'lari
--    (15 000+ qator) fetchAllRows bilan 1000 tadan tortilardi (16+ so'rov).
--    Qaytaradi (bitta qator):
--      total_calls   — barcha qo'ng'iroqlar
--      calls_since   — created_at >= p_since (oy boshi)
--      duration_sum  — sum(duration) (eski /analytics: duration || 0)
--      kpi_sum       — sum(coalesce(kpi_score, 0)). Eski kod null kpi'ni 0
--                      deb olib HAMMA qatorga bo'lardi — o'rtacha Node'da
--                      aynan shunday: kpi_sum / total_calls.
--
-- 2) company_analytics_root — GET /analytics (root) va GET /api/analyze-call
--    NEGA: calls + conversions + lost_reasons uchala jadval butunlay
--    tortilib Node'da sanalardi.
--    Qaytaradi jsonb:
--      total_calls, duration_sum,
--      conv_n, traffic_avg, sales_avg — kompaniya qo'ng'iroqlariga tegishli
--                      conversions (calls!inner join bilan bir xil chegara);
--                      o'rtacha 2 xonagacha ANIQ yaxlitlangan (numeric round)
--      lost_reasons  — {reason_text: qatorlar soni} (eski kod `count` ustunini
--                      emas, QATORLARNI sanardi — bu yerda ham shunday)
--
-- FARQ: konversiya o'rtachasi avval JS float yig'indisidan toFixed(2) bilan
-- olinardi — aniq qiymat .xx5 bo'lsa 0.01 ga farq qilishi mumkin edi
-- (qatorlar tartibiga bog'liq). Endi aniq numeric yaxlitlash. Qolgan
-- yig'indilar butun sonlar — farq yo'q.
--
-- Xavfsizlik: faqat service_role (backend) chaqira oladi.
-- ============================================================================

create or replace function public.company_call_totals(
  p_company_id uuid,
  p_since      timestamptz
)
returns table (
  total_calls  bigint,
  calls_since  bigint,
  duration_sum bigint,
  kpi_sum      bigint
)
language sql
stable
as $$
  select count(*),
         count(*) filter (where c.created_at >= p_since),
         coalesce(sum(coalesce(c.duration, 0)), 0)::bigint,
         coalesce(sum(coalesce(c.kpi_score, 0)), 0)::bigint
  from public.calls c
  where c.company_id = p_company_id;
$$;

create or replace function public.company_analytics_root(p_company_id uuid)
returns jsonb
language sql
stable
as $$
  with t as (
    select count(*) as total_calls,
           coalesce(sum(coalesce(c.duration, 0)), 0) as duration_sum
    from public.calls c
    where c.company_id = p_company_id
  ),
  cv as (
    select count(*) as conv_n,
           round(avg(coalesce(v.traffic_conversion, 0)), 2) as traffic_avg,
           round(avg(coalesce(v.sales_conversion, 0)), 2)   as sales_avg
    from public.conversions v
    join public.calls c on c.id = v.call_id
    where c.company_id = p_company_id
  ),
  lr as (
    select coalesce(jsonb_object_agg(reason_text, n), '{}'::jsonb) as lost
    from (
      select l.reason_text, count(*) as n
      from public.lost_reasons l
      join public.calls c on c.id = l.call_id
      where c.company_id = p_company_id
      group by l.reason_text
    ) x
  )
  select jsonb_build_object(
    'total_calls',  t.total_calls,
    'duration_sum', t.duration_sum,
    'conv_n',       cv.conv_n,
    'traffic_avg',  cv.traffic_avg,
    'sales_avg',    cv.sales_avg,
    'lost_reasons', lr.lost
  )
  from t, cv, lr;
$$;

revoke execute on function public.company_call_totals(uuid, timestamptz) from public;
revoke execute on function public.company_analytics_root(uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function public.company_call_totals(uuid, timestamptz) from anon;
    revoke execute on function public.company_analytics_root(uuid) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke execute on function public.company_call_totals(uuid, timestamptz) from authenticated;
    revoke execute on function public.company_analytics_root(uuid) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.company_call_totals(uuid, timestamptz) to service_role;
    grant execute on function public.company_analytics_root(uuid) to service_role;
  end if;
end $$;

notify pgrst, 'reload schema';
