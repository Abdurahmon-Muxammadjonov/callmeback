import { Router, Response } from 'express';
import { supabaseAdmin } from '../lib/supabaseAdmin';
import { withAuth, invalidateProfileCache, type AuthedRequest } from '../middleware/withAuth';
import { requireRole } from '../middleware/requireRole';
import { getClientIp } from '../lib/rateLimit';
import { logAudit } from '../lib/auditLog';

const router = Router();

const VALID_ROLES = ['owner', 'admin', 'manager', 'agent'] as const;

// ============================================================================
// PATCH /users/:id/role — xodim rolini o'zgartirish, FAQAT owner (4-band misoli)
// ============================================================================
//
// Request:
//   { "role": "manager" }
//
// Response 200:
//   { "success": true, "data": { "id": "b5f7...", "role": "manager" } }
//
// Xatolar:
//   400 { "success": false, "error": "role quyidagilardan biri bo'lishi kerak: owner, admin, manager, agent" }
//   400 { "success": false, "error": "O'zingizning rolingizni o'zgartira olmaysiz." }
//   403 { "success": false, "error": "Bu amal uchun ruxsat yo'q. Talab qilinadigan rol: owner." }
//   404 { "success": false, "error": "Xodim topilmadi." }
//   500 { "success": false, "error": "..." }
router.patch('/:id/role', withAuth, requireRole(['owner']), async (req: AuthedRequest, res: Response) => {
  const id = String(req.params.id);
  const { role } = req.body ?? {};

  if (!VALID_ROLES.includes(role)) {
    return res.status(400).json({ success: false, error: `role quyidagilardan biri bo'lishi kerak: ${VALID_ROLES.join(', ')}` });
  }
  if (id === req.auth!.userId) {
    // Owner o'zini demote qilib, kompaniyani "owner'siz" holga tushirib
    // qo'ymasligi uchun (owner almashtirish alohida, ataylan oqim bo'lishi kerak).
    return res.status(400).json({ success: false, error: "O'zingizning rolingizni o'zgartira olmaysiz." });
  }

  const admin = supabaseAdmin();

  // Audit uchun eski rolni ham yozamiz — update'dan oldin o'qiymiz.
  const { data: before } = await admin.from('users').select('role').eq('id', id).eq('company_id', req.auth!.companyId).maybeSingle();

  const { data, error } = await admin
    .from('users')
    .update({ role })
    .eq('id', id)
    .eq('company_id', req.auth!.companyId) // boshqa tenant xodimini o'zgartirib qo'yishning oldini oladi
    .select('id, role')
    .maybeSingle();

  if (error) return res.status(500).json({ success: false, error: `Database Error: ${error.message}` });
  if (!data) return res.status(404).json({ success: false, error: 'Xodim topilmadi.' });

  // withAuth'dagi 30s keshni darhol tozalaymiz — aks holda o'zgartirilgan
  // xodim eski rol bilan yana 30 soniyagacha ishlayveradi (yuqoridagi
  // withAuth.ts izohidagi "role darhol kuchga kirishi kerak" talabi).
  invalidateProfileCache(id);

  await logAudit({
    companyId: req.auth!.companyId,
    userId: req.auth!.userId,
    action: 'role_changed',
    ipAddress: getClientIp(req),
    metadata: { target_user_id: id, old_role: before?.role ?? null, new_role: role },
  });

  return res.status(200).json({ success: true, data });
});

export default router;
