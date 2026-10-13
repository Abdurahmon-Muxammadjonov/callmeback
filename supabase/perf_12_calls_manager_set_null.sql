-- ============================================================================
-- Xodim o'chirilsa qo'ng'iroqlari O'CHMASIN (ON DELETE SET NULL). 2026-10-13.
--
-- NEGA: add_call_summary.sql (2026-09) calls.manager_id ni
-- "on delete cascade" qilgan edi — xodim o'chirilsa uning BUTUN tarixdagi
-- qo'ng'iroqlari (audio, tahlil, ball) ham o'chardi va o'tgan kunlar,
-- haftalar, oylar soni birdan kamayardi ("raqamlar o'zidan o'zgardi").
-- Foydalanuvchi qarori (2026-10-13): qo'ng'iroqlar qolsin.
--
-- Endi xodim o'chirilsa qo'ng'iroqdagi manager_id NULL bo'ladi, operator_ext
-- (ichki raqam) qoladi — hisobotda "Operator 108" (virtual operator) bo'lib
-- ko'rinadi; shu raqamli yangi xodim qo'shilsa avtomatik unga bog'lanadi
-- (routes/managers.ts linkCallsToManager).
--
-- Cheklov nomi prod'da boshqacha bo'lishi mumkinligi uchun calls.manager_id
-- dagi BARCHA managers'ga ishora qiluvchi FK topilib almashtiriladi.
-- Qayta ishga tushirsa xato bermaydi. Ma'lumotga tegmaydi.
-- ============================================================================

do $$
declare r record;
begin
  for r in
    select con.conname
    from pg_constraint con
    join pg_attribute att on att.attrelid = con.conrelid and att.attnum = any (con.conkey)
    where con.conrelid = 'public.calls'::regclass
      and con.contype = 'f'
      and con.confrelid = 'public.managers'::regclass
      and att.attname = 'manager_id'
  loop
    execute format('alter table public.calls drop constraint %I', r.conname);
  end loop;
end $$;

alter table public.calls
  add constraint calls_manager_id_fkey
  foreign key (manager_id) references public.managers(id) on delete set null;

notify pgrst, 'reload schema';
