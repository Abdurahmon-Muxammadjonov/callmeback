-- ============================================================================
-- company_conversions_daily — GET /api/management/conversion-history uchun.
-- 2026-10-12. Mustaqil fayl (perf_01'ga bog'liq emas).
--
-- NEGA: oynadagi konversiyalar fetchAllRows bilan tortilib Node'da kun
-- bo'yicha o'rtacha olinardi. Endi guruhlash bazada; kunlik qo'ng'iroqlar
-- soni esa calls_bucket_stats (perf_03) dan olinadi — boshqa endpointlar
-- bilan BIR XIL ta'rif.
--
-- Qaytaradi (har kun uchun bitta qator):
--   day          — konversiya created_at'ining p_tz bo'yicha kuni
--   conv_n       — konversiyalar soni
--   traffic_avg / sales_avg — o'rtacha, 2 xonagacha ANIQ yaxlitlangan
--                  (numeric round: .xx5 => yuqoriga, eski toFixed(2) qoidasi)
-- Chegara: konversiya kompaniya qo'ng'irog'iga tegishli (eski calls!inner
-- join bilan bir xil), conversions.created_at >= p_from, ixtiyoriy
-- calls.platform_id = p_platform_id.
--
-- FARQ: eski kod o'rtachani JS float yig'indisidan toFixed(2) bilan olardi —
-- aniq qiymat .xx5 bo'lganda natija qatorlar kelish tartibiga qarab 0.01 ga
-- farq qilardi (masalan 54.035 goh 54.03, goh 54.04). Endi doim aniq 54.04.
--
-- Xavfsizlik: faqat service_role (backend) chaqira oladi.
-- ============================================================================

create or replace function public.company_conversions_daily(
  p_company_id  uuid,
  p_from        timestamptz,
  p_tz          text default 'Asia/Tashkent',
  p_platform_id text default null
)
returns table (
  day         date,
  conv_n      bigint,
  traffic_avg numeric,
  sales_avg   numeric
)
language sql
stable
as $$
  select (v.created_at at time zone p_tz)::date,
         count(*),
         round(avg(coalesce(v.traffic_conversion, 0)), 2),
         round(avg(coalesce(v.sales_conversion, 0)), 2)
  from public.conversions v
  join public.calls c on c.id = v.call_id
  where c.company_id = p_company_id
    and v.created_at >= p_from
    and (p_platform_id is null or c.platform_id = p_platform_id)
  group by 1
  order by 1;
$$;

revoke execute on function public.company_conversions_daily(uuid, timestamptz, text, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function public.company_conversions_daily(uuid, timestamptz, text, text) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke execute on function public.company_conversions_daily(uuid, timestamptz, text, text) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.company_conversions_daily(uuid, timestamptz, text, text) to service_role;
  end if;
end $$;

notify pgrst, 'reload schema';
