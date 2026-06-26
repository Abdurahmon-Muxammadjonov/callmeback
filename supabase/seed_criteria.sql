-- ============================================================
-- 8 ta skript bosqichini baholash mezoni sifatida criteria ga qo'shish.
-- Idempotent: title mavjud bo'lsa qayta qo'shmaydi. Qayta Run qilsa xavfsiz.
-- ============================================================

insert into public.criteria (title, description, category, weight, type, penalty_amount, is_active)
select v.title, v.description, v.category, v.weight, v.type, 0, true
from (values
  ('Tayyorgarlik va Salomlashish',
   'Energiyali, yordamchi ohang. Ism va ''Axror Abrooriyev jamoasi''dan ekanini aytish. Lid manbasini (''brend sahifamizga qoldirilgan so''rov'') eslatib, tasdiq uchun strategik pauza qilish.',
   'Ochilish', 10, 'Majburiy'),
  ('Filtrlash',
   'Filtr savolini berish: ''Kurs haqida ma''lumot olmoqchimisiz yoki biznesda qatnashmoqchimisiz?''. Mijozning kasbi/niche''ini aniqlab, mos kelishini tekshirish. Mos kelmasa, suhbatni professional qisqartirish.',
   'Ochilish', 10, 'Majburiy'),
  ('Programmalashtirish',
   'Suhbatni boshqarishga ruxsat olish: ''Suhbatimiz faloncha daqiqa bo''ladi... savollar beraman va oxirida birgalikda qaror qabul qilamiz. Kelishdikmi?''',
   'Ochilish', 10, 'Majburiy'),
  ('Ehtiyojni aniqlash (A nuqta)',
   'A nuqtani (hozirgi holat/muammolar) va B nuqtani (sentyabrga maqsad, daromad istaklari) aniqlash.',
   'Ehtiyoj aniqlash', 15, 'Majburiy'),
  ('SPIN — A dan B nuqtaga',
   'Yashirin ehtiyoj va to''siqlarni ochish: ''O''zingiz mustaqil bunga erisholmayapsizmi? To''siq nima?'' degan savollar bilan chuqurlashish.',
   'Ehtiyoj aniqlash', 15, 'Majburiy'),
  ('Taqdimot',
   'Mijoz ehtiyojiga mos kurs modullarini taklif qilish (Standard: 5M, Premium: 12M, VIP: 25M UZS). Narxga e''tibor qaratuvchi mijozga narxdan oldin qiymatni bog''lash.',
   'Taqdimot', 15, 'Majburiy'),
  ('E''tirozlar bilan ishlash',
   '''Qabul qilish + Argument + Taklif'' formulasini qat''iy qo''llash. ''Qimmat'', ''O''ylab ko''raman'', ''Pulim yo''q'' kabi e''tirozlarni shu ketma-ketlik bilan yopish.',
   'Yopish', 15, 'Majburiy'),
  ('Yopish va Bron',
   'Majburiyat yoki bron/depozit (Bron: 1 500 000 UZS) so''rash va muddat belgilash.',
   'Yopish', 10, 'Majburiy')
) as v(title, description, category, weight, type)
where not exists (select 1 from public.criteria c where c.title = v.title);

notify pgrst, 'reload schema';
