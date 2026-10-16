import { Router, Response } from 'express';
import { supabase } from '../lib/supabase';
import { requireAuth, requireCompanyRole, type CompanyAuthedRequest } from '../middleware/companyAuth';
import { createDeeplinkToken } from '../lib/deeplinkToken';
import { sendCompanyReport } from '../lib/telegramReport';

// ============================================================================
// /company/telegram — Telegram kun hisoboti sozlamasi (2026-10-16).
// Direktor/admin: ulangan chatlar ro'yxati, ulash havolasi (SalesPulse boti,
// bir martalik, shaxsiy chat yoki guruh), hozir yuborish (test), o'chirish.
// Kompaniya FAQAT tokendan (req.auth.companyId).
// ============================================================================

const router = Router();
router.use(requireAuth, requireCompanyRole(['director', 'admin']));

const botUsername = () => String(process.env.TELEGRAM_BOT1_USERNAME || '').replace(/^@/, '');

router.get('/', async (req: CompanyAuthedRequest, res: Response) => {
  const { data, error } = await supabase
    .from('telegram_report_chats')
    .select('id, chat_id, title, enabled, last_sent_day, created_at')
    .eq('company_id', req.auth!.companyId)
    .order('created_at', { ascending: true });
  if (error) {
    // Jadval hali yaratilmagan (supabase/tg_01_report_chats.sql) — bo'sh ro'yxat.
    return res.status(200).json({ success: true, data: { bot: botUsername() || null, chats: [], ready: false } });
  }
  return res.status(200).json({ success: true, data: { bot: botUsername() || null, chats: data || [], ready: true } });
});

router.post('/link', async (req: CompanyAuthedRequest, res: Response) => {
  const bot = botUsername();
  if (!bot) return res.status(503).json({ success: false, error: 'Telegram bot sozlanmagan (TELEGRAM_BOT1_USERNAME).' });
  try {
    const token = await createDeeplinkToken(req.auth!.companyId as string, 'report');
    return res.status(200).json({
      success: true,
      // code — havola ishlamasa botga "/ulash <code>" deb yuboriladi (bot1.ts).
      data: { link: `https://t.me/${bot}?start=${token}`, group_link: `https://t.me/${bot}?startgroup=${token}`, code: token, bot },
    });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e?.message || 'Havola yaratilmadi.' });
  }
});

router.post('/test', async (req: CompanyAuthedRequest, res: Response) => {
  try {
    const sent = await sendCompanyReport(req.auth!.companyId as string);
    return res.status(200).json({ success: true, data: { sent } });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e?.message || 'Hisobot yuborilmadi.' });
  }
});

router.patch('/:id', async (req: CompanyAuthedRequest, res: Response) => {
  const enabled = req.body?.enabled;
  if (typeof enabled !== 'boolean') return res.status(400).json({ success: false, error: 'enabled true/false bo\'lsin.' });
  const { data, error } = await supabase
    .from('telegram_report_chats').update({ enabled })
    .eq('id', String(req.params.id)).eq('company_id', req.auth!.companyId)
    .select('id, enabled').maybeSingle();
  if (error) return res.status(500).json({ success: false, error: error.message });
  if (!data) return res.status(404).json({ success: false, error: 'Chat topilmadi.' });
  return res.status(200).json({ success: true, data });
});

router.delete('/:id', async (req: CompanyAuthedRequest, res: Response) => {
  const { data, error } = await supabase
    .from('telegram_report_chats').delete()
    .eq('id', String(req.params.id)).eq('company_id', req.auth!.companyId)
    .select('id').maybeSingle();
  if (error) return res.status(500).json({ success: false, error: error.message });
  if (!data) return res.status(404).json({ success: false, error: 'Chat topilmadi.' });
  return res.status(200).json({ success: true });
});

export default router;
