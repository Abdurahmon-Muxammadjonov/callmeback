-- ============================================================
-- Prosell · Dashboard uchun Supabase Realtime'ni yoqish
-- (calls + managers) — frontend 10 soniyalik polling o'rniga
-- to'g'ridan-to'g'ri Supabase Realtime orqali yangilanishi uchun.
-- Supabase Dashboard → SQL Editor → Run. Idempotent.
-- ============================================================

-- 1) REPLICA IDENTITY FULL — UPDATE payload'ida barcha ustunlarning
--    eski qiymati kelishi uchun (masalan status: processing → done).
alter table public.calls    replica identity full;
alter table public.managers replica identity full;

-- 2) supabase_realtime PUBLICATION ga qo'shish (idempotent).
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'calls') then
    alter publication supabase_realtime add table public.calls;
  end if;
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'managers') then
    alter publication supabase_realtime add table public.managers;
  end if;
end $$;

-- Tekshirish (ixtiyoriy):
-- select schemaname, tablename from pg_publication_tables where pubname = 'supabase_realtime';
