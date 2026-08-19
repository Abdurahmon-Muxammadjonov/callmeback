import type { NextFunction, Request, Response } from 'express';
import { supabaseAdmin } from '../lib/supabaseAdmin';

export interface AuthContext {
  userId: string;
  companyId: string;
  role: 'owner' | 'admin' | 'manager' | 'agent';
}

export interface AuthedRequest extends Request {
  auth?: AuthContext;
}

/* =============================================================================
 * JWT custom claims vs har-so'rovda DB lookup — qaysi biri yaxshiroq?
 * =============================================================================
 * Ikkala yondashuv ham to'g'ri, lekin turli narsani optimallashtiradi:
 *
 * 1) Har so'rovda public.users'dan o'qish (bu faylda ASOSIY yo'l sifatida
 *    ishlatilgan):
 *    + Har doim YANGI ma'lumot — role o'zgartirilsa, KEYINGI so'rovdayoq
 *      kuchga kiradi (masalan admin huquqi olib tashlangan xodim darhol
 *      cheklanadi).
 *    - Har himoyalangan endpoint uchun +1 qo'shimcha DB so'rov (latency + load).
 *
 * 2) company_id/role'ni JWT'ning custom claims'iga yozib qo'yish (Supabase
 *    "Access Token Hook" orqali — token yaratilganda/yangilanganda Postgres
 *    funksiya chaqirilib, claims'ga qo'shiladi):
 *    + Qo'shimcha DB so'rov YO'Q — JWT imzosini tekshirish kifoya, tezroq
 *      va DB yukini kamaytiradi (ayniqsa yuqori trafikda muhim).
 *    - ESKIRGAN bo'lishi mumkin: JWT odatda 1 soatgacha amal qiladi — agar
 *      admin xodimning rolini yoki company'sini o'zgartirsa, o'sha xodim
 *      ESKI (noto'g'ri) huquq bilan token muddati tugagunicha yoki majburiy
 *      refresh qilinmaguncha ishlayveradi. Bu ayniqsa RUXSATNI OLIB TASHLASH
 *      holatida xavfsizlik muammosi (masalan buzilgan/ishdan bo'shatilgan
 *      xodimning admin huquqi darhol o'chishi kerak).
 *
 * TAVSIYA (shu implementatsiyada qo'llangan): GIBRID.
 *   - company_id — JWT custom claim'ga qo'yish uchun XAVFSIZ nomzod (bir
 *     xodim deyarli hech qachon boshqa tenant'ga ko'chmaydi, eskirish
 *     xavfi past).
 *   - role — DB'dan HAR SAFAR o'qiladi (yoki juda qisqa TTL — 30s — bilan
 *     keshlanadi, pastga qarang), chunki role o'zgarishi darhol kuchga
 *     kirishi xavfsizlik uchun muhimroq, DB so'rovi qo'shimcha xarajatidan.
 *   - RLS (Postgres darajasida) har doim ISHLAYDI — bu yerdagi middleware
 *     faqat ilova darajasidagi QO'SHIMCHA qatlam (defense in depth): hatto
 *     middleware'da xato bo'lsa ham, RLS boshqa tenant ma'lumotini
 *     chiqarib yubormaydi.
 * ============================================================================= */

interface CachedProfile {
  companyId: string;
  role: AuthContext['role'];
  expiresAt: number;
}

// Juda qisqa muddatli (30s) in-memory kesh — har so'rovda DB'ga urish bilan
// "role o'zgarishi darhol kuchga kirsin" talabi orasidagi murosa. Rol
// o'zgartirilganda invalidateProfileCache() chaqirilib, kesh darhol
// tozalanadi — shu sabab 30s faqat "chaqirilmagan" holatlar uchun.
const profileCache = new Map<string, CachedProfile>();
const PROFILE_CACHE_TTL_MS = 30_000;

export function invalidateProfileCache(userId: string): void {
  profileCache.delete(userId);
}

async function loadProfile(userId: string): Promise<{ companyId: string; role: AuthContext['role'] } | null> {
  const cached = profileCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    return { companyId: cached.companyId, role: cached.role };
  }

  const { data, error } = await supabaseAdmin()
    .from('users')
    .select('company_id, role')
    .eq('id', userId)
    .maybeSingle();

  if (error || !data) return null;

  profileCache.set(userId, {
    companyId: data.company_id,
    role: data.role,
    expiresAt: Date.now() + PROFILE_CACHE_TTL_MS,
  });

  return { companyId: data.company_id, role: data.role };
}

/**
 * Barcha himoyalangan route'larda birinchi bo'lib ishlaydi:
 *   1. Authorization: Bearer <jwt> headerini o'qiydi
 *   2. Supabase Auth orqali tokenni tekshiradi (imzo + muddat)
 *   3. public.users'dan (yoki keshdan) company_id/role'ni topadi
 *   4. req.auth ga { userId, companyId, role } yozib qo'yadi
 */
export async function withAuth(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ success: false, error: 'Authorization header (Bearer token) talab qilinadi.' });
    return;
  }

  const token = authHeader.slice('Bearer '.length).trim();
  const { data: userData, error: userErr } = await supabaseAdmin().auth.getUser(token);

  if (userErr || !userData?.user) {
    res.status(401).json({ success: false, error: "Token yaroqsiz yoki muddati tugagan." });
    return;
  }

  const profile = await loadProfile(userData.user.id);
  if (!profile) {
    // auth.users'da bor, lekin public.users'da profil yo'q — masalan
    // register oqimi yarim tugagan yoki qo'lda o'chirilgan.
    res.status(403).json({ success: false, error: "Profil topilmadi — kompaniyaga biriktirilmagan foydalanuvchi." });
    return;
  }

  req.auth = { userId: userData.user.id, companyId: profile.companyId, role: profile.role };
  next();
}
