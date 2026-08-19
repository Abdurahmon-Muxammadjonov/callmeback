import type { NextFunction, Request, Response } from 'express';
import { verifySessionToken } from '../lib/authToken';

export interface CompanyAuthContext {
  userId: string;
  companyId: string | null;
  role: string;
}

export interface CompanyAuthedRequest extends Request {
  auth?: CompanyAuthContext;
}

/**
 * POST /users/login va POST /auth/register* endpoint'lari muvaffaqiyatli
 * bo'lganda qaytaradigan session tokenini tekshiradi. company_id/role'ni
 * shu tokendan oladi — DB'ga qo'shimcha so'rov shart emas (token allaqachon
 * login paytida DB'dan o'qib imzolangan).
 *
 * DIQQAT (xuddi src/multi-tenant/middleware/withAuth.ts'dagi kabi): role
 * o'zgarsa (masalan xodim admin qilinsa/olib tashlansa), ESKI token muddati
 * tugaguncha (30 kun) eski rol bilan ishlayveradi — chunki bu statless JWT,
 * server tomonda "bekor qilingan tokenlar" ro'yxati yuritilmaydi. Hozircha
 * bu ilova uchun qabul qilingan cheklov (rol o'zgarishi kamdan-kam va kam
 * xavfli holat); productionga chiqishdan oldin kerak bo'lsa qisqaroq TTL +
 * refresh oqimi yoki server-side revocation ro'yxati qo'shish mumkin.
 */
export function requireAuth(req: CompanyAuthedRequest, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ success: false, error: 'Authorization header (Bearer token) talab qilinadi.' });
    return;
  }

  const token = authHeader.slice('Bearer '.length).trim();
  const payload = verifySessionToken(token);
  if (!payload) {
    res.status(401).json({ success: false, error: "Token yaroqsiz yoki muddati tugagan." });
    return;
  }
  if (!payload.company_id) {
    // Eski (company_id'siz) hisoblar bilan yaratilgan token — kompaniya
    // talab qiladigan endpoint'larga kira olmaydi.
    res.status(403).json({ success: false, error: "Hisobingiz hech qanday kompaniyaga bog'lanmagan." });
    return;
  }

  req.auth = { userId: payload.sub, companyId: payload.company_id, role: payload.role };
  next();
}

export function requireCompanyRole(allowedRoles: string[]) {
  return (req: CompanyAuthedRequest, res: Response, next: NextFunction): void => {
    if (!req.auth) {
      res.status(401).json({ success: false, error: 'Autentifikatsiya talab qilinadi.' });
      return;
    }
    if (!allowedRoles.includes(req.auth.role)) {
      res.status(403).json({
        success: false,
        error: `Bu amal uchun ruxsat yo'q. Talab qilinadigan rol: ${allowedRoles.join(' yoki ')}.`,
      });
      return;
    }
    next();
  };
}
