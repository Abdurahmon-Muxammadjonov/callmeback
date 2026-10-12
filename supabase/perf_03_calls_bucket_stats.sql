-- ============================================================================
-- calls_bucket_stats — KUNLIK / SOATLIK yig'ma ko'rsatkichlar.
-- 2026-10-12. perf_01_report_helpers.sql DAN KEYIN ishga tushirilsin.
--
-- Ishlatadi:
--   /analytics/daily-summary          (kun bo'yicha, ixtiyoriy until=HH:MM)
--   /analytics/hourly                 (soat bo'yicha, ixtiyoriy operator_ext)
--   /api/management/relationship-dynamics (kunlik javobsiz/sifatsiz lid)
--   /api/management/conversion-history    (kunlik qo'ng'iroqlar soni)
--   /analytics/daily-minutes          (kunlik jami qo'ng'iroq soni)
--
-- NEGA: bu endpointlar oyna ichidagi HAMMA qatorni fetchAllRows bilan
-- 1000 tadan ketma-ket tortib Node'da sanardi (30 kun = 40 000 qator,
-- ~40 so'rov). Endi bitta RPC, natija <= 120 kun yoki 24 soat qatori.
-- Bir xil kunlik son hamma endpointda SHU funksiyadan chiqadi — "bir kun
-- uchun har joyda har xil son" xatosining oldini oladi.
--
-- Parametrlar:
--   p_from / p_to   — from <= created_at < to (p_to null = chegarasiz)
--   p_by_hour       — true: (kun, soat) bo'yicha; false: faqat kun bo'yicha
--   p_tz            — kun/soat chegarasi qaysi mintaqada (standart Toshkent)
--   p_until 'HH:MM' — kunning faqat shu vaqtgacha bo'lgan qismi (eski
--                     tashkentHm(created_at) > until => tashlanadi bilan bir
--                     xil: soniyalar e'tiborga olinmaydi, 10:17:59 <= 10:17)
--   p_long_sec      — "uzun qo'ng'iroq" chegarasi (KPI normalaridan)
--   p_operator_ext / p_platform_id — ixtiyoriy aniq filtrlar
--
-- Har ustun eski Node hisobining aynan o'zi:
--   seconds        = sum(max(0, duration))
--   long_calls     = max(0, duration) >= p_long_sec
--   operator_calls = call_is_operator(operator_ext, manager_id)
--   with_transcript= transcript bo'sh emas (daily-summary "analyzed")
--   analyzed_any   = transcript bo'sh emas YOKI kpi_score > 0 (hourly "analyzed")
--   scored / score_sum / low_score = kpi_score > 0 / yig'indi / 0 < kpi < 50
--   lead_phones    = new_leads_count > 0 bo'lgan qatorlardagi TAKRORLANMAS
--                    mijoz raqamlari (bo'shliqlari kesilgan)
--   leads_no_phone = new_leads_count > 0, lekin raqami yo'q qatorlar soni
--   penalty_sum/bonus_sum = sum(max(0, ...))
--
-- Transkript matni UZATILMAYDI: octet_length() TOAST'ni ochmasdan
-- hajmni o'qiydi, ya'ni "matn bormi" tekshiruvi arzon.
--
-- FARQLAR (izohda yozilishi talab qilingan):
--   - hourly avval kun oxirini 23:59:59.999 (lte) bilan olardi; endi
--     [kun boshi, keyingi kun boshi). Faqat 23:59:59.999...24:00:00
--     oralig'idagi (1 ms) qatorlar endi ham kiradi — amalda yo'q.
--   - mijoz raqamidagi bo'shliqlar regex \s bilan kesiladi (JS trim()
--     bilan bir xil; ekzotik Unicode bo'shliqlarda farq bo'lishi mumkin).
--
-- Xavfsizlik: faqat service_role (backend) chaqira oladi.
-- ============================================================================

create or replace function public.calls_bucket_stats(
  p_company_id   uuid,
  p_from         timestamptz,
  p_to           timestamptz default null,
  p_by_hour      boolean     default false,
  p_tz           text        default 'Asia/Tashkent',
  p_until        text        default null,
  p_long_sec     integer     default 60,
  p_operator_ext text        default null,
  p_platform_id  text        default null
)
returns table (
  day             date,
  hour            integer,
  calls           bigint,
  operator_calls  bigint,
  seconds         bigint,
  long_calls      bigint,
  with_transcript bigint,
  analyzed_any    bigint,
  scored          bigint,
  score_sum       bigint,
  low_score       bigint,
  incoming        bigint,
  outgoing        bigint,
  invited         bigint,
  closed          bigint,
  bad_leads       bigint,
  unanswered      bigint,
  lead_phones     bigint,
  leads_no_phone  bigint,
  penalty_sum     numeric,
  bonus_sum       numeric
)
language sql
stable
as $$
  with src as (
    select
      (c.created_at at time zone p_tz)                                  as local_ts,
      greatest(coalesce(c.duration, 0), 0)                               as sec,
      public.call_is_operator(c.operator_ext, c.manager_id)             as is_op,
      coalesce(octet_length(c.transcript), 0) > 0                        as has_text,
      coalesce(c.kpi_score, 0)                                           as kpi,
      c.direction,
      coalesce(c.sent_to_dealer_count, 0)                                as invited,
      coalesce(c.closed_deals_count, 0)                                  as closed,
      coalesce(c.bad_leads_count, 0)                                     as bad_leads,
      coalesce(c.unanswered_count, 0)                                    as unanswered,
      coalesce(c.new_leads_count, 0)                                     as new_leads,
      nullif(regexp_replace(coalesce(c.client_phone, ''), '^\s+|\s+$', '', 'g'), '') as phone,
      greatest(coalesce(c.penalty_amount, 0), 0)                         as penalty,
      greatest(coalesce(c.bonus_amount, 0), 0)                           as bonus
    from public.calls c
    where c.company_id = p_company_id
      and c.created_at >= p_from
      and c.created_at <  coalesce(p_to, 'infinity'::timestamptz)
      and (p_operator_ext is null or c.operator_ext = p_operator_ext)
      and (p_platform_id  is null or c.platform_id  = p_platform_id)
  )
  select
    local_ts::date                                                as day,
    case when p_by_hour then extract(hour from local_ts)::int end as hour,
    count(*)                                                      as calls,
    count(*) filter (where is_op)                                 as operator_calls,
    coalesce(sum(sec), 0)::bigint                                 as seconds,
    count(*) filter (where sec >= p_long_sec)                     as long_calls,
    count(*) filter (where has_text)                              as with_transcript,
    count(*) filter (where has_text or kpi > 0)                   as analyzed_any,
    count(*) filter (where kpi > 0)                               as scored,
    coalesce(sum(kpi) filter (where kpi > 0), 0)::bigint          as score_sum,
    count(*) filter (where kpi > 0 and kpi < 50)                  as low_score,
    count(*) filter (where direction = 'incoming')                as incoming,
    count(*) filter (where direction = 'outgoing')                as outgoing,
    coalesce(sum(invited), 0)::bigint                             as invited,
    coalesce(sum(closed), 0)::bigint                              as closed,
    coalesce(sum(bad_leads), 0)::bigint                           as bad_leads,
    coalesce(sum(unanswered), 0)::bigint                          as unanswered,
    count(distinct phone) filter (where new_leads > 0)            as lead_phones,
    count(*) filter (where new_leads > 0 and phone is null)       as leads_no_phone,
    coalesce(sum(penalty), 0)                                     as penalty_sum,
    coalesce(sum(bonus), 0)                                       as bonus_sum
  from src
  where p_until is null
     or (extract(hour from local_ts) * 60 + extract(minute from local_ts))
        <= (split_part(p_until, ':', 1)::int * 60 + split_part(p_until, ':', 2)::int)
  group by 1, 2
  order by 1 desc, 2;
$$;

revoke execute on function public.calls_bucket_stats(uuid, timestamptz, timestamptz, boolean, text, text, integer, text, text) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function public.calls_bucket_stats(uuid, timestamptz, timestamptz, boolean, text, text, integer, text, text) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke execute on function public.calls_bucket_stats(uuid, timestamptz, timestamptz, boolean, text, text, integer, text, text) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.calls_bucket_stats(uuid, timestamptz, timestamptz, boolean, text, text, integer, text, text) to service_role;
  end if;
end $$;

notify pgrst, 'reload schema';
