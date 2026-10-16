-- ============================================================================
-- users.password_enc — xodim parolining SHIFRLANGAN nusxasi. 2026-10-16.
--
-- NEGA: foydalanuvchi talabi — "Xodimlarni boshqarish"da xodimga yozilgan
-- parol sozlamalar qayta ochilganda o'chib ketmasin, ko'rinib tursin.
-- Login avvalgidek faqat password_hash (bcrypt) bilan tekshiriladi; bu ustun
-- faqat direktor/admin uchun ko'rsatish maqsadida, AES-256-GCM bilan
-- shifrlangan (kalit serverda, bazada ochiq matn yo'q) — src/lib/passwordVault.ts.
-- Ustun bo'lmasa ham tizim ishlaydi (parol shunchaki ko'rinmaydi).
--
-- Qayta ishga tushirsa xato bermaydi.
-- ============================================================================

alter table public.users
  add column if not exists password_enc text;

notify pgrst, 'reload schema';

-- Tekshiruv: 1 qator chiqishi kerak.
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'users' and column_name = 'password_enc';
