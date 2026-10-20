import crypto from 'node:crypto';
import { Router, Request, Response } from 'express';
import { syncCompanyDeals } from '../lib/crmDeals';

// ============================================================================
// amoCRM WEBHOOK — bitim o'zgarishi bilan darhol sinxron (2026-10-20,
// foydalanuvchi: "CRM'da o'zgarsa darhol ko'rinsin"). amoCRM → Sozlamalar →
// Integratsiyalar → Webhooks: POST /webhooks/amocrm/:companyId/:sig.
// sig — kompaniyaga xos HMAC (sozlamada ko'rsatiladi); tana o'qilmaydi —
// faqat "o'zgarish bor" signali: 15 soniya ichidagi signallar bitta
// sinxronga yig'iladi. Worker baribir har CRM_PULL_MINUTES daqiqada yangilaydi.
// ============================================================================

export function amoWebhookSig(companyId: string): string | null {
  const k = process.env.WEBHOOK_SECRET_ENC_KEY;
  if (!k) return null;
  return crypto.createHmac('sha256', `${k}:amo-webhook:v1`).update(companyId).digest('hex').slice(0, 32);
}

export function amoWebhookUrl(companyId: string): string | null {
  const sig = amoWebhookSig(companyId);
  const base = process.env.PUBLIC_BASE_URL || 'https://callmeback-production.up.railway.app';
  return sig ? `${base}/webhooks/amocrm/${companyId}/${sig}` : null;
}

const pending = new Map<string, NodeJS.Timeout>();
const router = Router();

router.post('/:companyId/:sig', (req: Request, res: Response) => {
  const companyId = String(req.params.companyId);
  const want = /^[0-9a-f-]{36}$/i.test(companyId) ? amoWebhookSig(companyId) : null;
  const got = String(req.params.sig);
  if (!want || got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) {
    return res.status(404).json({ success: false });
  }
  if (!pending.has(companyId)) {
    const t = setTimeout(() => {
      pending.delete(companyId);
      void syncCompanyDeals(companyId).catch(() => { /* pull_error'ga yozilgan */ });
    }, 15_000);
    t.unref();
    pending.set(companyId, t);
  }
  return res.status(200).json({ success: true });
});

export default router;
