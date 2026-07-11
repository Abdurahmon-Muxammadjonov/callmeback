import { Router, Request, Response } from 'express';
import { supabase } from '../lib/supabase';
import { connect, getUsers, getStatus, markSynced } from '../lib/amocrm';
import { enqueueBatchCalls, type BatchCallItem } from './analyze-call';

const router = Router();
const CRM_ACCOUNT_ID = 'amocrm';

const isValidHttpUrl = (v: string) => {
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
};

function getApiKeyFromRequest(req: Request): string {
  const fromHeader = typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'].trim() : '';
  if (fromHeader) return fromHeader;
  const auth = typeof req.headers.authorization === 'string' ? req.headers.authorization.trim() : '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return typeof req.body?.api_key === 'string' ? req.body.api_key.trim() : '';
}

function pickString(obj: any, keys: string[]): string {
  for (const key of keys) {
    const v = obj?.[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

function normalizeWebhookCall(item: any): BatchCallItem {
  return {
    audio_url: pickString(item, ['audio_url', 'audioUrl', 'record_url', 'recordUrl', 'audio', 'recording_url']),
    manager_name: pickString(item, ['manager_name', 'managerName', 'operator_name', 'operatorName', 'employee_name', 'employeeName', 'user_name', 'userName']),
    manager_id: pickString(item, ['manager_id', 'managerId']),
    platform_id: pickString(item, ['platform_id', 'platformId']),
    crm_id: pickString(item, ['crm_id', 'crmId', 'call_id', 'callId', 'id']),
  };
}

function extractWebhookCalls(payload: any): BatchCallItem[] {
  if (Array.isArray(payload?.calls)) return payload.calls.map(normalizeWebhookCall);
  if (Array.isArray(payload?.records)) return payload.records.map(normalizeWebhookCall);
  if (payload?.call && typeof payload.call === 'object') return [normalizeWebhookCall(payload.call)];
  if (payload && typeof payload === 'object') {
    const one = normalizeWebhookCall(payload);
    if (one.audio_url || one.crm_id || one.manager_name || one.manager_id) return [one];
  }
  return [];
}

// GET /crm/status — ulanish holati (OAuth + simple PBX webhook).
router.get('/status', async (_req: Request, res: Response) => {
  try {
    const oauth = await getStatus();
    const { data: cfg } = await supabase
      .from('crm_accounts')
      .select('webhook_url, api_key, subdomain, access_token, last_sync')
      .eq('id', CRM_ACCOUNT_ID)
      .maybeSingle();

    const simpleConnected = !!(cfg?.webhook_url && cfg?.api_key);
    return res.status(200).json({
      success: true,
      connected: oauth.connected || simpleConnected,
      oauth_connected: !!oauth.connected,
      simple_connected: simpleConnected,
      subdomain: oauth.subdomain || cfg?.subdomain || null,
      webhook_url: cfg?.webhook_url || null,
      last_sync: oauth.last_sync ?? cfg?.last_sync ?? null,
    });
  } catch (e: any) {
    return res.status(200).json({ success: true, connected: false, oauth_connected: false, simple_connected: false, error: e?.message });
  }
});

// POST /crm/connect-simple
// Body: { webhook_url, api_key }
router.post('/connect-simple', async (req: Request, res: Response) => {
  try {
    const webhookUrl = typeof req.body?.webhook_url === 'string' ? req.body.webhook_url.trim() : '';
    const apiKey = typeof req.body?.api_key === 'string' ? req.body.api_key.trim() : '';

    if (!webhookUrl || !isValidHttpUrl(webhookUrl)) {
      return res.status(400).json({ success: false, error: '"webhook_url" yaroqli URL bo\'lishi kerak.' });
    }
    if (!apiKey) {
      return res.status(400).json({ success: false, error: '"api_key" majburiy.' });
    }

    const { error } = await supabase
      .from('crm_accounts')
      .upsert({
        id: CRM_ACCOUNT_ID,
        webhook_url: webhookUrl,
        api_key: apiKey,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'id' });

    if (error) return res.status(500).json({ success: false, error: `Database Error: ${error.message}` });

    return res.status(200).json({
      success: true,
      connected: true,
      simple_connected: true,
      webhook_url: webhookUrl,
      note: 'PBX webhook sozlamasi saqlandi. Endi webhook eventlari kelishi bilan qo\'ng\'iroqlar avtomatik tahlilga tushadi.',
    });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e?.message || 'connect-simple xatosi.' });
  }
});

// POST /crm/test-connection
// Body: { webhook_url, api_key }
// Test PBX ulanishni: webhook'ga test request yubor va javobni tekshir.
router.post('/test-connection', async (req: Request, res: Response) => {
  try {
    const webhookUrl = typeof req.body?.webhook_url === 'string' ? req.body.webhook_url.trim() : '';
    const apiKey = typeof req.body?.api_key === 'string' ? req.body.api_key.trim() : '';

    if (!webhookUrl || !apiKey) {
      return res.status(400).json({
        success: false,
        error: 'webhook_url va api_key talab qilinadi',
      });
    }

    if (!isValidHttpUrl(webhookUrl)) {
      return res.status(400).json({
        success: false,
        error: 'Webhook URL noto\'g\'ri formatda',
      });
    }

    const testResponse = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': apiKey,
      },
      body: JSON.stringify({ test: true }),
    });

    if (!testResponse.ok) {
      return res.status(400).json({
        success: false,
        error: `PBX javob berdi: ${testResponse.status} ${testResponse.statusText}`,
      });
    }

    return res.status(200).json({
      success: true,
      message: 'PBX ulanish muvaffaqiyatli ✓',
    });
  } catch (e: any) {
    return res.status(400).json({
      success: false,
      error: 'PBX\'ga ulanib bo\'lmadi: ' + (e instanceof Error ? e.message : 'Noto\'g\'ri URL yoki server mavjud emas'),
    });
  }
});

// POST /crm/webhook/pbx
// PBX eventlarini qabul qiladi, qo'ng'iroqlarni background Gemini tahliliga yuboradi.
router.post('/webhook/pbx', async (req: Request, res: Response) => {
  try {
    const { data: cfg, error: cfgErr } = await supabase
      .from('crm_accounts')
      .select('api_key')
      .eq('id', CRM_ACCOUNT_ID)
      .maybeSingle();
    if (cfgErr) return res.status(500).json({ success: false, error: `Database Error: ${cfgErr.message}` });

    const expectedKey = typeof cfg?.api_key === 'string' ? cfg.api_key.trim() : '';
    if (!expectedKey) {
      return res.status(400).json({ success: false, error: 'CRM simple ulanish yoqilmagan: avval /crm/connect-simple ni chaqiring.' });
    }

    const providedKey = getApiKeyFromRequest(req);
    if (!providedKey || providedKey !== expectedKey) {
      return res.status(401).json({ success: false, error: 'Noto\'g\'ri API key.' });
    }

    const calls = extractWebhookCalls(req.body);
    if (calls.length === 0) {
      return res.status(400).json({ success: false, error: 'Payloadda yaroqli qo\'ng\'iroq topilmadi (audio_url kerak).' });
    }

    const out = await enqueueBatchCalls(calls, supabase);
    if (out.status === 202) await markSynced();

    return res.status(out.status).json({
      ...out.body,
      source: 'pbx-webhook',
      received_count: calls.length,
    });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e?.message || 'PBX webhook xatosi.' });
  }
});

// POST /crm/connect — sozlamalarni saqlab, OAuth code'ni token'ga almashtiradi.
// Body: { subdomain, client_id, client_secret, redirect_uri, code }
router.post('/connect', async (req: Request, res: Response) => {
  try {
    const { subdomain, client_id, client_secret, redirect_uri, code } = req.body ?? {};
    for (const [k, v] of Object.entries({ subdomain, client_id, client_secret, redirect_uri, code })) {
      if (!v || typeof v !== 'string') {
        return res.status(400).json({ success: false, error: `"${k}" majburiy.` });
      }
    }
    const out = await connect({ subdomain, client_id, client_secret, redirect_uri, code });

    let managers: { synced: number; failed: number } | null = null;
    try {
      managers = await syncManagers();
      await markSynced();
    } catch (e: any) {
      console.error('Connect-dan keyin avtomatik sync xatosi:', e?.message);
    }

    return res.status(200).json({ success: true, ...out, managers });
  } catch (e: any) {
    return res.status(502).json({ success: false, error: e?.message || 'amoCRM ulanish xatosi.' });
  }
});

// amoCRM foydalanuvchilarini (sotuvchilar) → managers ga crm_id bo'yicha upsert.
// Mavjud menejer status'i (masalan 'flagged') saqlanadi — faqat ism yangilanadi.
async function syncManagers(): Promise<{ synced: number; failed: number }> {
  const users = await getUsers();
  let synced = 0;
  let failed = 0;
  for (const u of users) {
    const row = { crm_id: String(u.id), name: u.name || u.email || `amo-${u.id}` };
    const { error } = await supabase.from('managers').upsert(row, { onConflict: 'crm_id' });
    if (error) { failed++; console.error(`Manager sync ${u.id} failed:`, error.message); }
    else synced++;
  }
  return { synced, failed };
}

// POST /crm/sync — qo'lda sinxron. Hozircha menejerlarni sinxronlaydi.
router.post('/sync', async (_req: Request, res: Response) => {
  try {
    const managers = await syncManagers();
    await markSynced();
    return res.status(200).json({
      success: true,
      managers,
      note: 'Menejerlar sinxronlandi. Qo\'ng\'iroq/audio sinxroni telefoniya integratsiyasi ulangach yoqiladi.',
    });
  } catch (e: any) {
    return res.status(502).json({ success: false, error: e?.message || 'Sinxron xatosi.' });
  }
});

export async function runScheduledCrmSync(): Promise<void> {
  try {
    const status = await getStatus();
    if (!status.connected) return;
    const r = await syncManagers();
    await markSynced();
    if (r.synced) console.log(`🔄 CRM cron sync: ${r.synced} menejer yangilandi${r.failed ? `, ${r.failed} xato` : ''}.`);
  } catch (e: any) {
    console.error('CRM cron sync xatosi:', e?.message);
  }
}

export default router;
