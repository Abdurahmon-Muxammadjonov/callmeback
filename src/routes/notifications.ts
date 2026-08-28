import { Router, Response } from 'express';
import { supabase } from '../lib/supabase';
import { requireAuth, type CompanyAuthedRequest } from '../middleware/companyAuth';

const router = Router();

// XAVFSIZLIK TUZATISHI (production'da aniqlangan xato): avval ?user_id=
// so'ralgan qiymatga TEKSHIRUVSIZ ishonardi — istalgan foydalanuvchi
// boshqasining UUID'sini bilsa/taxmin qilsa, uning bildirishnomalarini
// o'qiy (yoki "o'qilgan" deb belgilay) olardi (IDOR). Endi user_id
// so'rovdan emas, autentifikatsiya qilingan req.auth.userId'dan olinadi.

// GET /manager-notifications — chaqiruvchining o'z bildirishnomalari
router.get('/', requireAuth, async (req: CompanyAuthedRequest, res: Response) => {
  try {
    const userId = req.auth!.userId;
    const { data, error } = await supabase
      .from('user_notifications')
      .select('id, message, read, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) return res.status(500).json({ success: false, error: `Database Error: ${error.message}` });
    return res.status(200).json({ success: true, data });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Bildirishnomalarni o\'qishda xatolik.' });
  }
});

// POST /manager-notifications/read — chaqiruvchining o'z bildirishnomalarini o'qilgan deb belgilash
router.post('/read', requireAuth, async (req: CompanyAuthedRequest, res: Response) => {
  try {
    const userId = req.auth!.userId;
    const { error } = await supabase
      .from('user_notifications')
      .update({ read: true })
      .eq('user_id', userId)
      .eq('read', false);
    if (error) return res.status(500).json({ success: false, error: `Database Error: ${error.message}` });
    return res.status(200).json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Belgilashda xatolik.' });
  }
});

export default router;
