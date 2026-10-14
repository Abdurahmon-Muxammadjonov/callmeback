// ============================================================================
// OPERATOR (XODIM) DOIRASI — 2026-10-15
//
// Foydalanuvchi talabi: telefondan kelgan har bir menejerga o'z akkaunti
// ochilsin va u kirganda FAQAT o'z qo'ng'iroqlari, audiosi, tahlili,
// skriptlari va maslahatlarini ko'rsin.
//
// Xodim tokeni (role='user') bilan kelgan so'rov:
//   - kompaniya analitikasi / boshqaruv / CRM / menejerlar ro'yxati /
//     qo'lda audio tahlili — YOPIQ (blockOperators, 403);
//   - /api/calls — faqat o'z ichki raqamidagi qo'ng'iroqlar (callsScope);
//   - mezonlar — faqat o'qish ("qanday gaplashish kerak");
//   - /api/me/* — o'z kabineti.
// Akkaunt operatorga users.operator_ext orqali bog'lanadi
// (supabase/staff_01_user_operator_ext.sql). Bog'lanmagan xodim hech qanday
// qo'ng'iroqni ko'rmaydi (bo'sh ro'yxat), boshqalarnikini emas.
// ============================================================================

import type { NextFunction, Response } from 'express';
import { supabase } from './supabase';
import { verifySessionToken } from './authToken';
import type { CompanyAuthedRequest } from '../middleware/companyAuth';

export const OPERATOR_ROLES = ['user'];

export function isOperatorRole(role: string | null | undefined): boolean {
  return OPERATOR_ROLES.includes(String(role || ''));
}

/** Xodimning ichki raqami (bog'lanmagan bo'lsa null). Admin/direktor uchun
 *  chaqirilmaydi — ular uchun cheklov yo'q. */
export async function operatorExtOf(userId: string, companyId: string): Promise<string | null> {
  const { data, error } = await supabase
    .from('users')
    .select('operator_ext')
    .eq('id', userId)
    .eq('company_id', companyId)
    .maybeSingle();
  if (error) throw new Error(`Database Error: ${error.message}`);
  const ext = String((data as any)?.operator_ext ?? '').trim();
  return ext || null;
}

/** So'rov uchun qo'ng'iroqlar doirasi:
 *   null            — cheklov yo'q (direktor/admin);
 *   { ext: '105' }  — faqat shu raqam;
 *   { ext: null }   — xodim, lekin operatorga bog'lanmagan: hech narsa. */
export async function callsScope(req: CompanyAuthedRequest): Promise<{ ext: string | null } | null> {
  if (!isOperatorRole(req.auth?.role)) return null;
  return { ext: await operatorExtOf(req.auth!.userId, req.auth!.companyId as string) };
}

/**
 * Xodim tokeni bilan kirish taqiqlangan bo'limlar uchun (server.ts'da mount
 * qilinadi). Tokensiz so'rov o'tkaziladi — uni router'ning o'z requireAuth'i
 * 401 bilan rad etadi (webhook kabi tokensiz endpointlar ham buzilmaydi).
 * `allow` — xodimga ochiq istisnolar (metod + yo'l).
 */
export function blockOperators(allow: (method: string, path: string) => boolean = () => false) {
  return (req: CompanyAuthedRequest, res: Response, next: NextFunction): void => {
    const h = req.headers.authorization;
    if (!h || !h.startsWith('Bearer ')) return next();
    const payload = verifySessionToken(h.slice('Bearer '.length).trim());
    if (!payload || !isOperatorRole(payload.role)) return next();
    if (allow(req.method, req.path)) return next();
    res.status(403).json({ success: false, error: "Bu bo'lim faqat direktor/admin uchun." });
  };
}
