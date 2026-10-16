import { Router, Response } from 'express';
import { supabase } from '../lib/supabase';
import { requireAuth, requireCompanyRole, type CompanyAuthedRequest } from '../middleware/companyAuth';
import { encryptFor } from '../lib/passwordVault';
import { buildCallPayload, CRM_SECRET_PURPOSE, pushOne } from '../lib/crmPush';

// ============================================================================
// /company/integrations — kompaniyaning CRM integratsiyalari (2026-10-16).
//   GET    /                 — ro'yxat (sirlar ko'rsatilmaydi, faqat "bor/yo'q")
//   PUT    /:provider        — amocrm {subdomain, token?} | webhook {url, secret?}
//   PATCH  /:provider        — {enabled}
//   POST   /:provider/test   — oxirgi tahlil qilingan qo'ng'iroqni yuborib ko'rish
//   DELETE /:provider
// Faqat direktor/admin; kompaniya tokendan. Sirlar AES-GCM bilan shifrlanadi.
// ============================================================================

const router = Router();
router.use(requireAuth, requireCompanyRole(['director', 'admin']));

const PROVIDERS = ['amocrm', 'webhook'] as const;
type Provider = (typeof PROVIDERS)[number];
const isProvider = (v: string): v is Provider => (PROVIDERS as readonly string[]).includes(v);

/** Tashqi webhook manzili: faqat https, ichki/lokal manzillar taqiqlangan (SSRF). */
export function isSafeWebhookUrl(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.railway.internal')) return false;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return false;
  if (h === '::1' || h.startsWith('[')) return false;
  return true;
}

function publicView(row: any) {
  const c = row.config || {};
  return {
    provider: row.provider,
    enabled: row.enabled,
    subdomain: c.subdomain ?? null,
    url: c.url ?? null,
    has_token: !!c.token_enc,
    has_secret: !!c.secret_enc,
    last_push_at: row.last_push_at,
    last_error: row.last_error,
    pushed_count: row.pushed_count ?? 0,
  };
}

router.get('/', async (req: CompanyAuthedRequest, res: Response) => {
  const { data, error } = await supabase
    .from('company_integrations')
    .select('provider, config, enabled, last_push_at, last_error, pushed_count')
    .eq('company_id', req.auth!.companyId);
  if (error) return res.status(200).json({ success: true, data: { ready: false, items: [] } }); // SQL hali yo'q
  return res.status(200).json({ success: true, data: { ready: true, items: (data || []).map(publicView) } });
});

router.put('/:provider', async (req: CompanyAuthedRequest, res: Response) => {
  const provider = String(req.params.provider);
  if (!isProvider(provider)) return res.status(400).json({ success: false, error: 'Noma\'lum integratsiya.' });
  const companyId = req.auth!.companyId as string;
  const { data: existing } = await supabase
    .from('company_integrations').select('config').eq('company_id', companyId).eq('provider', provider).maybeSingle();
  const old = (existing as any)?.config || {};
  const body = req.body ?? {};
  let config: Record<string, unknown>;
  if (provider === 'amocrm') {
    const subdomain = String(body.subdomain ?? '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!/^[a-z0-9-]+(\.amocrm\.(ru|com))?$/i.test(subdomain)) {
      return res.status(400).json({ success: false, error: 'Subdomen noto\'g\'ri (masalan: kompaniya yoki kompaniya.amocrm.ru).' });
    }
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    const tokenEnc = token ? encryptFor(CRM_SECRET_PURPOSE, token) : old.token_enc;
    if (!tokenEnc) return res.status(400).json({ success: false, error: 'amoCRM uzoq muddatli tokenini kiriting.' });
    config = { subdomain, token_enc: tokenEnc };
  } else {
    const url = String(body.url ?? '').trim();
    if (!isSafeWebhookUrl(url)) return res.status(400).json({ success: false, error: 'Webhook manzili https:// bilan boshlanadigan tashqi manzil bo\'lsin.' });
    const secret = typeof body.secret === 'string' ? body.secret.trim() : '';
    config = { url, secret_enc: secret ? encryptFor(CRM_SECRET_PURPOSE, secret) : old.secret_enc ?? null };
  }
  const { data, error } = await supabase
    .from('company_integrations')
    .upsert({ company_id: companyId, provider, config, enabled: true, last_error: null, updated_at: new Date().toISOString() }, { onConflict: 'company_id,provider' })
    .select('provider, config, enabled, last_push_at, last_error, pushed_count')
    .single();
  if (error) return res.status(500).json({ success: false, error: error.message });
  return res.status(200).json({ success: true, data: publicView(data) });
});

router.patch('/:provider', async (req: CompanyAuthedRequest, res: Response) => {
  const provider = String(req.params.provider);
  if (!isProvider(provider) || typeof req.body?.enabled !== 'boolean') return res.status(400).json({ success: false, error: 'Noto\'g\'ri so\'rov.' });
  const { data, error } = await supabase
    .from('company_integrations').update({ enabled: req.body.enabled, updated_at: new Date().toISOString() })
    .eq('company_id', req.auth!.companyId).eq('provider', provider)
    .select('provider, config, enabled, last_push_at, last_error, pushed_count').maybeSingle();
  if (error) return res.status(500).json({ success: false, error: error.message });
  if (!data) return res.status(404).json({ success: false, error: 'Integratsiya topilmadi.' });
  return res.status(200).json({ success: true, data: publicView(data) });
});

router.post('/:provider/test', async (req: CompanyAuthedRequest, res: Response) => {
  const provider = String(req.params.provider);
  if (!isProvider(provider)) return res.status(400).json({ success: false, error: 'Noma\'lum integratsiya.' });
  const companyId = req.auth!.companyId as string;
  const { data: row } = await supabase
    .from('company_integrations').select('id, provider, config, enabled, pushed_count')
    .eq('company_id', companyId).eq('provider', provider).maybeSingle();
  if (!row) return res.status(404).json({ success: false, error: 'Avval sozlamani saqlang.' });
  const { data: last } = await supabase
    .from('calls').select('id').eq('company_id', companyId).gt('kpi_score', 0)
    .order('created_at', { ascending: false }).limit(1).maybeSingle();
  if (!last) return res.status(400).json({ success: false, error: 'Hali tahlil qilingan qo\'ng\'iroq yo\'q.' });
  try {
    const payload = await buildCallPayload((last as any).id);
    const result = await pushOne(row as any, payload!);
    await supabase.from('company_integrations').update({ last_push_at: new Date().toISOString(), last_error: null }).eq('id', (row as any).id);
    return res.status(200).json({ success: true, data: { result } });
  } catch (e: any) {
    const msg = String(e?.message || e).slice(0, 300);
    await supabase.from('company_integrations').update({ last_error: msg }).eq('id', (row as any).id);
    return res.status(502).json({ success: false, error: msg });
  }
});

router.delete('/:provider', async (req: CompanyAuthedRequest, res: Response) => {
  const provider = String(req.params.provider);
  if (!isProvider(provider)) return res.status(400).json({ success: false, error: 'Noma\'lum integratsiya.' });
  const { error } = await supabase
    .from('company_integrations').delete().eq('company_id', req.auth!.companyId).eq('provider', provider);
  if (error) return res.status(500).json({ success: false, error: error.message });
  return res.status(200).json({ success: true });
});

export default router;
