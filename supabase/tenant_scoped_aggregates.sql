-- ============================================================
-- XAVFSIZLIK TUZATISHI (production'da aniqlangan CRITICAL xato):
-- calls_pop_stats va calls_relationship_dynamics FAQAT p_platform_id
-- bo'yicha filtrlar edi — kompaniya (tenant) bo'yicha filtr YO'Q edi.
-- Natijada /analytics/pop va /api/management/relationship-dynamics
-- HAR QANDAY kompaniyaning agregatlangan (audio/ism'siz, lekin baribir
-- boshqa tenant'ga tegishli) qo'ng'iroq statistikasini ko'rsatib
-- yuborishi mumkin edi.
--
-- Bu fayl ikkala funksiyaga ham calls_overview_stats'dagi bilan bir xil
-- p_manager_ids uuid[] parametrini qo'shadi (default null — eski
-- chaqiruvlar buzilmaydi), va uni p_platform_id bilan BIRGA (AND) filtr
-- sifatida qo'llaydi. Node tomoni (src/routes/analytics.ts,
-- src/routes/management.ts) endi har doim chaqiruvchi kompaniyaning
-- o'z manager id'lari ro'yxatini yuboradi.
--
-- Supabase Dashboard → SQL Editor → Run. Idempotent (create or replace).
-- ============================================================

create or replace function public.calls_pop_stats(p_platform_id text default null, p_manager_ids uuid[] default null)
returns jsonb
language sql
stable
as $$
  with src as (
    select created_at, duration, kpi_score
    from public.calls
    where created_at >= date_trunc('month', now()) - interval '1 month'
      and (p_platform_id is null or platform_id = p_platform_id)
      and (p_manager_ids is null or manager_id = any(p_manager_ids))
  ),
  agg as (
    select
      count(*) filter (where created_at >= date_trunc('day', now()))                                                              as d_cur_calls,
      count(*) filter (where created_at >= date_trunc('day', now()) - interval '1 day' and created_at < now() - interval '1 day') as d_prev_calls,
      coalesce(sum(duration) filter (where created_at >= date_trunc('day', now())), 0)                                            as d_cur_dur,
      coalesce(sum(duration) filter (where created_at >= date_trunc('day', now()) - interval '1 day' and created_at < now() - interval '1 day'), 0) as d_prev_dur,
      avg(kpi_score) filter (where created_at >= date_trunc('day', now()))                                                        as d_cur_kpi,
      avg(kpi_score) filter (where created_at >= date_trunc('day', now()) - interval '1 day' and created_at < now() - interval '1 day') as d_prev_kpi,

      count(*) filter (where created_at >= date_trunc('week', now()))                                                               as w_cur_calls,
      count(*) filter (where created_at >= date_trunc('week', now()) - interval '1 week' and created_at < now() - interval '1 week') as w_prev_calls,
      coalesce(sum(duration) filter (where created_at >= date_trunc('week', now())), 0)                                             as w_cur_dur,
      coalesce(sum(duration) filter (where created_at >= date_trunc('week', now()) - interval '1 week' and created_at < now() - interval '1 week'), 0) as w_prev_dur,
      avg(kpi_score) filter (where created_at >= date_trunc('week', now()))                                                         as w_cur_kpi,
      avg(kpi_score) filter (where created_at >= date_trunc('week', now()) - interval '1 week' and created_at < now() - interval '1 week') as w_prev_kpi,

      count(*) filter (where created_at >= date_trunc('month', now()))                                                                as m_cur_calls,
      count(*) filter (where created_at >= date_trunc('month', now()) - interval '1 month' and created_at < now() - interval '1 month') as m_prev_calls,
      coalesce(sum(duration) filter (where created_at >= date_trunc('month', now())), 0)                                              as m_cur_dur,
      coalesce(sum(duration) filter (where created_at >= date_trunc('month', now()) - interval '1 month' and created_at < now() - interval '1 month'), 0) as m_prev_dur,
      avg(kpi_score) filter (where created_at >= date_trunc('month', now()))                                                          as m_cur_kpi,
      avg(kpi_score) filter (where created_at >= date_trunc('month', now()) - interval '1 month' and created_at < now() - interval '1 month') as m_prev_kpi
    from src
  )
  select jsonb_build_object(
    'daily', jsonb_build_object(
      'calls',            jsonb_build_object('current', d_cur_calls, 'previous', d_prev_calls, 'change_pct', public.pop_pct(d_cur_calls, d_prev_calls)),
      'duration_minutes', jsonb_build_object('current', round(d_cur_dur/60.0, 1), 'previous', round(d_prev_dur/60.0, 1), 'change_pct', public.pop_pct(d_cur_dur, d_prev_dur)),
      'avg_kpi',          jsonb_build_object('current', round(coalesce(d_cur_kpi,0), 2), 'previous', round(coalesce(d_prev_kpi,0), 2), 'change_pct', public.pop_pct(coalesce(d_cur_kpi,0), coalesce(d_prev_kpi,0)))
    ),
    'weekly', jsonb_build_object(
      'calls',            jsonb_build_object('current', w_cur_calls, 'previous', w_prev_calls, 'change_pct', public.pop_pct(w_cur_calls, w_prev_calls)),
      'duration_minutes', jsonb_build_object('current', round(w_cur_dur/60.0, 1), 'previous', round(w_prev_dur/60.0, 1), 'change_pct', public.pop_pct(w_cur_dur, w_prev_dur)),
      'avg_kpi',          jsonb_build_object('current', round(coalesce(w_cur_kpi,0), 2), 'previous', round(coalesce(w_prev_kpi,0), 2), 'change_pct', public.pop_pct(coalesce(w_cur_kpi,0), coalesce(w_prev_kpi,0)))
    ),
    'monthly', jsonb_build_object(
      'calls',            jsonb_build_object('current', m_cur_calls, 'previous', m_prev_calls, 'change_pct', public.pop_pct(m_cur_calls, m_prev_calls)),
      'duration_minutes', jsonb_build_object('current', round(m_cur_dur/60.0, 1), 'previous', round(m_prev_dur/60.0, 1), 'change_pct', public.pop_pct(m_cur_dur, m_prev_dur)),
      'avg_kpi',          jsonb_build_object('current', round(coalesce(m_cur_kpi,0), 2), 'previous', round(coalesce(m_prev_kpi,0), 2), 'change_pct', public.pop_pct(coalesce(m_cur_kpi,0), coalesce(m_prev_kpi,0)))
    ),
    'generated_at', now()
  )
  from agg;
$$;

create or replace function public.calls_relationship_dynamics(p_platform_id text default null, p_manager_ids uuid[] default null)
returns jsonb
language sql
stable
as $$
  with daily as (
    select date_trunc('day', created_at) as d,
           coalesce(sum(unanswered_count), 0) as u,
           coalesce(sum(bad_leads_count), 0)  as b
    from public.calls
    where created_at >= date_trunc('day', now()) - interval '13 days'
      and (p_platform_id is null or platform_id = p_platform_id)
      and (p_manager_ids is null or manager_id = any(p_manager_ids))
    group by 1
  ),
  spark_days as (
    select gs as d
    from generate_series(date_trunc('day', now()) - interval '6 days', date_trunc('day', now()), interval '1 day') as gs
  ),
  spark_u as (
    select coalesce(jsonb_agg(coalesce(dl.u, 0) order by sp.d), '[]'::jsonb) as arr
    from spark_days sp left join daily dl on dl.d = sp.d
  ),
  spark_b as (
    select coalesce(jsonb_agg(coalesce(dl.b, 0) order by sp.d), '[]'::jsonb) as arr
    from spark_days sp left join daily dl on dl.d = sp.d
  ),
  totals as (
    select
      coalesce(sum(u) filter (where d = date_trunc('day', now())), 0)                                                                          as u_today,
      coalesce(sum(u) filter (where d = date_trunc('day', now()) - interval '1 day'), 0)                                                        as u_yesterday,
      coalesce(sum(u) filter (where d >= date_trunc('day', now()) - interval '6 days'), 0)                                                      as u_week,
      coalesce(sum(u) filter (where d >= date_trunc('day', now()) - interval '13 days' and d < date_trunc('day', now()) - interval '6 days'), 0) as u_last_week,
      coalesce(sum(b) filter (where d = date_trunc('day', now())), 0)                                                                            as b_today,
      coalesce(sum(b) filter (where d = date_trunc('day', now()) - interval '1 day'), 0)                                                        as b_yesterday,
      coalesce(sum(b) filter (where d >= date_trunc('day', now()) - interval '6 days'), 0)                                                      as b_week,
      coalesce(sum(b) filter (where d >= date_trunc('day', now()) - interval '13 days' and d < date_trunc('day', now()) - interval '6 days'), 0) as b_last_week
    from daily
  )
  select jsonb_build_array(
    jsonb_build_object(
      'key', 'unanswered', 'label', 'Javobsiz qoldirilgan',
      'today', (select u_today from totals), 'yesterday', (select u_yesterday from totals),
      'week', (select u_week from totals), 'lastWeek', (select u_last_week from totals),
      'spark', (select arr from spark_u),
      'lowerIsBetter', true
    ),
    jsonb_build_object(
      'key', 'bad_leads', 'label', 'Sifatsiz lidlar',
      'today', (select b_today from totals), 'yesterday', (select b_yesterday from totals),
      'week', (select b_week from totals), 'lastWeek', (select b_last_week from totals),
      'spark', (select arr from spark_b),
      'lowerIsBetter', true
    )
  );
$$;

notify pgrst, 'reload schema';
