import { Router, Response } from 'express';
import { supabaseAdmin } from '../lib/supabaseAdmin';
import { withAuth, type AuthedRequest } from '../middleware/withAuth';

const router = Router();

// ============================================================================
// GET /calls — ro'yxat, rolga qarab ko'lami farqlanadi (4-band misoli)
// ============================================================================
// - agent      → FAQAT o'zining (agent_id = mening user_id'im) qo'ng'iroqlari
// - manager/admin/owner → kompaniyadagi HAMMA qo'ng'iroqlar
//
// Response 200:
//   { "success": true, "data": [
//       { "id": "f1a2...", "campaign_id": "e4a1...", "agent_id": "b5f7...",
//         "audio_url": "https://.../rec.mp3", "score_json": { "total": 78, ... },
//         "created_at": "2026-08-15T09:12:00Z" }, ...
//   ] }
//
// Xatolar:
//   401 { "success": false, "error": "Authorization header (Bearer token) talab qilinadi." }
//   500 { "success": false, "error": "..." }
router.get('/', withAuth, async (req: AuthedRequest, res: Response) => {
  let query = supabaseAdmin()
    .from('calls')
    .select('id, campaign_id, agent_id, audio_url, transcript, score_json, created_at')
    .eq('company_id', req.auth!.companyId) // ilova qatlamidagi tenant filtri (RLS'ga qo'shimcha)
    .order('created_at', { ascending: false })
    .limit(100);

  // Rol-asosidagi ko'lam cheklovi: bu joyning aynan o'zi RLS'da ifodalab
  // bo'lmaydigan qism, chunki RLS "qaysi rol nima ko'rishi kerak"ni emas,
  // faqat "qaysi tenant"ni biladi (auth.user_company_id()). Rolga qarab
  // qo'shimcha filtr — ilova darajasidagi mantiq.
  if (req.auth!.role === 'agent') {
    query = query.eq('agent_id', req.auth!.userId);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ success: false, error: `Database Error: ${error.message}` });
  return res.status(200).json({ success: true, data });
});

export default router;
