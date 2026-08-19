import jwt from 'jsonwebtoken';

// Bu ilovaning haqiqiy login oqimi (POST /users/login, POST /auth/register*)
// Supabase Auth (auth.users) ISHLATMAYDI — o'ziga xos public.users jadvali +
// bcrypt bilan ishlaydi, frontend esa hozircha faqat localStorage'da sodda
// {role,email,name} sessiyasini saqlaydi, hech qanday tekshiriladigan token
// yubormaydi. src/multi-tenant/middleware/withAuth.ts esa Supabase Auth JWT
// kutadi — bu yerga TO'G'RI KELMAYDI.
//
// Shu sabab bu yerda ALOHIDA, ODDIY va HAQIQIY tizimga mos yengil JWT
// qo'llanadi: login/register muvaffaqiyatli bo'lganda backend shu tokenni
// qaytaradi, frontend uni saqlab, keyingi so'rovlarda
// `Authorization: Bearer <token>` sifatida yuboradi (companyAuth.ts buni
// tekshiradi). Bu — Supabase Auth emas, oddiy imzolangan JWT (server sirri
// bilan) — RLS'ga bog'liq emas, faqat ilova darajasidagi middleware orqali
// ishlaydi (defense-in-depth uchun RLS keyinchalik alohida qo'shilishi mumkin).

const JWT_SECRET = process.env.AUTH_JWT_SECRET;
const TOKEN_TTL = '30d';

export interface SessionTokenPayload {
  sub: string;          // users.id
  company_id: string | null;
  role: string;
}

export function signSessionToken(payload: SessionTokenPayload): string {
  if (!JWT_SECRET) {
    throw new Error('AUTH_JWT_SECRET .env da sozlanmagan.');
  }
  return jwt.sign(payload, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

export function verifySessionToken(token: string): SessionTokenPayload | null {
  if (!JWT_SECRET) return null;
  try {
    return jwt.verify(token, JWT_SECRET) as SessionTokenPayload & jwt.JwtPayload;
  } catch {
    return null;
  }
}
