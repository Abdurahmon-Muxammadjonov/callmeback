-- ============================================================================
-- calls.operator_ext — qo'ng'iroqni bajargan operatorning PBX ICHKI RAQAMI
-- (masalan '100', '108'). 2026-09-23.
--
-- NEGA KERAK:
-- Qo'ng'iroq endi XODIM YARATMASDAN yoziladi (avval PBX'dan kelgan har bir
-- raqam uchun avtomatik "xodim" yaratilar, natijada mijozlarning telefon
-- raqamlari "xodim" bo'lib ro'yxatni to'ldirib yuborgan edi). Endi ichki
-- raqam qo'ng'iroqning o'zida saqlanadi; kompaniya o'sha ichki raqamli
-- xodimni qo'shganda (managers.pbx_id), shu raqamli va hali hech kimga
-- biriktirilmagan qo'ng'iroqlar avtomatik unga bog'lanadi.
--
-- calls.pbx_id BU MAQSADGA YARAMAYDI: unda UNIQUE cheklov bor
-- (uq_calls_pbx_id — u PBX qo'ng'iroq ID'si uchun), ya'ni bitta operatorning
-- ikkinchi qo'ng'irog'i "duplicate key" bilan saqlanmay qolardi.
--
-- Xavfsiz: faqat qo'shadi, hech narsani o'chirmaydi/o'zgartirmaydi.
-- Qayta ishga tushirsa ham xato bermaydi (if not exists).
-- ============================================================================

alter table public.calls
  add column if not exists operator_ext text;

comment on column public.calls.operator_ext is
  'Operatorning PBX ichki raqami (masalan 100, 108). Xodim qo''shilganda managers.pbx_id bilan solishtirilib bog''lanadi.';

-- Xodim qo'shilganda "shu ichki raqamli, biriktirilmagan qo'ng'iroqlar"
-- bo'yicha yangilash tez ishlashi uchun.
create index if not exists idx_calls_company_operator_ext
  on public.calls (company_id, operator_ext)
  where operator_ext is not null;
