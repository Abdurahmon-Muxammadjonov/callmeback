-- ============================================================================
-- company_virtual_operators — GET /managers ichidagi listVirtualOperators.
-- 2026-10-12. Mustaqil fayl (perf_01'ga bog'liq emas).
--
-- NEGA: "virtual operator"lar (xodimga biriktirilmagan, lekin gaplashgan
-- ichki raqamlar) kompaniyaning BUTUN tarixidagi xodimsiz qo'ng'iroqlarni
-- fetchAllRows bilan tortib (15 000+ qator) Node'da guruhlab topilardi —
-- har safar xodimlar ro'yxati ochilganda. Endi: group by bazada.
--
-- Natija jsonb massiv: [{ext, count, first}], count bo'yicha kamayish tartibida.
--   - faqat manager_id IS NULL va operator_ext bo'sh emas;
--   - ext — boshidagi/oxiridagi bo'shliqlar kesilgan ichki raqam (eski
--     String(...).trim() bilan bir xil); kesilgandan keyin bo'sh => tashlanadi;
--   - first — eng birinchi qo'ng'iroq vaqti (min(created_at)).
-- id/ism/status kabi maydonlar Node'da (virtualManagerId) — JSON avvalgidek.
--
-- FARQ: teng count'li operatorlar tartibi avval tasodifiy edi (qatorlar
-- kelgan tartib); endi ext bo'yicha barqaror.
--
-- Xavfsizlik: faqat service_role (backend) chaqira oladi.
-- ============================================================================

create or replace function public.company_virtual_operators(p_company_id uuid)
returns jsonb
language sql
stable
as $$
  select coalesce(jsonb_agg(jsonb_build_object('ext', ext, 'count', n, 'first', first_at)
                            order by n desc, ext), '[]'::jsonb)
  from (
    select regexp_replace(c.operator_ext, '^\s+|\s+$', '', 'g') as ext,
           count(*)                                              as n,
           min(c.created_at)                                     as first_at
    from public.calls c
    where c.company_id = p_company_id
      and c.manager_id is null
      and c.operator_ext is not null
    group by 1
  ) g
  where g.ext <> '';
$$;

revoke execute on function public.company_virtual_operators(uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    revoke execute on function public.company_virtual_operators(uuid) from anon;
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    revoke execute on function public.company_virtual_operators(uuid) from authenticated;
  end if;
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.company_virtual_operators(uuid) to service_role;
  end if;
end $$;

notify pgrst, 'reload schema';
