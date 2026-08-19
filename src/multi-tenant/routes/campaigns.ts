import { Router, Response } from 'express';
import { supabaseAdmin } from '../lib/supabaseAdmin';
import { withAuth, type AuthedRequest } from '../middleware/withAuth';
import { requireRole } from '../middleware/requireRole';

const router = Router();

// ============================================================================
// POST /campaigns — faqat owner/admin (4-band misoli)
// ============================================================================
//
// Request:
//   { "name": "2026 Yanvar aksiya skripti",
//     "script_stages": [{ "stage": 1, "title": "Tanishuv", "required_elements": [...] }, ...] }
//
// Response 201:
//   { "success": true, "data": { "id": "e4a1...", "company_id": "c153...",
//       "name": "2026 Yanvar aksiya skripti", "script_stages": [...], "created_at": "..." } }
//
// Xatolar:
//   400 { "success": false, "error": "name majburiy." }
//   401 { "success": false, "error": "Authorization header (Bearer token) talab qilinadi." }
//   403 { "success": false, "error": "Bu amal uchun ruxsat yo'q. Talab qilinadigan rol: owner yoki admin." }
//   500 { "success": false, "error": "..." }
router.post('/', withAuth, requireRole(['owner', 'admin']), async (req: AuthedRequest, res: Response) => {
  const { name, script_stages } = req.body ?? {};
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ success: false, error: 'name majburiy.' });
  }

  // DIQQAT: company_id req.auth'dan olinadi, HECH QACHON req.body'dan emas —
  // aks holda mijoz o'zi xohlagan company_id yuborib, boshqa tenant nomidan
  // yozishi mumkin bo'lardi. Bu yerda ilova qatlamida to'g'ri qiymat
  // majburlansa ham, RLS'dagi WITH CHECK buni baribir tasdiqlaydi (ikki
  // qatlamli himoya).
  const { data, error } = await supabaseAdmin()
    .from('campaigns')
    .insert({
      company_id: req.auth!.companyId,
      name: name.trim(),
      script_stages: Array.isArray(script_stages) ? script_stages : [],
    })
    .select('*')
    .single();

  if (error) return res.status(500).json({ success: false, error: `Database Error: ${error.message}` });
  return res.status(201).json({ success: true, data });
});

// ============================================================================
// DELETE /campaigns/:id — faqat owner/admin (4-band misoli)
// ============================================================================
//
// Response 200:
//   { "success": true, "message": "Campaign o'chirildi." }
//
// Xatolar:
//   403 { "success": false, "error": "Bu amal uchun ruxsat yo'q. ..." }
//   404 { "success": false, "error": "Campaign topilmadi." }
//   500 { "success": false, "error": "..." }
router.delete('/:id', withAuth, requireRole(['owner', 'admin']), async (req: AuthedRequest, res: Response) => {
  const { id } = req.params;

  // .eq('company_id', ...) — ILOVA darajasidagi filtr (defense in depth).
  // Bu yo'q bo'lsa ham, RLS boshqa tenant'ning campaign'ini o'chirtirmaydi —
  // lekin aniq filtrsiz "0 qator o'zgardi" bilan "topilmadi" ni farqlash
  // qiyinlashadi, shu sabab ikkalasi ham qo'yiladi.
  const { data, error } = await supabaseAdmin()
    .from('campaigns')
    .delete()
    .eq('id', id)
    .eq('company_id', req.auth!.companyId)
    .select('id')
    .maybeSingle();

  if (error) return res.status(500).json({ success: false, error: `Database Error: ${error.message}` });
  if (!data) return res.status(404).json({ success: false, error: 'Campaign topilmadi.' });
  return res.status(200).json({ success: true, message: "Campaign o'chirildi." });
});

export default router;
