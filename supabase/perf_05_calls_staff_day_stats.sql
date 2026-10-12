-- ============================================================================
-- calls_staff_day_stats — /analytics/staff-stats uchun (bir kun, operator kesimi).
-- 2026-10-12. perf_01_report_helpers.sql DAN KEYIN ishga tushirilsin.
--
-- NEGA: staff-stats kunning barcha operator qo'ng'iroqlarini TRANSKRIPT
-- matni bilan (ishlatilmasa ham!) tortardi, keyin call_criteria_scores va
-- lost_reasons'ni 200 talik bo'laklarda KETMA-KET so'rardi (1300 qo'ng'iroq
-- => 7+7 so'rov). Endi hammasi bitta so'rovda: join + aggregate.
--
-- Natija jsonb massiv, har operator uchun bitta obyekt:
--   key           — manager_id yoki 'ext:<ichki raqam>' (eski Node kaliti)
--   manager_id, operator_ext (faqat xodimsiz operator uchun)
--   calls, seconds (sum max(0,duration)), scored_calls / score_sum (kpi > 0)
--   leads/invited/closed — new_leads/sent_to_dealer/closed_deals yig'indisi
--   problems      — is_problem = true soni
--   stages        — [{title, sum, n}] skript bandlari (call_criteria_scores)
--   mistakes      — [{label, count, minus}] rop_comment'dagi
--                   "− X · Band: ..." qatorlaridan (eski regex bilan bir xil:
--                   ^−\s*([\d.]+)\s*·\s*([^:]+):)
--   lost          — [{reason, count}] lost_reasons jadvalidan
--   reasons       — [{reason, count}] dropped_reason (bo'sh emas)
-- O'rtacha, yaxlitlash, saralash, top-6 va AI tavsiya Node'da — JSON shakli
-- aynan avvalgidek.
--
-- FARQLAR (izohda yozilishi talab qilingan):
--   - ESKI KODDAGI XATO TUZALDI: call_criteria_scores 200 ta qo'ng'iroq
--     bo'lagi bo'yicha so'ralardi, PostgREST esa bir javobda ko'pi bilan 1000
--     qator beradi — 200 x 8 band = 1600 qatordan 600 tasi jimgina
--     tushib qolardi va band foizlari noto'g'ri chiqardi. Endi hammasi kiradi.
--   - Kun oxiri avval 23:59:59.999 (lte) edi; endi [from, to) — 1 ms farq.
--   - "1.2.3" kabi noto'g'ri son JS'da Number() => NaN => 0; bu yerda ham 0.
--     minus yig'indisi numeric (aniq), JS'da float edi — 0.1 darajadagi
--     yaxlitlashda farq amalda yo'q.
--   - operator_ext = '' endi operator emas (perf_01, prod'da 0 ta).
--
-- Xavfsizlik: faqat service_role (backend) chaqira oladi.
-- ============================================================================

create or replace function public.calls_staff_day_stats(
  p_company_id uuid,
  p_from       timestamptz,
  p_to         timestamptz
)
returns jsonb
language sql
stable
as $$
  with c as (
    select c.id,
           coalesce(c.manager_id::text, 'ext:' || c.operator_ext)       as op_key,
           c.manager_id,
           case when c.manager_id is null then c.operator_ext end       as operator_ext,
           greatest(coalesce(c.duration, 0), 0)                          as sec,
           coalesce(c.kpi_score, 0)                                      as kpi,
           c.rop_comment,
           c.dropped_reason,
           coalesce(c.new_leads_count, 0)                                as leads,
           coalesce(c.sent_to_dealer_count, 0)                           as invited,
           coalesce(c.closed_deals_count, 0)                             as closed,
           coalesce(c.is_problem, false)                                 as is_problem
    from public.calls c
    where c.company_id = p_company_id
      and c.created_at >= p_from
      and c.created_at <  p_to
      and public.call_is_operator(c.operator_ext, c.manager_id)
  ),
  base as (
    select op_key, manager_id, operator_ext,
           count(*)                                       as calls,
           coalesce(sum(sec), 0)                          as seconds,
           count(*) filter (where kpi > 0)                as scored_calls,
           coalesce(sum(kpi) filter (where kpi > 0), 0)   as score_sum,
           coalesce(sum(leads), 0)                        as leads,
           coalesce(sum(invited), 0)                      as invited,
           coalesce(sum(closed), 0)                       as closed,
           count(*) filter (where is_problem)             as problems
    from c
    group by op_key, manager_id, operator_ext
  ),
  stages as (
    select op_key, jsonb_agg(jsonb_build_object('title', title, 'sum', total, 'n', n)) as items
    from (
      select c.op_key, s.title, sum(s.score) as total, count(*) as n
      from c
      join public.call_criteria_scores s on s.call_id = c.id
      group by c.op_key, s.title
    ) x
    group by op_key
  ),
  lines as (
    select c.op_key,
           regexp_match(
             regexp_replace(l.line, '^\s+|\s+$', '', 'g'),
             '^−\s*([0-9.]+)\s*·\s*([^:]+):'
           ) as m
    from c
    cross join lateral regexp_split_to_table(coalesce(c.rop_comment, ''), E'\n') as l(line)
  ),
  mistakes as (
    select op_key, jsonb_agg(jsonb_build_object('label', label, 'count', n, 'minus', minus)) as items
    from (
      select op_key,
             regexp_replace(m[2], '^\s+|\s+$', '', 'g') as label,
             count(*)                                     as n,
             sum(case when m[1] ~ '^([0-9]+\.?[0-9]*|\.[0-9]+)$' then m[1]::numeric else 0 end) as minus
      from lines
      where m is not null
      group by 1, 2
    ) x
    group by op_key
  ),
  lost as (
    select op_key, jsonb_agg(jsonb_build_object('reason', reason_text, 'count', n)) as items
    from (
      select c.op_key, l.reason_text, count(*) as n
      from c
      join public.lost_reasons l on l.call_id = c.id
      group by c.op_key, l.reason_text
    ) x
    group by op_key
  ),
  reasons as (
    select op_key, jsonb_agg(jsonb_build_object('reason', dropped_reason, 'count', n)) as items
    from (
      select op_key, dropped_reason, count(*) as n
      from c
      where coalesce(dropped_reason, '') <> ''
      group by op_key, dropped_reason
    ) x
    group by op_key
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'key',          b.op_key,
           'manager_id',   b.manager_id,
           'operator_ext', b.operator_ext,
           'calls',        b.calls,
           'seconds',      b.seconds,
           'scored_calls', b.scored_calls,
           'score_sum',    b.score_sum,
           'leads',        b.leads,
           'invited',      b.invited,
           'closed',       b.closed,
           'problems',     b.problems,
           'stages',       coalesce(st.items, '[]'::jsonb),
           'mistakes',     coalesce(mi.items, '[]'::jsonb),
           'lost',         coalesce(lo.items, '[]'::jsonb),
           'reasons',      coalesce(re.items, '[]'::jsonb)
         ) order by b.calls desc, b.op_key), '[]'::jsonb)
  from base b
  left join stages   st on st.op_key = b.op_key
  left join mistakes mi on mi.op_key = b.op_key
  left join lost     lo on lo.op_key = b.op_key
  left join reasons  re on re.op_key = b.op_key;
$$;

revoke execute on function public.calls_staff_day_stats(uuid, timestamptz, timestamptz) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function public.calls_staff_day_stats(uuid, timestamptz, timestamptz) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke execute on function public.calls_staff_day_stats(uuid, timestamptz, timestamptz) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.calls_staff_day_stats(uuid, timestamptz, timestamptz) to service_role;
  end if;
end $$;

notify pgrst, 'reload schema';
