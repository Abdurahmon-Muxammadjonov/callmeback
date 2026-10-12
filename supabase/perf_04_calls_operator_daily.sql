-- ============================================================================
-- calls_operator_daily — /analytics/daily-minutes uchun (kun x operator).
-- 2026-10-12. perf_01_report_helpers.sql DAN KEYIN ishga tushirilsin.
--
-- NEGA: daily-minutes 30-90 kunlik operator qo'ng'iroqlarini fetchAllRows
-- bilan tortib Node'da kun va operator bo'yicha guruhlardi. Endi guruhlash
-- bazada, javob — kichik jsonb massiv.
--
-- Natija jsonb (setof emas) — PostgREST'ning 1000 qatorlik javob chegarasi
-- kun x operator juftliklariga (90 kun x 15+ operator) tegmasin.
--
-- Element: {day, manager_id, operator_ext, calls, seconds}
--   - faqat operator qo'ng'iroqlari (perf_01 call_is_operator);
--   - guruh kaliti: manager_id, xodimga biriktirilmagan bo'lsa operator_ext
--     (eski Node: c.manager_id || `ext:${c.operator_ext}`);
--   - seconds = sum(max(0, duration)); kun = p_tz bo'yicha.
-- Xodim ismi va saralash Node'da (eski kod bilan bir xil).
--
-- FARQ: eski PostgREST filtri (operator_ext.not.is.null) operator_ext = ''
-- qatorni ham operator deb olardi; endi olmaydi (prod'da 0 ta, perf_01).
--
-- Xavfsizlik: faqat service_role (backend) chaqira oladi.
-- ============================================================================

create or replace function public.calls_operator_daily(
  p_company_id uuid,
  p_from       timestamptz,
  p_tz         text default 'Asia/Tashkent'
)
returns jsonb
language sql
stable
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'day',          g.day,
           'manager_id',   g.manager_id,
           'operator_ext', g.operator_ext,
           'calls',        g.calls,
           'seconds',      g.seconds
         ) order by g.day desc, g.seconds desc), '[]'::jsonb)
  from (
    select (c.created_at at time zone p_tz)::date                      as day,
           c.manager_id,
           case when c.manager_id is null then c.operator_ext end      as operator_ext,
           count(*)                                                    as calls,
           coalesce(sum(greatest(coalesce(c.duration, 0), 0)), 0)      as seconds
    from public.calls c
    where c.company_id = p_company_id
      and c.created_at >= p_from
      and public.call_is_operator(c.operator_ext, c.manager_id)
    group by 1, 2, 3
  ) g;
$$;

revoke execute on function public.calls_operator_daily(uuid, timestamptz, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function public.calls_operator_daily(uuid, timestamptz, text) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke execute on function public.calls_operator_daily(uuid, timestamptz, text) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.calls_operator_daily(uuid, timestamptz, text) to service_role;
  end if;
end $$;

notify pgrst, 'reload schema';
