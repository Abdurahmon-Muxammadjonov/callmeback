import type { NextFunction, Response } from 'express';
import type { AuthContext, AuthedRequest } from './withAuth';

/**
 * RBAC decorator. withAuth'dan KEYIN ishlatiladi (req.auth borligiga tayanadi).
 *
 * Qo'llanilishi:
 *   router.post('/campaigns', withAuth, requireRole(['owner', 'admin']), createCampaign);
 *   router.delete('/campaigns/:id', withAuth, requireRole(['owner', 'admin']), deleteCampaign);
 *   router.patch('/users/:id/role', withAuth, requireRole(['owner']), changeUserRole);
 */
export function requireRole(allowedRoles: AuthContext['role'][]) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    if (!req.auth) {
      // Dasturchi xatosi belgisi — requireRole withAuth'siz ulangan.
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
