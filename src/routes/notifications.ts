import { Router, Request, Response } from 'express';
import { supabase } from '../lib/supabase';

const router = Router();

// GET /manager-notifications?user_id=:id — foydalanuvchi bildirishnomalari
router.get('/', async (req: Request, res: Response) => {
  try {
    const userId = typeof req.query.user_id === 'string' ? req.query.user_id : '';
    if (!userId) return res.status(400).json({ success: false, error: 'user_id majburiy.' });
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

// POST /manager-notifications/read  { user_id } — hammasini o'qilgan deb belgilash
router.post('/read', async (req: Request, res: Response) => {
  try {
    const userId = req.body?.user_id;
    if (!userId) return res.status(400).json({ success: false, error: 'user_id majburiy.' });
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
