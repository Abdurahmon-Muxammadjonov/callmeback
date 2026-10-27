import { Router, Response } from 'express';
import { supabase } from '../lib/supabase';
import { requireAuth, requireCompanyRole, type CompanyAuthedRequest } from '../middleware/companyAuth';
import { encryptFor } from '../lib/passwordVault';
import { buildCallPayload, CRM_SECRET_PURPOSE, pushOne } from '../lib/crmPush';
import { syncCompanyDeals } from '../lib/crmDeals';
import { accountInfo, listAdAccounts, normAccountId, syncMetaAds } from '../lib/metaAds';
import { decryptFor } from '../lib/passwordVault';

// ============================================================================
// /company/integrations — kompaniyaning CRM integratsiyalari (2026-10-16).
//   GET    /                 — ro'yxat (sirlar ko'rsatilmaydi, faqat "bor/yo'q")
//   PUT    /:provider        — amocrm {subdomain, token?} | webhook {url, secret?}
//   PATCH  /:provider        — {enabled}
//   POST   /:provider/test   — oxirgi tahlil qilingan qo'ng'iroqni yuborib ko'rish
//   POST   /amocrm/sync      — amoCRM'dan pul ma'lumotlarini hozir yangilash
//   POST   /meta/accounts     — {token} → token egasining reklama hisoblari
//   POST   /meta/sync         — Meta Ads xarajatlarini hozir yangilash
//   DELETE /:provider
// Faqat direktor/admin; kompaniya tokendan. Sirlar AES-GCM bilan shifrlanadi.
// ============================================================================

const router = Router();
router.use(requireAuth, requireCompanyRole(['director', 'admin']));

const PROVIDERS = ['amocrm', 'webhook', 'meta'] as const;
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
    account_id: c.account_id ?? null,
    account_name: c.account_name ?? null,
    currency: c.currency ?? null,
    pull_at: row.pull_at ?? null,
    pull_error: row.pull_error ?? null,
  };
}

router.get('/', async (req: CompanyAuthedRequest, res: Response) => {
  const { data, error } = await supabase
    .from('company_integrations')
    .select('provider, config, enabled, last_push_at, last_error, pushed_count, pull_at, pull_error')
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
  let resetPull = false;
  if (provider === 'meta') {
    // Meta Ads (target): token + reklama hisobi. Token saqlashdan oldin Meta'da tekshiriladi.
    const account = normAccountId(body.account_id);
    if (!account) return res.status(400).json({ success: false, error: 'Reklama hisobini tanlang (act_…).' });
    const token = typeof body.token === 'string' && body.token.trim() ? body.token.trim() : decryptFor(CRM_SECRET_PURPOSE, old.token_enc);
    if (!token) return res.status(400).json({ success: false, error: 'Meta access token kiriting.' });
    let info;
    try { info = await accountInfo(token, account); } catch (e: any) { return res.status(400).json({ success: false, error: e?.message || 'Meta tokenni qabul qilmadi.' }); }
    config = { account_id: account, account_name: info.name, currency: info.currency, token_enc: encryptFor(CRM_SECRET_PURPOSE, token) };
    resetPull = old.account_id !== account; // boshqa hisob — 90 kun qaytadan
  } else if (provider === 'amocrm') {
    const subdomain = String(body.subdomain ?? '').trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    if (!/^[a-z0-9-]+(\.amocrm\.(ru|com))?$/i.test(subdomain)) {
      return res.status(400).json({ success: false, error: 'Subdomen noto\'g\'ri (masalan: kompaniya yoki kompaniya.amocrm.ru).' });
    }
    const token = typeof body.token === 'string' ? body.token.trim() : '';
    const tokenEnc = token ? encryptFor(CRM_SECRET_PURPOSE, token) : old.token_enc;
    if (!tokenEnc) return res.status(400).json({ success: false, error: 'amoCRM uzoq muddatli tokenini kiriting.' });
    // Haqiqiy subdomen — tokenning o'zidan (2026-10-20). Direktor brauzerdagi
    // nomni (masalan "jamals") yozgan, token esa "marifatjamal" akkauntiniki
    // edi — amoCRM 401 qaytardi. amoCRM bu manzilda token egasining
    // subdomenini beradi; olinmasa kiritilgani qoladi.
    let realSub = subdomain;
    if (token) {
      try {
        const r = await fetch('https://www.amocrm.ru/oauth2/account/subdomain', {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(10_000),
        });
        if (r.status === 401) return res.status(400).json({ success: false, error: 'amoCRM tokenni qabul qilmadi — «Долгосрочный токен»ni qayta nusxalang.' });
        const j: any = r.ok ? await r.json() : null;
        if (j?.domain) realSub = String(j.domain);
      } catch { /* tarmoq xatosi — kiritilgan subdomen bilan davom etamiz */ }
    }
    config = { subdomain: realSub, token_enc: tokenEnc };
  } else {
    const url = String(body.url ?? '').trim();
    if (!isSafeWebhookUrl(url)) return res.status(400).json({ success: false, error: 'Webhook manzili https:// bilan boshlanadigan tashqi manzil bo\'lsin.' });
    const secret = typeof body.secret === 'string' ? body.secret.trim() : '';
    config = { url, secret_enc: secret ? encryptFor(CRM_SECRET_PURPOSE, secret) : old.secret_enc ?? null };
  }
  const { data, error } = await supabase
    .from('company_integrations')
    .upsert({ company_id: companyId, provider, config, enabled: true, last_error: null, updated_at: new Date().toISOString(), ...(resetPull ? { pull_at: null, pull_error: null } : {}) }, { onConflict: 'company_id,provider' })
    .select('provider, config, enabled, last_push_at, last_error, pushed_count, pull_at, pull_error')
    .single();
  if (error) return res.status(500).json({ success: false, error: /provider_check/.test(error.message) ? 'Meta uchun SQL hali ishga tushirilmagan (supabase/crm_04_target_meta.sql).' : error.message });
  if (provider === 'meta') void syncMetaAds(companyId).catch(() => { /* pull_error'ga yozilgan */ });
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
  if (provider === 'meta') {
    try {
      const token = decryptFor(CRM_SECRET_PURPOSE, (row as any).config?.token_enc);
      if (!token) throw new Error('Token o\'qilmadi — qayta saqlang.');
      const info = await accountInfo(token, String((row as any).config?.account_id));
      return res.status(200).json({ success: true, data: { result: `${info.name} · ${info.currency}${info.active ? '' : ' · hisob faol emas'}` } });
    } catch (e: any) {
      return res.status(502).json({ success: false, error: String(e?.message || e).slice(0, 300) });
    }
  }
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

// POST /meta/accounts — {token} bilan reklama hisoblari (saqlanmaydi).
router.post('/meta/accounts', async (req: CompanyAuthedRequest, res: Response) => {
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  if (!token) return res.status(400).json({ success: false, error: 'Meta access token kiriting.' });
  try {
    return res.status(200).json({ success: true, data: { accounts: await listAdAccounts(token) } });
  } catch (e: any) {
    return res.status(400).json({ success: false, error: e?.message || 'Meta tokenni qabul qilmadi.' });
  }
});

// POST /meta/sync — reklama xarajatlarini hozir yangilash (fonda).
router.post('/meta/sync', async (req: CompanyAuthedRequest, res: Response) => {
  void syncMetaAds(req.auth!.companyId as string).catch(() => { /* pull_error'ga yozilgan */ });
  return res.status(202).json({ success: true, data: { started: true } });
});

// POST /amocrm/sync — pul ma'lumotlarini hozir yangilash (fonda; natija
// /analytics/crm-money'da). Worker baribir har 10 daqiqada yangilaydi.
router.post('/amocrm/sync', async (req: CompanyAuthedRequest, res: Response) => {
  const companyId = req.auth!.companyId as string;
  void syncCompanyDeals(companyId).catch(() => { /* pull_error'ga yozilgan */ });
  return res.status(202).json({ success: true, data: { started: true } });
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
