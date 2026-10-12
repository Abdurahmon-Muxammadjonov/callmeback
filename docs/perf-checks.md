# Indeks va so'rov rejasi tekshiruvi (Supabase SQL Editor)

2026-10-12. `supabase/perf_*.sql` ishga tushirilgandan keyin asosiy so'rovlar
indeksdan foydalanayotganini shu yerdagi so'rovlar bilan tekshiring.
Kompaniya id'si o'rniga o'zingiznikini qo'ying (JAMALS:
`24823352-465e-43ea-913c-9f9d7270b9e9`).

## 1. Indekslar bazada bormi

```sql
select indexname, indexdef
from pg_indexes
where schemaname = 'public' and tablename in ('calls', 'call_criteria_scores', 'lost_reasons', 'conversions')
order by tablename, indexname;
```

Kutilgan (bo'lmasa — ko'rsatilgan faylni ishga tushiring):

| Indeks                          | Fayl                                         |
| ------------------------------- | -------------------------------------------- |
| `idx_calls_company_created_at`  | `add_calls_company_created_idx.sql` yoki `perf_11_utel_queue_index.sql` |
| `idx_calls_utel_queue` (partial)| `perf_11_utel_queue_index.sql`               |
| `idx_ccs_call_id`, `idx_lost_reasons_call_id`, `idx_conversions_call_id` | `perf_11_utel_queue_index.sql` |

Hisobot funksiyalari bormi:

```sql
select proname from pg_proc
where pronamespace = 'public'::regnamespace
  and proname in ('call_is_operator', 'calls_range_stats', 'calls_bucket_stats', 'calls_operator_daily',
                  'calls_staff_day_stats', 'calls_analysis_status', 'company_call_totals',
                  'company_analytics_root', 'company_virtual_operators', 'manager_call_stats',
                  'company_conversions_daily')
order by 1;   -- 11 qator bo'lishi kerak
```

## 2. UTel navbati (worker, har ~8 soniyada)

Rejada `idx_calls_utel_queue` bo'lishi kerak (`Seq Scan on calls` — yomon):

```sql
explain analyze
select id, company_id, status from public.calls
where transcript is not null and transcript ~ '\S'
  and status <> 'done' and audio_url ilike '%utel%'
  and created_at >= '2026-09-01' and created_at < now() - interval '45 seconds'
order by created_at limit 40;

explain analyze
select id, audio_url, company_id, client_phone, error from public.calls
where audio_url ilike '%utel%' and transcript is null and status <> 'done'
  and created_at >= '2026-09-01' and created_at < now() - interval '45 seconds'
  and status <> 'requeued'
order by created_at limit 40;

explain analyze
select count(*) from public.calls
where audio_url ilike '%utel%' and transcript is null and status <> 'done' and created_at >= '2026-09-01';
```

Diqqat: so'rovdagi `status <> 'done'` va `audio_url ilike '%utel%'` indeks
predikati bilan AYNAN bir xil bo'lishi shart. Kodda (`runQueueOnce`,
`countWaiting`, `probeOnce`) o'zgartirilsa — indeksni ham o'zgartiring.

## 3. Kunlik hisobot (daily-summary, 30 kun)

Funksiya SQL'ga "inline" qilinadi, shuning uchun reja ichki so'rovni ko'rsatadi.
Kutilgan: `Index Scan`/`Bitmap Index Scan using idx_calls_company_created_at`.

```sql
explain analyze
select * from public.calls_bucket_stats(
  '24823352-465e-43ea-913c-9f9d7270b9e9',
  (date_trunc('day', now() at time zone 'Asia/Tashkent') - interval '29 days') at time zone 'Asia/Tashkent'
);
```

## 4. Qo'ng'iroqlar ro'yxati (/api/calls)

Kutilgan: `Index Scan using idx_calls_company_created_at` (Sort'siz).

```sql
explain analyze
select id, created_at, duration, kpi_score, status from public.calls
where company_id = '24823352-465e-43ea-913c-9f9d7270b9e9'
order by created_at desc
limit 50;
```

## Lokal natija (2026-10-12, 306 000 qator, PostgreSQL 16)

- Navbatning 4 ta so'rovi — `idx_calls_utel_queue` (prepared statement'ning
  6-bajarilishida ham, ya'ni generic plan rejimida ham).
- `calls_bucket_stats` 30 kun (17 600 qator) — `idx_calls_company_created_at`,
  ~15–20 ms; 120 kun — ~60 ms.
- `/api/calls` ro'yxati — `idx_calls_company_created_at`, sort'siz.
