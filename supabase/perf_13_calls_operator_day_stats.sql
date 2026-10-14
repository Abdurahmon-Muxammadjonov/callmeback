-- ============================================================================
-- calls_operator_day_stats — bir kunning OPERATOR KESIMI. 2026-10-14.
-- perf_01_report_helpers.sql dan keyin (unga bog'liq emas, tartib uchun).
--
-- NEGA: Analitikadagi "Jamoa samaradorligi", norma banneri, Solishtirishdagi
-- "kim o'sdi, kim tushdi" va Boshqaruv panelidagi "Intizom" kunning BARCHA
-- qo'ng'iroqlarini /api/calls'dan 200 tadan (offset bilan, ~7 ketma-ket
-- so'rov) tortib brauzerda sanardi (pulse/data/dayCalls.ts operatorsOf).
-- Sekin, va sahifalash paytida yangi qo'ng'iroq kelsa son sakrardi.
-- Endi bitta RPC; har "📅 Sana" tanlovi ham shu funksiya bilan.
--
-- Hisob frontenddagi operatorsOf bilan bir xil:
--   key          = ichki raqam (bo'shliqsiz) ?? manager_id ?? '—'
--   calls        = qo'ng'iroqlar soni (operatorsiz qo'ng'iroqlar '—' kalitida)
--   long_calls   = duration >= p_long_sec (backend long_calls bilan bir xil;
--                  frontendda avval > edi, 2026-10-12 da >= qilingan)
--   incoming / outgoing = direction bo'yicha
--   leads        = sum(new_leads_count)
--   scored / score10_sum = kpi_score > 0 bo'lganlar; 10 ballikka o'girilgan
--                  (kpi > 10 => kpi/10) — o'rtacha frontendda yaxlitlanadi
--   talk_sec     = sum(duration)
--   manager_id   = shu kalitdagi xodim (ism uchun), bo'lmasa null
--
-- Natija jsonb (PostgREST 1000 qator chegarasiga tegmaydi).
-- Xavfsizlik: faqat service_role (backend) chaqira oladi.
-- Qayta ishga tushirsa xato bermaydi.
-- ============================================================================

create or replace function public.calls_operator_day_stats(
  p_company_id uuid,
  p_from       timestamptz,
  p_to         timestamptz,
  p_long_sec   integer default 60
)
returns jsonb
language sql
stable
as $$
  with c as (
    select coalesce(nullif(regexp_replace(c.operator_ext, '^\s+|\s+$', '', 'g'), ''),
                    c.manager_id::text, '—')                                  as key,
           nullif(regexp_replace(c.operator_ext, '^\s+|\s+$', '', 'g'), '')   as ext,
           c.manager_id,
           coalesce(c.duration, 0)                                            as dur,
           c.direction,
           coalesce(c.new_leads_count, 0)                                     as leads,
           coalesce(c.kpi_score, 0)                                           as kpi
    from public.calls c
    where c.company_id = p_company_id
      and c.created_at >= p_from
      and c.created_at <  p_to
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'key',         g.key,
           'ext',         g.ext,
           'manager_id',  g.manager_id,
           'calls',       g.calls,
           'long_calls',  g.long_calls,
           'incoming',    g.incoming,
           'outgoing',    g.outgoing,
           'leads',       g.leads,
           'scored',      g.scored,
           'score10_sum', g.score10_sum,
           'talk_sec',    g.talk_sec
         ) order by g.calls desc, g.key), '[]'::jsonb)
  from (
    select key,
           max(ext)                                                         as ext,
           (array_agg(manager_id) filter (where manager_id is not null))[1] as manager_id,
           count(*)                                                         as calls,
           count(*) filter (where dur >= p_long_sec)                        as long_calls,
           count(*) filter (where direction = 'incoming')                   as incoming,
           count(*) filter (where direction = 'outgoing')                   as outgoing,
           coalesce(sum(leads), 0)                                          as leads,
           count(*) filter (where kpi > 0)                                  as scored,
           coalesce(sum(case when kpi > 10 then kpi / 10.0 else kpi end) filter (where kpi > 0), 0) as score10_sum,
           coalesce(sum(dur), 0)                                            as talk_sec
    from c
    group by key
  ) g;
$$;

revoke execute on function public.calls_operator_day_stats(uuid, timestamptz, timestamptz, integer) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function public.calls_operator_day_stats(uuid, timestamptz, timestamptz, integer) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke execute on function public.calls_operator_day_stats(uuid, timestamptz, timestamptz, integer) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.calls_operator_day_stats(uuid, timestamptz, timestamptz, integer) to service_role;
  end if;
end $$;

notify pgrst, 'reload schema';
