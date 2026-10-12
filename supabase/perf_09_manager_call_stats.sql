-- ============================================================================
-- manager_call_stats — GET /managers/:id/stats uchun.
-- 2026-10-12. Mustaqil fayl (perf_01'ga bog'liq emas).
--
-- NEGA: bitta xodimning BUTUN tarixidagi qo'ng'iroqlari (duration, kpi,
-- jarima, bonus) fetchAllRows bilan tortilib Node'da o'rtacha/yig'indi
-- olinardi. Endi bitta qator qaytadi.
--
-- Qaytaradi (bitta qator):
--   total_calls   — xodimning barcha qo'ng'iroqlari
--   kpi_sum       — sum(coalesce(kpi_score, 0))   (o'rtacha = kpi_sum/total)
--   duration_sum  — sum(coalesce(duration, 0))
--   penalty_sum / bonus_sum — sum(coalesce(..., 0))
--   calls_today   — created_at >= p_today_start
-- Eski kod null'larni 0 deb olib hamma qatorga bo'lardi — Node aynan shunday.
--
-- TENANT: avval faqat manager_id bo'yicha filtrlangan edi; endi qo'shimcha
-- company_id = p_company_id sharti ham bor (har so'rov kompaniya bilan
-- cheklansin). FARQ amalda yo'q: 2026-10-12 tekshiruvi — kompaniyaga
-- tegishli xodimlarning company_id'si bo'sh qo'ng'iroqlari 0 ta.
--
-- Xavfsizlik: faqat service_role (backend) chaqira oladi.
-- ============================================================================

create or replace function public.manager_call_stats(
  p_company_id  uuid,
  p_manager_id  uuid,
  p_today_start timestamptz
)
returns table (
  total_calls  bigint,
  kpi_sum      bigint,
  duration_sum bigint,
  penalty_sum  numeric,
  bonus_sum    numeric,
  calls_today  bigint
)
language sql
stable
as $$
  select count(*),
         coalesce(sum(coalesce(c.kpi_score, 0)), 0)::bigint,
         coalesce(sum(coalesce(c.duration, 0)), 0)::bigint,
         coalesce(sum(coalesce(c.penalty_amount, 0)), 0),
         coalesce(sum(coalesce(c.bonus_amount, 0)), 0),
         count(*) filter (where c.created_at >= p_today_start)
  from public.calls c
  where c.company_id = p_company_id
    and c.manager_id = p_manager_id;
$$;

revoke execute on function public.manager_call_stats(uuid, uuid, timestamptz) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function public.manager_call_stats(uuid, uuid, timestamptz) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke execute on function public.manager_call_stats(uuid, uuid, timestamptz) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.manager_call_stats(uuid, uuid, timestamptz) to service_role;
  end if;
end $$;

notify pgrst, 'reload schema';
