import { Router, Response } from 'express';
import { supabaseAdmin } from '../lib/supabaseAdmin';
import { withAuth, type AuthedRequest } from '../middleware/withAuth';
import { requireRole } from '../middleware/requireRole';
import { getClientIp } from '../lib/rateLimit';
import { logAudit } from '../lib/auditLog';

const router = Router();

const VALID_CRM_TYPES = ['bitrix24', 'amocrm', 'webhook', 'other'] as const;

// credentials'dagi har bir string qiymatni "oxirgi 4 belgidan boshqasi
// yashirilgan" holga o'tkazadi. Javobda/logda HECH QACHON to'liq qiymat
// chiqmasligi uchun ishlatiladi.
function maskCredentials(input: Record<string, unknown>): Record<string, string> {
  const masked: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== 'string' || value.length === 0) {
      masked[key] = '(bo\'sh)';
      continue;
    }
    const tail = value.slice(-4);
    masked[key] = value.length <= 4 ? '*'.repeat(value.length) : `${'*'.repeat(Math.min(8, value.length - 4))}${tail}`;
  }
  return masked;
}

// ============================================================================
// POST /company/integrations/crm — CRM ulash, FAQAT owner/admin (5-band)
// ============================================================================
//
// Request:
//   { "crm_type": "amocrm",
//     "credentials": { "api_key": "AMO-a1b2c3d4e5f6g7h8i9j0", "webhook_url": "https://..." } }
//
// Response 200:
//   { "success": true, "data": {
//       "crm_type": "amocrm",
//       "credentials_masked": { "api_key": "****g7h8i9j0", "webhook_url": "****" },
//       "connected_at": "2026-08-15T09:12:00Z" } }
//   (E'TIBOR: bu javobda credentials'ning TO'LIQ qiymati HECH QACHON
//   chiqmaydi — faqat maskalangan versiya, faqat tasdiqlash uchun.)
//
// Xatolar:
//   400 { "success": false, "error": "crm_type quyidagilardan biri bo'lishi kerak: bitrix24, amocrm, webhook, other" }
//   400 { "success": false, "error": "credentials bo'sh bo'lmagan JSON obyekt bo'lishi kerak." }
//   401 { "success": false, "error": "Authorization header (Bearer token) talab qilinadi." }
//   403 { "success": false, "error": "Bu amal uchun ruxsat yo'q. Talab qilinadigan rol: owner yoki admin." }
//   500 { "success": false, "error": "..." }  (Vault yozish xatosi — bu holatda ham xabarda
//         credentials qiymati HECH QACHON ko'rsatilmaydi)
router.post('/crm', withAuth, requireRole(['owner', 'admin']), async (req: AuthedRequest, res: Response) => {
  const { crm_type, credentials } = req.body ?? {};

  if (!VALID_CRM_TYPES.includes(crm_type)) {
    return res.status(400).json({ success: false, error: `crm_type quyidagilardan biri bo'lishi kerak: ${VALID_CRM_TYPES.join(', ')}` });
  }
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials) || Object.keys(credentials).length === 0) {
    return res.status(400).json({ success: false, error: "credentials bo'sh bo'lmagan JSON obyekt bo'lishi kerak." });
  }

  const admin = supabaseAdmin();

  // credentials — hech qachon jsonb ustunga TO'G'RIDAN-TO'G'RI yozilmaydi.
  // public.set_crm_credentials() (SQL migratsiyada, SECURITY DEFINER) ichida
  // vault.create_secret() chaqiriladi va shifrlangan holda saqlanadi;
  // companies.crm_credentials_id ustuniga faqat Vault yozuvining uuid'i tushadi.
  //
  // MUHIM: bu yerda `credentials`ning o'zi console.log/console.error'ga
  // HECH QACHON berilmaydi — pastdagi catch bloki ham buni ta'minlaydi.
  const { error: rpcErr } = await admin.rpc('set_crm_credentials', {
    p_company_id: req.auth!.companyId,
    p_credentials: credentials,
  });

  if (rpcErr) {
    // Diqqat: rpcErr.message Postgres xatosi, credentials qiymatini o'zida
    // saqlamaydi — shu sabab xavfsiz. Baribir ehtiyot uchun xom obyektni
    // logga chiqarmaymiz.
    console.error(`CRM credentials saqlashda xato (company_id=${req.auth!.companyId}):`, rpcErr.message);
    return res.status(500).json({ success: false, error: `Credentials saqlab bo'lmadi: ${rpcErr.message}` });
  }

  const { error: updateErr } = await admin
    .from('companies')
    .update({ crm_type })
    .eq('id', req.auth!.companyId);

  if (updateErr) {
    return res.status(500).json({ success: false, error: `Database Error: ${updateErr.message}` });
  }

  const credentialsMasked = maskCredentials(credentials);

  // Audit metadata'da ham FAQAT maskalangan versiya — audit_logs'ni
  // o'qiy oladigan owner/admin ham xom kalitni bu yerdan ko'ra olmasligi kerak.
  await logAudit({
    companyId: req.auth!.companyId,
    userId: req.auth!.userId,
    action: 'crm_credentials_updated',
    ipAddress: getClientIp(req),
    metadata: { crm_type, credentials_masked: credentialsMasked },
  });

  return res.status(200).json({
    success: true,
    data: {
      crm_type,
      credentials_masked: credentialsMasked,
      connected_at: new Date().toISOString(),
    },
  });
});

export default router;
