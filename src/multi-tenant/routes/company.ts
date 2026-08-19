import { Router, Response } from 'express';
import { supabaseAdmin } from '../lib/supabaseAdmin';
import { withAuth, type AuthedRequest } from '../middleware/withAuth';
import { requireRole } from '../middleware/requireRole';
import { getClientIp } from '../lib/rateLimit';
import { logAudit } from '../lib/auditLog';

const router = Router();

// ============================================================================
// PATCH /company/invite-code/regenerate — eski kod bekor, yangisi yaratiladi
// ============================================================================
//
// Response 200:
//   { "success": true, "data": { "invite_code": "P4Q8X2ZKT" } }
//   (Yangi kod FAQAT shu javobda ko'rinadi — keyinroq GET /company orqali
//   qayta olish mumkin, lekin audit_logs'ga YOZILMAYDI, pastga qarang.)
//
// Xatolar:
//   401 { "success": false, "error": "Authorization header (Bearer token) talab qilinadi." }
//   403 { "success": false, "error": "Bu amal uchun ruxsat yo'q. Talab qilinadigan rol: owner yoki admin." }
//   500 { "success": false, "error": "..." }
router.patch('/invite-code/regenerate', withAuth, requireRole(['owner', 'admin']), async (req: AuthedRequest, res: Response) => {
  const admin = supabaseAdmin();
  const companyId = req.auth!.companyId;

  // public.generate_invite_code() — 9 belgi, collision-safe (multi_tenant_saas.sql).
  const { data: newCode, error: genErr } = await admin.rpc('generate_invite_code');
  if (genErr || typeof newCode !== 'string') {
    return res.status(500).json({ success: false, error: `Kod generatsiya qilib bo'lmadi: ${genErr?.message || 'unknown'}` });
  }

  // Eski kod bilan UPDATE — bitta so'rov bilan ham "eskisi bekor bo'ladi",
  // ham "yangisi kuchga kiradi": invite_code UNIQUE ustun bo'lgani uchun
  // eski qiymat endi HECH QANDAY qatorda yo'q, /auth/register uni topa
  // olmaydi (400 qaytaradi) — alohida "bekor qilish" logikasi shart emas.
  const { error: updateErr } = await admin
    .from('companies')
    .update({ invite_code: newCode })
    .eq('id', companyId);

  if (updateErr) {
    return res.status(500).json({ success: false, error: `Database Error: ${updateErr.message}` });
  }

  // Audit: kim, qachon — lekin yangi kodning O'ZI metadata'ga yozilmaydi.
  // Sabab: audit_logs'ni owner/admin bo'lmagan hech kim o'qiy olmasa ham
  // (RLS), yozuvni ko'rgan HAR QANDAY owner/admin uni keyinchalik
  // ko'rmasligi kerak bo'lgan taqdirda ham (masalan rol pasaytirilgan
  // sobiq admin) — jonli kirish kodini abadiy audit tarixida saqlash
  // ortiqcha xavf. Kim regenerate qilgani + vaqti yetarli.
  await logAudit({
    companyId,
    userId: req.auth!.userId,
    action: 'invite_code_regenerated',
    ipAddress: getClientIp(req),
  });

  return res.status(200).json({ success: true, data: { invite_code: newCode } });
});

export default router;
