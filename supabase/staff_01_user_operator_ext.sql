-- ============================================================================
-- users.operator_ext — xodim akkaunti ↔ telefoniyadagi operator. 2026-10-15.
--
-- NEGA: foydalanuvchi talabi — telefondan (UTel) kelgan har bir menejerga
-- o'z nomi bilan akkaunt ochilsin va u kirganda FAQAT o'z qo'ng'iroqlari,
-- audiosi, tahlili, skriptlari va maslahatlarini ko'rsin. Buning uchun
-- akkaunt (public.users) qaysi operatorga tegishli ekani saqlanishi kerak.
--
-- NEGA managers.id EMAS, ICHKI RAQAM: UTel operatorlari public.managers
-- jadvalida yo'q — ular qo'ng'iroqlardagi calls.operator_ext dan hosil
-- qilinadigan "virtual" operatorlar (src/lib/virtualOperators.ts). Qo'ng'iroq
-- ham, tahlil ham, tavsiyalar (operator_insights.operator_ext) ham ichki
-- raqam bo'yicha yoziladi — bog'lanish uchun eng ishonchli kalit shu.
-- Backend xodim tokeni bilan kelgan so'rovlarni shu raqam orqali faqat
-- o'z ma'lumotiga cheklaydi (src/lib/operatorScope.ts).
--
-- Bir kompaniyada bitta raqamga bitta akkaunt (unique) — bir qo'ng'iroqlar
-- to'plami ikki kishiga ko'rinmasin.
--
-- Qayta ishga tushirsa xato bermaydi.
-- ============================================================================

alter table public.users
  add column if not exists operator_ext text;

create unique index if not exists users_company_operator_ext_uniq
  on public.users(company_id, operator_ext) where operator_ext is not null;

notify pgrst, 'reload schema';

-- Tekshiruv: ustun borligini ko'rsatadi (1 qator chiqishi kerak).
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'users' and column_name = 'operator_ext';
