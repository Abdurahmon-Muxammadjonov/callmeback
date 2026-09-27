-- ============================================================================
-- API v2, 1-BOSQICH: operator_insights jadvali
--
-- NEGA: hozir /api/analytics/staff-stats GET so'rovi ICHIDA har bir operator
-- uchun GPT chaqiriladi — o'lchandi, 7.4 soniya. Ish buyrug'i §0.4 va §6.5:
-- hech bir GET LLM chaqirmasligi kerak; AI matni fon jobida tayyorlanadi va
-- jadvaldan o'qiladi.
--
-- Bu migratsiya QO'SHIMCHA va IDEMPOTENT (G4): mavjud hech narsaga tegmaydi.
-- calls jadvaliga tegmaydi, shuning uchun qulflanish xatari yo'q — istalgan
-- vaqtda ishga tushirish mumkin.
--
-- Shakl §4 dan: company_id, operator_ext, items_uz, items_ru, generated_at,
-- based_on_calls. Qo'shimcha: model (xarajat kuzatuvi uchun), based_on_days.
-- ============================================================================

CREATE TABLE IF NOT EXISTS operator_insights (
  company_id      uuid        NOT NULL,
  operator_ext    text        NOT NULL,
  -- Har biri 3 ta qator: ["...", "...", "..."]. Til bo'yicha alohida,
  -- chunki Appendix A javobni so'rov tilida qaytarishni talab qiladi.
  items_uz        jsonb,
  items_ru        jsonb,
  generated_at    timestamptz NOT NULL DEFAULT now(),
  -- Tavsiya nechta baholangan qo'ng'iroq asosida yozilgani (UI ko'rsatadi).
  based_on_calls  integer     NOT NULL DEFAULT 0,
  based_on_days   smallint    NOT NULL DEFAULT 7,
  model           text,
  PRIMARY KEY (company_id, operator_ext)
);

COMMENT ON TABLE operator_insights IS
  'Operator uchun "TUZATISH YO''LI" tavsiyalari. Fon jobi to''ldiradi (GPT-4o-mini), GET so''rovlari faqat O''QIYDI.';

-- Ro'yxat so'rovlari uchun: bitta kompaniyaning hamma operatorlari.
CREATE INDEX IF NOT EXISTS operator_insights_company_idx
  ON operator_insights (company_id);

-- ============================================================================
-- TEKSHIRUV (ishga tushirgandan keyin)
--   select count(*) from operator_insights;              -- 0 bo'lishi kerak
--   \d operator_insights                                  -- ustunlar
-- Jadval bo'sh bo'lsa staff-stats "advice": null qaytaradi va UI
-- "Tavsiya tayyorlanmoqda…" ko'rsatadi — xato bermaydi.
-- ============================================================================
