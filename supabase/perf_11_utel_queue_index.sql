-- ============================================================================
-- UTel navbati uchun partial indeks + join indekslari. 2026-10-12.
-- Mustaqil fayl (boshqa perf_* fayllarga bog'liq emas).
--
-- NEGA: worker navbati (src/routes/utel-webhook.ts — runQueueOnce,
-- countWaiting, probeOnce) har ~8 soniyada
--     audio_url ILIKE '%utel%' AND status <> 'done' AND created_at ...
-- bilan so'raydi. '%utel%' boshida % bor — oddiy indeks ishlamaydi, ya'ni
-- har safar butun calls jadvali (32 000+ qator, transkriptlari bilan)
-- skanerlanardi. Partial indeks faqat navbatdagi (~5 000) qatorni saqlaydi.
--
-- MUHIM: so'rovdagi shartlar indeks predikati bilan AYNAN bir xil yozilgan
-- (.neq('status','done') => status <> 'done'; .ilike('audio_url','%utel%')
-- => audio_url ILIKE '%utel%'). Birini o'zgartirsangiz — ikkalasini ham.
-- Lokal EXPLAIN ANALYZE (300 000 qator): to'rttala navbat so'rovi
-- idx_calls_utel_queue'dan foydalandi, prepared statement (generic plan
-- rejimi) bilan ham.
--
-- call_id indekslari: perf_05 (staff-stats) va perf_07 (root) join'lari
-- uchun. MASTER.sql'da bor, lekin prod'da ishga tushirilganiga kafolat
-- yo'q — "if not exists" bilan xavfsiz takrorlanadi.
--
-- CONCURRENTLY ishlatilmagan: SQL Editor skriptni tranzaksiyada bajaradi
-- (CONCURRENTLY u yerda ishlamaydi). calls ~32 000 qator — indeks soniya
-- ichida quriladi, yozish shu vaqtga qisqa kutadi.
-- ============================================================================

create index if not exists idx_calls_utel_queue
  on public.calls (created_at)
  where status <> 'done' and audio_url ilike '%utel%';

create index if not exists idx_calls_company_created_at
  on public.calls (company_id, created_at desc);

create index if not exists idx_ccs_call_id          on public.call_criteria_scores (call_id);
create index if not exists idx_lost_reasons_call_id on public.lost_reasons (call_id);
create index if not exists idx_conversions_call_id  on public.conversions (call_id);

analyze public.calls;
