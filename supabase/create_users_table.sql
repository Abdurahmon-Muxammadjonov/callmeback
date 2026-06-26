-- ============================================================
-- USERS jadvalini yaratish (CRUD API uchun)
-- Buni Supabase Dashboard → SQL Editor ga yopishtirib RUN bosing.
-- Idempotent: qayta-qayta ishlatsa ham xavfsiz.
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE IF NOT EXISTS public.users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name          TEXT NOT NULL,
    email         TEXT UNIQUE NOT NULL,
    age           INTEGER,
    phone         TEXT,
    role          TEXT NOT NULL DEFAULT 'user',
    password_hash TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);

-- Eski jadvalga password_hash ustunini qo'shish (idempotent)
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS password_hash TEXT;

-- RLS: server service_role/secret kalit bilan ulanadi va RLS ni aylanib o'tadi,
-- shuning uchun bu jadval uchun RLS shart emas. Aniqlik uchun o'chirib qo'yamiz.
ALTER TABLE public.users DISABLE ROW LEVEL SECURITY;

-- PostgREST schema cache'ni darhol yangilash (jadval yangi yaratilganda kerak).
NOTIFY pgrst, 'reload schema';
