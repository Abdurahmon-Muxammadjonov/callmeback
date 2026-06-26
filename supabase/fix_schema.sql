-- ============================================================
-- ProSell · Bazani backend kodi bilan to'liq moslashtirish
-- Supabase Dashboard → SQL Editor → New Query → yopishtiring → Run
-- Idempotent: bir necha marta ishlatsa ham xavfsiz, xato bermaydi.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1) USERS jadvali (CRUD API uchun) ---------------------------
CREATE TABLE IF NOT EXISTS public.users (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       TEXT NOT NULL,
    email      TEXT UNIQUE NOT NULL,
    age        INTEGER,
    phone      TEXT,
    role       TEXT NOT NULL DEFAULT 'user',
    created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);
ALTER TABLE public.users DISABLE ROW LEVEL SECURITY;

-- 2) CALLS jadvaliga yetishmayotgan ustunlarni qo'shish -------
-- analyze-call POST shu ustunlarni yozadi; ular bo'lmasa insert xato beradi.
ALTER TABLE public.calls ADD COLUMN IF NOT EXISTS kpi_score      INTEGER       NOT NULL DEFAULT 0;
ALTER TABLE public.calls ADD COLUMN IF NOT EXISTS penalty_amount NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE public.calls ADD COLUMN IF NOT EXISTS bonus_amount   NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE public.calls ADD COLUMN IF NOT EXISTS rop_comment    TEXT          NOT NULL DEFAULT 'Izoh yoq';

-- 3) PostgREST schema cache'ni yangilash ----------------------
NOTIFY pgrst, 'reload schema';
