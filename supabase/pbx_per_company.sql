-- ============================================================
-- PBX ulanishini KOMPANIYAGA bog'lash (multi-tenant izolyatsiya).
-- Supabase Dashboard -> SQL Editor -> Run. Idempotent.
--
-- Muammo (2026-09-20): crm_integrations GLOBAL edi (bitta qator, hamma
-- uchun), PBX webhook'idan kelgan qo'ng'iroq/xodimlar company_id=NULL
-- bilan yozilardi. Natijada har bir kompaniya BOSHQA kompaniyalarning
-- xodimlari va natijalarini ko'rar edi (yoki hech kim ko'rmasdi).
--
-- Yechim: har kompaniya o'z PBX'ini (webhook_url + api_key) ulaydi;
-- webhook kelganda api_key -> company_id topiladi va o'sha kompaniyaning
-- qo'ng'iroq/xodimlari sifatida yoziladi. calls.company_id / managers.
-- company_id ustunlari allaqachon bor (company_branding.sql).
-- ============================================================

-- 1) crm_integrations har kompaniyaga tegishli bo'lishi uchun company_id.
--    NULLABLE: mavjud (legacy) global qator company_id=NULL bo'lib qoladi,
--    uni buzmaymiz — faqat yangi ulanishlar company_id bilan yoziladi.
alter table public.crm_integrations
  add column if not exists company_id uuid references public.companies(id) on delete cascade;

-- Har kompaniyaga ko'pi bilan bitta faol integratsiya (webhook kelganda
-- company bo'yicha bitta qator topilsin). Legacy NULL qatorga ta'sir qilmaydi.
create unique index if not exists uq_crm_integrations_company
  on public.crm_integrations(company_id) where company_id is not null;

-- api_key bo'yicha tez qidirish (webhook har chaqiruvda api_key -> company).
create index if not exists idx_crm_integrations_api_key
  on public.crm_integrations(api_key);

-- 2) managers: bitta kompaniya ichida pbx_id / ism takrorlanmasin (dublikat
--    oldini olish uchun), lekin HAR XIL kompaniyada bir xil "101" extension
--    yoki bir xil ism bo'lishi MUMKIN — shu sabab unique (company_id, pbx_id).
create unique index if not exists uq_managers_company_pbx
  on public.managers(company_id, pbx_id) where pbx_id is not null and company_id is not null;

-- 3) criteria (baholash mezonlari) HAR KOMPANIYAGA alohida bo'lsin —
--    yangi kompaniya 0 mezon bilan boshlaydi, o'zi qo'shib oladi, boshqa
--    kompaniyaning mezonlari aralashmaydi. NULLABLE: mavjud (global,
--    tenant'siz) mezonlar company_id=NULL bo'lib legacy qoladi va yangi
--    kompaniyalarga KO'RINMAYDI (aynan talab qilingandek). "Mezon
--    kategoriyalari" alohida jadval emas — criteria.category matn ustuni,
--    shu sabab u ham avtomatik kompaniya bilan cheklanadi.
alter table public.criteria
  add column if not exists company_id uuid references public.companies(id) on delete cascade;
create index if not exists idx_criteria_company_id on public.criteria(company_id);

-- 4) ESKI global unique'ni O'CHIRISH (2026-09-23 blocker): managers'da
--    avval faqat pbx_id bo'yicha unique bor edi (uq_managers_pbx_id) — u
--    bir xil ichki raqam (masalan "108") BUTUN bazada faqat BITTA
--    kompaniyada bo'lishini majburlaydi. Multi-tenant'da har kompaniyaning
--    o'z "108"i bo'lishi kerak; yuqoridagi (2-band) uq_managers_company_pbx
--    shuni ta'minlaydi. Eski globalni olib tashlaymiz (index ham, constraint
--    ham bo'lishi mumkin — ikkalasini ham `if exists` bilan).
drop index if exists public.uq_managers_pbx_id;
alter table public.managers drop constraint if exists uq_managers_pbx_id;

notify pgrst, 'reload schema';
