-- ============================================================
-- Kompaniya asosidagi ro'yxatdan o'tish (PROMPT_BACKEND_COMPANY_AUTH.md)
-- Supabase Dashboard -> SQL Editor -> Run. Idempotent.
-- ============================================================

create table if not exists public.companies (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  invite_code text unique not null,
  created_at  timestamptz not null default now()
);

alter table public.users
  add column if not exists company_id uuid references public.companies(id) on delete set null;
create index if not exists idx_users_company_id on public.users(company_id);

-- 9 belgili, katta harf+raqamli invite_code (0/O/1/I chalkashligi uchun
-- chiqarib tashlangan — xodimlar buni qo'lda terib kiritadi).
create or replace function public.generate_invite_code()
returns text
language plpgsql
as $$
declare
  chars  text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  result text;
  i      int;
begin
  loop
    result := '';
    for i in 1..9 loop
      result := result || substr(chars, floor(random() * length(chars) + 1)::int, 1);
    end loop;
    exit when not exists (select 1 from public.companies where invite_code = result);
  end loop;
  return result;
end;
$$;

alter table public.companies alter column invite_code set default public.generate_invite_code();

notify pgrst, 'reload schema';
