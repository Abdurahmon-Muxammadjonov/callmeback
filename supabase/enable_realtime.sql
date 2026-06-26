-- ============================================================
-- Prosell · Supabase Realtime'ni yoqish (instant sync)
-- Staff (users) + bildirishnoma + smena hodisalari uchun.
-- Supabase Dashboard → SQL Editor → Run. Idempotent.
-- ============================================================

-- 1) REPLICA IDENTITY FULL — UPDATE payload'ida BARCHA ustunlarning eski qiymati
--    keladi (faqat PK emas). first_name/shift_start o'zgarishini taqqoslash uchun shart.
alter table public.users               replica identity full;
alter table public.user_notifications  replica identity full;
alter table public.shift_events        replica identity full;

-- 2) supabase_realtime PUBLICATION ga jadvallarni qo'shish (idempotent).
--    Qo'shilgan bo'lsa qayta qo'shmaydi — "already member" xatosi chiqmaydi.
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'users') then
    alter publication supabase_realtime add table public.users;
  end if;
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'user_notifications') then
    alter publication supabase_realtime add table public.user_notifications;
  end if;
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'shift_events') then
    alter publication supabase_realtime add table public.shift_events;
  end if;
end $$;

-- Tekshirish (ixtiyoriy): qaysi jadvallar realtime'da
-- select schemaname, tablename from pg_publication_tables where pubname = 'supabase_realtime';
