-- ============================================================
-- Reviziya 3 — foydalanuvchi so'ragan qo'shimcha talablar:
--   1. tariffs.price endi XODIMGA (per-employee) narx sifatida talqin
--      qilinadi — umumiy narx = tariffs.price * employee_count. "Kalit
--      olish"da xodimlar soni so'raladi va saqlanadi; "Tarifni
--      o'zgartirish"da QAYTA SO'RALMAYDI — oxirgi subscriptions
--      qatoridan (employee_count) olinadi.
--   2. unlock_codes muddati 30 daqiqadan 1 SOATGA o'zgartirildi.
--   3. "Kalit olish" va "Tarifni o'zgartirish" ENDI IKKI XIL to'lov
--      kartasidan foydalanadi (Node tomonida, tariffFlow.ts) — SQL'ga
--      aloqasi yo'q.
-- Supabase Dashboard -> SQL Editor -> Run. Idempotent.
-- ============================================================

alter table public.key_requests           add column if not exists employee_count integer not null default 1 check (employee_count >= 1);
alter table public.tariff_change_requests add column if not exists employee_count integer not null default 1 check (employee_count >= 1);
alter table public.subscriptions          add column if not exists employee_count integer not null default 1 check (employee_count >= 1);

create or replace function public.approve_key_request(p_request_id uuid, p_admin_telegram_id text)
returns jsonb
language plpgsql
as $$
declare
  v_req     public.key_requests%rowtype;
  v_tariff  public.tariffs%rowtype;
  v_code    text;
  v_paid_at timestamptz := now();
begin
  select * into v_req from public.key_requests where id = p_request_id for update;
  if not found then
    raise exception 'REQUEST_NOT_FOUND';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'REQUEST_ALREADY_RESOLVED';
  end if;

  select * into v_tariff from public.tariffs where id = v_req.tariff_id;
  if not found then
    raise exception 'TARIFF_MISSING';
  end if;

  update public.key_requests
     set status = 'approved',
         paid_amount = v_req.quoted_price,
         resolved_by = p_admin_telegram_id,
         resolved_at = now()
   where id = p_request_id;

  update public.companies set tariff_id = v_tariff.id where id = v_req.company_id;

  insert into public.subscriptions (company_id, full_name, phone, tariff_id, paid_amount, paid_at, expires_at, employee_count)
  values (v_req.company_id, v_req.full_name, public.normalize_phone(v_req.phone), v_tariff.id, v_req.quoted_price, v_paid_at, v_paid_at + interval '30 days', v_req.employee_count);

  -- Reviziya 3, band 2: 30 daqiqa -> 1 soat.
  v_code := public.issue_unlock_code(v_req.company_id, v_tariff.id, p_request_id, now() + interval '1 hour');

  return jsonb_build_object('company_id', v_req.company_id, 'telegram_id', v_req.telegram_id, 'tariff_name', v_tariff.name, 'code', v_code);
end;
$$;

create or replace function public.approve_tariff_change_request(p_request_id uuid, p_admin_telegram_id text)
returns jsonb
language plpgsql
as $$
declare
  v_req     public.tariff_change_requests%rowtype;
  v_tariff  public.tariffs%rowtype;
  v_code    text;
  v_paid_at timestamptz := now();
begin
  select * into v_req from public.tariff_change_requests where id = p_request_id for update;
  if not found then
    raise exception 'REQUEST_NOT_FOUND';
  end if;
  if v_req.status <> 'pending' then
    raise exception 'REQUEST_ALREADY_RESOLVED';
  end if;

  select * into v_tariff from public.tariffs where id = v_req.new_tariff_id;
  if not found then
    raise exception 'TARIFF_MISSING';
  end if;

  update public.tariff_change_requests
     set status = 'approved', resolved_by = p_admin_telegram_id, resolved_at = now()
   where id = p_request_id;

  update public.companies set tariff_id = v_tariff.id where id = v_req.company_id;

  insert into public.subscriptions (company_id, full_name, phone, tariff_id, paid_amount, paid_at, expires_at, employee_count)
  values (v_req.company_id, v_req.full_name, public.normalize_phone(v_req.phone), v_tariff.id, v_req.final_price, v_paid_at, v_paid_at + interval '30 days', v_req.employee_count);

  -- Reviziya 3, band 2: 30 daqiqa -> 1 soat.
  v_code := public.issue_unlock_code(v_req.company_id, v_tariff.id, p_request_id, now() + interval '1 hour');

  return jsonb_build_object('company_id', v_req.company_id, 'telegram_id', v_req.telegram_id, 'tariff_name', v_tariff.name, 'code', v_code);
end;
$$;

notify pgrst, 'reload schema';
