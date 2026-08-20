import { Router, Request, Response } from 'express';
import crypto from 'node:crypto';
import { supabase } from '../lib/supabase';
import { requireAuth, requireCompanyRole, type CompanyAuthedRequest } from '../middleware/companyAuth';
import { generateWebhookSecret, encryptSecret, decryptSecret, maskSecret } from '../lib/webhookSecret';
import { enqueueBatchCalls, type BatchCallItem } from './analyze-call';

const router = Router();

function generateSlug(): string {
  return crypto.randomBytes(12).toString('base64url'); // taxmin qilib bo'lmaydigan, URL-xavfsiz
}

// ============================================================================
// POST /company/webhooks — yangi mustaqil webhook ulanishi yaratadi
// ============================================================================
// Faqat director/admin. Har kompaniya o'zining ALOHIDA endpoint_slug +
// secret'iga ega bo'ladi — boshqa kompaniyaning webhook'iga hech qanday
// aloqasi yo'q (jadval darajasida ham company_id bilan ajratilgan).
router.post('/webhooks', requireAuth, requireCompanyRole(['director', 'admin']), async (req: CompanyAuthedRequest, res: Response) => {
  const { crm_type } = req.body ?? {};
  if (typeof crm_type !== 'string' || !crm_type.trim()) {
    return res.status(400).json({ success: false, error: 'crm_type majburiy.' });
  }

  const slug = generateSlug();
  const secret = generateWebhookSecret();

  const { data, error } = await supabase
    .from('webhooks')
    .insert({
      company_id: req.auth!.companyId,
      crm_type: crm_type.trim(),
      endpoint_slug: slug,
      secret_token_encrypted: encryptSecret(secret),
      status: 'connected',
    })
    .select('id, crm_type, endpoint_slug, status, created_at')
    .single();

  if (error || !data) return res.status(500).json({ success: false, error: `Webhook yaratib bo'lmadi: ${error?.message}` });

  const base = process.env.PUBLIC_BASE_URL || 'https://callmeback-production.up.railway.app';
  return res.status(201).json({
    success: true,
    data: {
      ...data,
      webhook_url: `${base}/webhooks/incoming/${slug}`,
      // Sekret FAQAT shu javobda ochiq ko'rinadi — bazada shifrlangan
      // holda saqlanadi, GET /company/webhooks uni qayta ko'rsatmaydi.
      secret,
    },
  });
});

// ============================================================================
// GET /company/webhooks — joriy kompaniyaning webhook'lari (sekret maskalangan)
// ============================================================================
router.get('/webhooks', requireAuth, async (req: CompanyAuthedRequest, res: Response) => {
  const { data, error } = await supabase
    .from('webhooks')
    .select('id, crm_type, endpoint_slug, status, secret_token_encrypted, created_at')
    .eq('company_id', req.auth!.companyId as string)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ success: false, error: `Database Error: ${error.message}` });

  const base = process.env.PUBLIC_BASE_URL || 'https://callmeback-production.up.railway.app';
  const safe = (data || []).map((row) => {
    let secretMasked = '****';
    try { secretMasked = maskSecret(decryptSecret(row.secret_token_encrypted)); } catch { /* eski/buzilgan yozuv — jim o'tamiz */ }
    return {
      id: row.id,
      crm_type: row.crm_type,
      status: row.status,
      created_at: row.created_at,
      webhook_url: `${base}/webhooks/incoming/${row.endpoint_slug}`,
      secret_masked: secretMasked,
    };
  });

  return res.status(200).json({ success: true, data: safe });
});

// ============================================================================
// POST /webhooks/incoming/:slug — TASHQI CRM shu yerga yozadi (ochiq, lekin
// sekret orqali himoyalangan endpoint — requireAuth YO'Q, chunki bu tashqi
// tizim, bizning foydalanuvchimiz emas).
// ============================================================================
// Alohida router — /webhooks prefiksi bilan mount qilinadi (server.ts).
export const incomingRouter = Router();

incomingRouter.post('/incoming/:slug', async (req: Request, res: Response) => {
  try {
    const slug = req.params.slug;
    const { data: webhook, error } = await supabase
      .from('webhooks')
      .select('id, company_id, secret_token_encrypted, status')
      .eq('endpoint_slug', slug)
      .maybeSingle();

    if (error) return res.status(500).json({ success: false, error: `Database Error: ${error.message}` });
    if (!webhook) return res.status(404).json({ success: false, error: 'Webhook topilmadi.' });
    if (webhook.status !== 'connected') {
      return res.status(403).json({ success: false, error: 'Bu webhook uzilgan (disconnected).' });
    }

    // Sekret: header (X-Webhook-Secret) YOKI payload ichidagi "secret" maydonidan.
    const providedSecret = typeof req.headers['x-webhook-secret'] === 'string'
      ? req.headers['x-webhook-secret']
      : (typeof req.body?.secret === 'string' ? req.body.secret : '');

    let expectedSecret: string;
    try {
      expectedSecret = decryptSecret(webhook.secret_token_encrypted);
    } catch {
      return res.status(500).json({ success: false, error: 'Webhook sekretini ochib bo\'lmadi.' });
    }

    const a = Buffer.from(providedSecret || '');
    const b = Buffer.from(expectedSecret);
    const validSecret = a.length === b.length && crypto.timingSafeEqual(a, b);
    if (!validSecret) {
      return res.status(401).json({ success: false, error: 'Sekret noto\'g\'ri.' });
    }

    // Payload'ni normallashtiramiz — bitta qo'ng'iroq yoki {calls:[...]} massivi.
    const raw = Array.isArray(req.body?.calls) ? req.body.calls : [req.body];
    const items: BatchCallItem[] = raw
      .filter((r: any) => r && typeof r === 'object')
      .map((r: any) => ({
        audio_url: typeof r.audio_url === 'string' ? r.audio_url : undefined,
        manager_name: typeof r.manager_name === 'string' ? r.manager_name : undefined,
        crm_id: typeof r.crm_id === 'string' ? r.crm_id : undefined,
        client_phone: typeof r.client_phone === 'string' ? r.client_phone : undefined,
        client_name: typeof r.client_name === 'string' ? r.client_name : undefined,
        direction: r.direction === 'incoming' || r.direction === 'outgoing' ? r.direction : 'unknown',
        // MUHIM: company_id tashqi so'rovdan HECH QACHON olinmaydi — faqat
        // webhook yozuvidan (endpoint_slug orqali topilgan). Shu sabab
        // bitta kompaniyaning ma'lumoti boshqasiga hech qachon yozilmaydi.
        company_id: webhook.company_id,
      }));

    const out = await enqueueBatchCalls(items, supabase);
    return res.status(out.status).json(out.body);
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Webhook qabul qilishda xato.' });
  }
});

export default router;
