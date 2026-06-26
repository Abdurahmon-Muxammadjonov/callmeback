-- ============================================================
-- Period-over-Period (PoP) dvigateli — to'liq DINAMIK (now() asosida).
-- calls jadvali bo'yicha kunlik/haftalik/oylik solishtirish, bitta JSON.
-- Supabase Dashboard → SQL Editor → Run. Idempotent (create or replace).
-- ============================================================

-- Foiz o'zgarishi (oldingi 0 bo'lsa xavfsiz).
create or replace function public.pop_pct(cur numeric, prev numeric)
returns numeric
language sql
immutable
as $$
  select case
    when coalesce(prev, 0) = 0 then (case when coalesce(cur, 0) > 0 then 100 else 0 end)
    else round((cur - prev) / prev * 100, 1)
  end;
$$;

-- Asosiy funksiya: ixtiyoriy platform filtri bilan PoP statistikasi.
-- "Matching period" mantiqi: oldingi davr ham xuddi shu vaqtgacha (now() - interval)
-- olinadi — adolatli solishtirish uchun (yarim kun vs to'liq kun emas).
create or replace function public.calls_pop_stats(p_platform_id text default null)
returns jsonb
language sql
stable
as $$
  with src as (
    select created_at, duration, kpi_score
    from public.calls
    where created_at >= date_trunc('month', now()) - interval '1 month'
      and (p_platform_id is null or platform_id = p_platform_id)
  ),
  agg as (
    select
      -- ---------- DAILY (bugun vs kecha, bir xil vaqt oynasi) ----------
      count(*) filter (where created_at >= date_trunc('day', now()))                                                              as d_cur_calls,
      count(*) filter (where created_at >= date_trunc('day', now()) - interval '1 day' and created_at < now() - interval '1 day') as d_prev_calls,
      coalesce(sum(duration) filter (where created_at >= date_trunc('day', now())), 0)                                            as d_cur_dur,
      coalesce(sum(duration) filter (where created_at >= date_trunc('day', now()) - interval '1 day' and created_at < now() - interval '1 day'), 0) as d_prev_dur,
      avg(kpi_score) filter (where created_at >= date_trunc('day', now()))                                                        as d_cur_kpi,
      avg(kpi_score) filter (where created_at >= date_trunc('day', now()) - interval '1 day' and created_at < now() - interval '1 day') as d_prev_kpi,

      -- ---------- WEEKLY (bu hafta vs o'tgan hafta, dushanbadan shu vaqtgacha) ----------
      count(*) filter (where created_at >= date_trunc('week', now()))                                                               as w_cur_calls,
      count(*) filter (where created_at >= date_trunc('week', now()) - interval '1 week' and created_at < now() - interval '1 week') as w_prev_calls,
      coalesce(sum(duration) filter (where created_at >= date_trunc('week', now())), 0)                                             as w_cur_dur,
      coalesce(sum(duration) filter (where created_at >= date_trunc('week', now()) - interval '1 week' and created_at < now() - interval '1 week'), 0) as w_prev_dur,
      avg(kpi_score) filter (where created_at >= date_trunc('week', now()))                                                         as w_cur_kpi,
      avg(kpi_score) filter (where created_at >= date_trunc('week', now()) - interval '1 week' and created_at < now() - interval '1 week') as w_prev_kpi,

      -- ---------- MONTHLY (bu oy vs o'tgan oyning shu kunigacha) ----------
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
