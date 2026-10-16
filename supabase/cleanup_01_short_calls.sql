-- ============================================================================
-- JAMALS: 1 daqiqadan qisqa qo'ng'iroqlarni o'chirish. 2026-10-16.
--
-- NEGA: foydalanuvchi talabi — "bazadan 60 soniyadan kam bo'lgan audiolarni
-- o'chirib tashla, saqlama". Yangi kelganlari endi umuman saqlanmaydi
-- (src/lib/callPolicy.ts); bu skript ESKILARINI o'chiradi.
--
-- FAQAT JAMALS INTERNATIONAL ACADEMY (company_id 24823352-...). Davomiyligi
-- noma'lum (0) qo'ng'iroqlarga tegilmaydi. Bog'liq jadvallar (conversions,
-- lost_reasons, call_criteria_scores, ...) ON DELETE CASCADE/SET NULL bilan
-- o'zi tozalanadi.
--
-- ZAXIRA NUSXA: o'chirishdan oldin 13 676 qator to'liq saqlangan —
-- ~/procell-backups/jamals-short-calls-2026-10-16.json (direktor kompyuterida).
--
-- Qaytarib BO'LMAYDI. Qayta ishga tushirsa xato bermaydi (o'chiradigan narsa qolmaydi).
-- ============================================================================

with deleted as (
  delete from public.calls
  where company_id = '24823352-465e-43ea-913c-9f9d7270b9e9'
    and duration > 0
    and duration < 60
  returning id
)
select count(*) as ochirildi from deleted;
