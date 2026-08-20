import { Router, Request, Response } from 'express';
import { requireAuth, type CompanyAuthedRequest } from '../middleware/companyAuth';
import { createDeeplinkToken, checkDeeplinkRateLimit } from '../lib/deeplinkToken';
import { bot1 } from '../telegram/bot1Client';
import '../telegram/bot1'; // handler'larni ro'yxatdan o'tkazish uchun (side-effect import)
import { bot2 } from '../telegram/bot2';

const router = Router();

// ============================================================================
// POST /internal/telegram/deeplink — frontend "Kod olish"/"Tarifni yangilash"
// tugmasi bosilganda chaqiradi.
// ============================================================================
router.post('/deeplink', requireAuth, async (req: CompanyAuthedRequest, res: Response) => {
  const { purpose } = req.body ?? {};
  if (purpose !== 'get_code' && purpose !== 'upgrade') {
    return res.status(400).json({ success: false, error: "purpose 'get_code' yoki 'upgrade' bo'lishi kerak." });
  }

  const companyId = req.auth!.companyId as string;

  // Part 6: soatiga 5 tadan ortiq havola so'ralmasin (abuse'dan himoya).
  const allowed = await checkDeeplinkRateLimit(companyId);
  if (!allowed) {
    return res.status(429).json({ success: false, error: "Juda ko'p urinish. Birozdan so'ng qayta urinib ko'ring." });
  }

  try {
    const token = await createDeeplinkToken(companyId, purpose);
    const botUsername = process.env.TELEGRAM_BOT1_USERNAME || 'SalesPulsead_bot';
    return res.status(200).json({ success: true, data: { url: `https://t.me/${botUsername}?start=${token}` } });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e?.message || "Havola yaratib bo'lmadi." });
  }
});

// ============================================================================
// Webhook qabul qiluvchilar — Telegram'ning X-Telegram-Bot-Api-Secret-Token
// header'i tekshiriladi (setWebhook'da secret_token bilan o'rnatilgan bo'lsa).
// ============================================================================
function verifySecretToken(req: Request, envVar: string): boolean {
  const expected = (process.env[envVar] || '').trim();
  if (!expected) return false;
  const provided = req.headers['x-telegram-bot-api-secret-token'];
  return typeof provided === 'string' && provided === expected;
}

router.post('/bot1-webhook', async (req: Request, res: Response) => {
  if (!verifySecretToken(req, 'TELEGRAM_BOT1_WEBHOOK_SECRET')) {
    return res.status(401).json({ success: false, error: 'secret_token noto\'g\'ri.' });
  }
  try {
    await bot1.handleUpdate(req.body);
  } catch (e: any) {
    console.error('Bot1 webhook xatosi:', e?.message || e);
  }
  return res.status(200).end();
});

router.post('/bot2-webhook', async (req: Request, res: Response) => {
  if (!verifySecretToken(req, 'TELEGRAM_BOT2_WEBHOOK_SECRET')) {
    return res.status(401).json({ success: false, error: 'secret_token noto\'g\'ri.' });
  }
  try {
    await bot2.handleUpdate(req.body);
  } catch (e: any) {
    console.error('Bot2 webhook xatosi:', e?.message || e);
  }
  return res.status(200).end();
});

export default router;
