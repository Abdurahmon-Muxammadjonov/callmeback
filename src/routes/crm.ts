import { Router, Request, Response } from 'express';
import { supabase } from '../lib/supabase';
import { connect, getUsers, getStatus, markSynced } from '../lib/amocrm';
import { enqueueBatchCalls, type BatchCallItem } from './analyze-call';
import { randomUUID } from 'node:crypto';
import { runPbxHistorySync } from '../scripts/sync-pbx-history';

const router = Router();
const INTERNAL_PBX_WEBHOOK_PATH = '/crm/webhook/pbx';
const TEST_CONNECTION_TIMEOUT_MS = 10000;

type PbxConfigRow = {
  id?: string;
  enabled?: boolean | null;
  webhook_url?: string | null;
  api_key?: string | null;
  last_test_status?: number | null;
  last_test_at?: string | null;
  updated_at?: string | null;
};

const isValidHttpUrl = (v: string) => {
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
};

async function reloadSchemaCache(): Promise<void> {
  try {
    const schemaClient = typeof (supabase as any).schema === 'function'
      ? (supabase as any).schema('pg_catalog')
      : supabase;
    if (typeof (schemaClient as any).rpc === 'function') {
      await (schemaClient as any).rpc('pg_notify', { channel: 'pgrst', payload: 'reload schema' });
    }
  } catch (error: any) {
    console.warn('PostgREST schema reload failed:', error?.message || error);
  }
}

async function withSchemaReloadRetry<T>(action: () => PromiseLike<{ data: T; error: any }>): Promise<{ data: T; error: any }> {
  const first = await action();
  if (!first.error) return first;

  await reloadSchemaCache();
  return action();
}

function isInternalPbxWebhookUrl(value: string): boolean {
  if (!isValidHttpUrl(value)) return false;
  try {
    const url = new URL(value);
    return url.pathname.replace(/\/+$/, '') === INTERNAL_PBX_WEBHOOK_PATH;
  } catch {
    return false;
  }
}

async function loadLatestPbxIntegration(options: { onlyEnabled?: boolean } = {}): Promise<PbxConfigRow | null> {
  const onlyEnabled = options.onlyEnabled === true;
  const query = supabase
    .from('crm_integrations')
    .select('id, enabled, webhook_url, api_key, last_test_status, last_test_at, updated_at')
    .order('updated_at', { ascending: false })
    .limit(1);

  const targetQuery = onlyEnabled ? query.eq('enabled', true) : query;

  const { data, error } = await withSchemaReloadRetry<PbxConfigRow | null>(() => targetQuery.maybeSingle());

  if (error) throw new Error(`Database Error: ${error.message}`);
  return data || null;
}

async function saveIntegrationTestResult(params: {
  webhookUrl: string;
  apiKey: string;
  statusCode: number;
  enabled?: boolean;
}): Promise<void> {
  if (!params.webhookUrl || !params.apiKey) return;
  const existing = await loadLatestPbxIntegration();
  await withSchemaReloadRetry<null>(() => supabase
    .from('crm_integrations')
    .upsert({
      id: existing?.id || randomUUID(),
      webhook_url: params.webhookUrl,
      api_key: params.apiKey,
      enabled: params.enabled ?? true,
      last_test_status: params.statusCode,
      last_test_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'id' }));
}

function getApiKeyFromRequest(req: Request): string {
  const fromHeader = typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'].trim() : '';
  if (fromHeader) return fromHeader;
  const auth = typeof req.headers.authorization === 'string' ? req.headers.authorization.trim() : '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return typeof req.body?.api_key === 'string' ? req.body.api_key.trim() : '';
}

function getAdminSyncTokenFromRequest(req: Request): string {
  const fromHeader = typeof req.headers['x-admin-sync-token'] === 'string' ? req.headers['x-admin-sync-token'].trim() : '';
  if (fromHeader) return fromHeader;
  const auth = typeof req.headers.authorization === 'string' ? req.headers.authorization.trim() : '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return typeof req.body?.admin_token === 'string' ? req.body.admin_token.trim() : '';
}

function pickString(obj: any, keys: string[]): string {
  for (const key of keys) {
    const v = obj?.[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D+/g, '');
  if (!digits) return '';
  if (digits.length <= 9) return digits;
  return digits.slice(-9);
}

async function findClientByPhone(phoneRaw: string): Promise<{ id: string; name: string; phone: string | null } | null> {
  const normalized = normalizePhone(phoneRaw);
  if (!normalized) return null;

  const { data, error } = await supabase
    .from('users')
    .select('id, name, phone')
    .not('phone', 'is', null)
    .limit(200);
  if (error || !data) return null;

  const found = data.find((u: any) => normalizePhone(String(u.phone || '')) === normalized);
  if (!found) return null;
  return {
    id: String(found.id),
    name: String(found.name || ''),
    phone: found.phone ? String(found.phone) : null,
  };
}

function mimeToExt(mimeType: string): string {
  if (mimeType.includes('wav')) return 'wav';
  if (mimeType.includes('ogg')) return 'ogg';
  if (mimeType.includes('mp4') || mimeType.includes('m4a') || mimeType.includes('aac')) return 'm4a';
  return 'mp3';
}

async function persistAudioToStorage(audioSourceUrl: string, apiKey: string): Promise<{ publicUrl: string; path: string }> {
  const response = await fetch(audioSourceUrl, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; ProcellPBX/1.0)',
      Accept: 'audio/*,*/*',
      'X-API-Key': apiKey,
      Authorization: `Bearer ${apiKey}`,
    },
  });
  if (!response.ok) throw new Error(`Audio download failed: HTTP ${response.status}`);

  const contentType = (response.headers.get('content-type') || 'audio/mpeg').split(';')[0].trim().toLowerCase();
  if (contentType.startsWith('text/') || contentType.includes('html') || contentType.includes('json')) {
    throw new Error(`Audio download failed: non-audio content-type (${contentType})`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new Error('Audio download failed: empty body');

  await supabase.storage.createBucket('recordings', { public: true }).catch(() => {});
  const extension = mimeToExt(contentType);
  const objectPath = `pbx/${new Date().toISOString().slice(0, 10)}/${randomUUID()}.${extension}`;

  const { error: uploadError } = await supabase.storage
    .from('recordings')
    .upload(objectPath, buffer, { contentType, upsert: false });
  if (uploadError) throw new Error(`Audio upload failed: ${uploadError.message}`);

  const { data } = supabase.storage.from('recordings').getPublicUrl(objectPath);
  if (!data?.publicUrl) throw new Error('Audio upload failed: public URL empty');

  return { publicUrl: data.publicUrl, path: objectPath };
}

async function resolveAudioUrlByCallId(callId: string, webhookUrl: string, apiKey: string): Promise<string> {
  const url = new URL(webhookUrl);
  if (!url.searchParams.has('call_id')) url.searchParams.set('call_id', callId);

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: {
      Accept: 'application/json,*/*',
      'X-API-Key': apiKey,
      Authorization: `Bearer ${apiKey}`,
    },
  });
  if (!response.ok) throw new Error(`PBX call lookup failed: HTTP ${response.status}`);

  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (!contentType.includes('application/json')) {
    return url.toString();
  }

  const payload: any = await response.json();
  const fromTop = pickString(payload, ['audio_url', 'audioUrl', 'record_url', 'recordUrl', 'recording_url']);
  if (fromTop) return fromTop;

  const fromCall = payload?.call && typeof payload.call === 'object'
    ? pickString(payload.call, ['audio_url', 'audioUrl', 'record_url', 'recordUrl', 'recording_url'])
    : '';
  if (fromCall) return fromCall;

  throw new Error('PBX call lookup succeeded but audio URL not found');
}

function normalizeWebhookCall(item: any): BatchCallItem {
  const phone = pickString(item, [
    'phone',
    'phone_number',
    'phoneNumber',
    'client_phone',
    'clientPhone',
    'contact_phone',
    'contactPhone',
    'caller_number',
    'callerNumber',
    'callee_number',
    'calleeNumber',
  ]);
  const directionRaw = pickString(item, ['direction', 'call_direction', 'callDirection', 'type', 'call_type']).toLowerCase();
  const direction: 'incoming' | 'outgoing' | 'unknown' =
    directionRaw === 'incoming' || directionRaw === 'inbound' ? 'incoming'
      : directionRaw === 'outgoing' || directionRaw === 'outbound' ? 'outgoing'
      : 'unknown';

  return {
    audio_url: pickString(item, ['audio_url', 'audioUrl', 'record_url', 'recordUrl', 'audio', 'recording_url']),
    manager_name: pickString(item, ['manager_name', 'managerName', 'operator_name', 'operatorName', 'employee_name', 'employeeName', 'user_name', 'userName']),
    manager_id: pickString(item, ['manager_id', 'managerId']),
    platform_id: pickString(item, ['platform_id', 'platformId']),
    crm_id: pickString(item, ['crm_id', 'crmId', 'call_id', 'callId', 'id']),
    pbx_call_id: pickString(item, ['pbx_call_id', 'pbxCallId', 'call_id', 'callId', 'id']),
    direction,
    client_id: pickString(item, ['client_id', 'clientId', 'user_id', 'userId', 'contact_id', 'contactId']),
    client_phone: phone,
    client_name: pickString(item, ['client_name', 'clientName', 'contact_name', 'contactName', 'lead_name', 'leadName']),
    call_status: pickString(item, ['status', 'call_status', 'callStatus', 'event', 'state']),
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

function extractManagersFromPayload(payload: any): any[] {
  if (Array.isArray(payload?.managers)) return payload.managers;
  if (Array.isArray(payload?.users)) return payload.users;
  if (Array.isArray(payload?.employees)) return payload.employees;
  if (Array.isArray(payload?.operators)) return payload.operators;
  return [];
}

function extractCallsFromPayload(payload: any): BatchCallItem[] {
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload?.calls)) return payload.calls.map(normalizeWebhookCall);
  if (Array.isArray(payload?.records)) return payload.records.map(normalizeWebhookCall);
  return [];
}

async function syncManagersFromPayload(managers: any[]): Promise<{ count: number; names: string[] }> {
  if (!Array.isArray(managers) || managers.length === 0) return { count: 0, names: [] };

  const normalizeStatus = (raw: string): string => {
    const value = raw.trim().toLowerCase();
    if (value === 'active' || value === 'inactive' || value === 'on_leave' || value === 'flagged') return value;
    return 'active';
  };

  let inserted = 0;
  const names = new Set<string>();
  for (const item of managers) {
    const name = pickString(item, ['name', 'manager_name', 'managerName', 'operator_name', 'employee_name', 'full_name', 'fullname']);
    if (!name) continue;
    names.add(name);

    const pbxId = pickString(item, ['pbx_id', 'pbxId', 'id', 'user_id', 'userId', 'manager_id', 'managerId']);
    const status = normalizeStatus(pickString(item, ['status', 'state']));
    try {
      if (pbxId) {
        const { error } = await supabase
          .from('managers')
          .upsert({ pbx_id: pbxId, name, status }, { onConflict: 'pbx_id' });
        if (!error) inserted++;
        continue;
      }

      const { data: existing, error: findError } = await supabase
        .from('managers')
        .select('id')
        .eq('name', name)
        .limit(1)
        .maybeSingle();
      if (findError) continue;
      if (existing?.id) continue;

      const { error: insertError } = await supabase
        .from('managers')
        .insert({ name, status });
      if (!insertError) inserted++;
    } catch {
      continue;
    }
  }
  return { count: inserted, names: Array.from(names) };
}

async function syncCallsFromPayload(calls: BatchCallItem[], apiKey: string, webhookUrl: string): Promise<number> {
  if (!Array.isArray(calls) || calls.length === 0) return 0;

  const enrichedCalls: BatchCallItem[] = [];
  for (let index = 0; index < calls.length; index++) {
    const call = calls[index];
    try {
      const status = (call.call_status || '').toLowerCase();
      if (status && ['started', 'ringing', 'in_progress', 'progress'].includes(status) && !call.audio_url) continue;

      const callId = call.pbx_call_id || call.crm_id || '';
      const sourceAudioUrl = call.audio_url
        || (callId && webhookUrl && !isInternalPbxWebhookUrl(webhookUrl)
          ? await resolveAudioUrlByCallId(callId, webhookUrl, apiKey)
          : '');
      if (!sourceAudioUrl) continue;

      const persisted = await persistAudioToStorage(sourceAudioUrl, apiKey);

      let mappedClientId = call.client_id;
      let mappedClientName = call.client_name;
      const phone = call.client_phone || '';
      if (!mappedClientId && phone) {
        const mapped = await findClientByPhone(phone);
        if (mapped) {
          mappedClientId = mapped.id;
          mappedClientName = mappedClientName || mapped.name;
        }
      }

      enrichedCalls.push({
        ...call,
        audio_url: persisted.publicUrl,
        audio_source_url: sourceAudioUrl,
        audio_storage_url: persisted.publicUrl,
        audio_storage_path: persisted.path,
        client_id: mappedClientId,
        client_name: mappedClientName,
        client_phone: phone || undefined,
        pbx_call_id: callId || undefined,
      });
    } catch {
      continue;
    }
  }

  if (enrichedCalls.length === 0) return 0;

  const out = await enqueueBatchCalls(enrichedCalls, supabase);
  if (out.status >= 500) throw new Error(out?.body?.error || 'Call sync xatosi.');
  if (out.status === 202) {
    await markSynced();
    return Number(out?.body?.accepted_count || 0);
  }
  return 0;
}

// GET /crm/status — ulanish holati (OAuth + simple PBX webhook).
router.get('/status', async (_req: Request, res: Response) => {
  try {
    const cfg = await loadLatestPbxIntegration({ onlyEnabled: true });
    const connected = !!(cfg?.enabled && cfg?.last_test_status === 200 && cfg?.webhook_url && cfg?.api_key);
    console.log('[pbx/status] connected=', connected, 'last_test_status=', cfg?.last_test_status ?? null, 'hasWebhook=', !!cfg?.webhook_url);
    return res.status(200).json({ connected });
  } catch (e: any) {
    console.log('[pbx/status] connected=false reason=', e?.message || e);
    return res.status(200).json({ connected: false });
  }
});

// POST /crm/connect-simple
// Body: { webhook_url, api_key }
router.post('/connect-simple', async (req: Request, res: Response) => {
  try {
    const webhookUrl = typeof req.body?.webhook_url === 'string' ? req.body.webhook_url.trim() : '';
    const apiKey = typeof req.body?.api_key === 'string' ? req.body.api_key.trim() : '';
    const enabled = true;

    if (!webhookUrl || !isValidHttpUrl(webhookUrl)) {
      return res.status(400).json({ success: false, error: '"webhook_url" yaroqli URL bo\'lishi kerak.' });
    }
    if (!apiKey) {
      return res.status(400).json({ success: false, error: '"api_key" majburiy.' });
    }

    const existing = await loadLatestPbxIntegration();
    const { error } = await withSchemaReloadRetry<null>(() => supabase
      .from('crm_integrations')
      .upsert({
        id: existing?.id || randomUUID(),
        webhook_url: webhookUrl,
        api_key: apiKey,
        enabled,
        last_test_status: null,
        last_test_at: null,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'id' }));

    if (error) return res.status(500).json({ success: false, error: `Database Error: ${error.message}` });

    return res.status(200).json({ success: true });
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

    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), TEST_CONNECTION_TIMEOUT_MS);

    let testResponse: globalThis.Response;
    try {
      testResponse = await fetch(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ test: true, source: 'salespulse', api_key: apiKey, timestamp: new Date().toISOString() }),
        signal: abortController.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }

    console.log('[pbx/test-connection] upstream status=', testResponse.status, testResponse.statusText, 'url=', webhookUrl);

    if (testResponse.status === 404) {
      await saveIntegrationTestResult({ webhookUrl, apiKey, statusCode: 404, enabled: true });
      return res.status(404).json({
        success: false,
        error: 'Webhook route topilmadi (404). URL noto\'g\'ri yoki backendda route yo\'q.',
      });
    }

    if (testResponse.status === 401 || testResponse.status === 403) {
      await saveIntegrationTestResult({ webhookUrl, apiKey, statusCode: testResponse.status, enabled: true });
      return res.status(401).json({
        success: false,
        error: "API key noto'g'ri yoki webhook autentifikatsiyasi muvaffaqiyatsiz",
      });
    }

    if (!testResponse.ok) {
      await saveIntegrationTestResult({ webhookUrl, apiKey, statusCode: testResponse.status, enabled: true });
      return res.status(400).json({
        success: false,
        error: `PBX javob berdi: ${testResponse.status} ${testResponse.statusText}`,
      });
    }

    if (isInternalPbxWebhookUrl(webhookUrl)) {
      await saveIntegrationTestResult({ webhookUrl, apiKey, statusCode: 200, enabled: true });
      return res.status(200).json({
        success: true,
        message: 'PBX sync muvaffaqiyatli, 0 xodim + 0 audio yuklandi',
        managers_synced: 0,
        calls_synced: 0,
        manager_names: [],
      });
    }

    let payload: any = {};
    try {
      const contentType = (testResponse.headers.get('content-type') || '').toLowerCase();
      if (contentType.includes('application/json')) {
        payload = await testResponse.json();
      } else {
        const text = await testResponse.text();
        payload = text ? JSON.parse(text) : {};
      }
    } catch {
      payload = {};
    }

    const managersPayload = extractManagersFromPayload(payload);
    const callsPayload = extractCallsFromPayload(payload);
    if (managersPayload.length === 0 && callsPayload.length === 0) {
      await saveIntegrationTestResult({ webhookUrl, apiKey, statusCode: 404, enabled: true });
      return res.status(404).json({
        success: false,
        error: 'Webhook ishladi, lekin hech qanday managers yoki calls ma\'lumoti kelmadi. PBX response formatini tekshiring.',
      });
    }

    const managersSync = await syncManagersFromPayload(managersPayload);
    const callsInserted = await syncCallsFromPayload(callsPayload, apiKey, webhookUrl);
    await saveIntegrationTestResult({ webhookUrl, apiKey, statusCode: 200, enabled: true });

    return res.status(200).json({
      success: true,
      message: `PBX sync muvaffaqiyatli, ${managersSync.count} xodim + ${callsInserted} audio yuklandi`,
      managers_synced: managersSync.count,
      calls_synced: callsInserted,
      manager_names: managersSync.names,
    });
  } catch (e: any) {
    const isAbort = e?.name === 'AbortError';
    if (isAbort) {
      await saveIntegrationTestResult({
        webhookUrl: typeof req.body?.webhook_url === 'string' ? req.body.webhook_url.trim() : '',
        apiKey: typeof req.body?.api_key === 'string' ? req.body.api_key.trim() : '',
        statusCode: 408,
        enabled: true,
      }).catch(() => {});
      return res.status(400).json({
        success: false,
        error: `PBX webhook'ga ulana olmadi: timeout (${TEST_CONNECTION_TIMEOUT_MS}ms)`,
      });
    }
    await saveIntegrationTestResult({
      webhookUrl: typeof req.body?.webhook_url === 'string' ? req.body.webhook_url.trim() : '',
      apiKey: typeof req.body?.api_key === 'string' ? req.body.api_key.trim() : '',
      statusCode: 0,
      enabled: true,
    }).catch(() => {});
    return res.status(400).json({
      success: false,
      error: `PBX webhook'ga ulana olmadi: ${e instanceof Error ? e.message : 'network error'}`,
    });
  }
});

// GET /crm/dashboard/managers — amoCRM managers darhol sinxron qilib, dashboard'ga ko'rsatish
router.get('/dashboard/managers', async (req: Request, res: Response) => {
  try {
    const hasIntegration = await supabase
      .from('crm_integrations')
      .select('id, enabled')
      .eq('enabled', true)
      .maybeSingle();

    if (!hasIntegration?.data?.id) {
      return res.status(403).json({
        success: false,
        error: '❌ amoCRM ulangan emas. Avval /crm/connect orqali ulang.',
        managers_count: 0,
        managers: [],
      });
    }

    try {
      const syncResult = await syncManagers();
      console.log(`[dashboard/managers] Sync: ${syncResult.synced} synced, ${syncResult.failed} failed`);
    } catch (syncErr: any) {
      console.warn('[dashboard/managers] Auto-sync xatosi:', syncErr?.message);
    }

    const { data: managers, error: fetchErr } = await supabase
      .from('managers')
      .select('id, crm_id, name, status')
      .order('created_at', { ascending: false });

    if (fetchErr) {
      return res.status(500).json({
        success: false,
        error: `Managers yuklab bo'lmadi: ${fetchErr.message}`,
        managers_count: 0,
        managers: [],
      });
    }

    const activeCount = (managers || []).filter((m) => m.status !== 'inactive').length;
    return res.status(200).json({
      success: true,
      message: `${activeCount}/${(managers || []).length} ta ishchi aktiv`,
      managers_count: managers?.length || 0,
      active_count: activeCount,
      managers: managers || [],
    });
  } catch (e: any) {
    return res.status(500).json({
      success: false,
      error: e?.message || 'Dashboard managers xatosi',
      managers_count: 0,
      managers: [],
    });
  }
});

// Bitta webhook payload'idagi qo'ng'iroqlarni (audio yuklab olish, Storage'ga yozish,
// tahlilga qo'yish) fon rejimida ishlaydi. Bu og'ir ish PBX'ning javob kutish vaqtidan
// (yoki Railway proxy timeout'idan) chiqib ketmasligi uchun response'dan KEYIN ishga tushadi.
async function processPbxWebhookCallsInBackground(
  calls: BatchCallItem[],
  webhookUrl: string,
  expectedKey: string,
): Promise<void> {
  const enrichedCalls: BatchCallItem[] = [];
  const skipped: Array<{ index: number; error: string }> = [];

  for (let index = 0; index < calls.length; index++) {
    const call = calls[index];
    try {
      const status = (call.call_status || '').toLowerCase();
      if (status && ['started', 'ringing', 'in_progress', 'progress'].includes(status) && !call.audio_url) {
        skipped.push({ index, error: `call hali tugamagan (${status})` });
        continue;
      }

      const callId = call.pbx_call_id || call.crm_id || '';
      const sourceAudioUrl = call.audio_url
        || (callId && webhookUrl && !isInternalPbxWebhookUrl(webhookUrl)
          ? await resolveAudioUrlByCallId(callId, webhookUrl, expectedKey)
          : '');
      if (!sourceAudioUrl) {
        skipped.push({ index, error: 'audio_url topilmadi (payload yoki PBX lookup orqali).' });
        continue;
      }

      const persisted = await persistAudioToStorage(sourceAudioUrl, expectedKey);

      let mappedClientId = call.client_id;
      let mappedClientName = call.client_name;
      const phone = call.client_phone || '';
      if (!mappedClientId && phone) {
        const mapped = await findClientByPhone(phone);
        if (mapped) {
          mappedClientId = mapped.id;
          mappedClientName = mappedClientName || mapped.name;
        }
      }

      enrichedCalls.push({
        ...call,
        audio_url: persisted.publicUrl,
        audio_source_url: sourceAudioUrl,
        audio_storage_url: persisted.publicUrl,
        audio_storage_path: persisted.path,
        client_id: mappedClientId,
        client_name: mappedClientName,
        client_phone: phone || undefined,
        pbx_call_id: callId || undefined,
      });
    } catch (e: any) {
      skipped.push({ index, error: e?.message || 'Webhook call processing failed' });
    }
  }

  if (skipped.length > 0) {
    console.warn(`PBX webhook: ${skipped.length} ta qo'ng'iroq o'tkazib yuborildi:`, skipped);
  }

  if (enrichedCalls.length === 0) return;

  try {
    const out = await enqueueBatchCalls(enrichedCalls, supabase);
    if (out.status === 202) await markSynced();
    else console.error('PBX webhook fon rejimidagi enqueue xatosi:', out.body);
  } catch (e: any) {
    console.error('PBX webhook fon rejimidagi xato:', e?.message || e);
  }
}

router.post('/webhook/pbx', async (req: Request, res: Response) => {
  try {
    const cfg = await loadLatestPbxIntegration({ onlyEnabled: true });

    const expectedKey = typeof cfg?.api_key === 'string' ? cfg.api_key.trim() : '';
    if (!expectedKey || cfg?.enabled === false) {
      return res.status(401).json({ success: false, error: 'Noto\'g\'ri API key.' });
    }

    const providedKey = getApiKeyFromRequest(req);
    if (!providedKey || providedKey !== expectedKey) {
      return res.status(401).json({ success: false, error: 'Noto\'g\'ri API key.' });
    }

    if (req.body?.test === true) {
      return res.status(200).json({ success: true });
    }

    const calls = extractWebhookCalls(req.body);
    if (calls.length === 0) {
      return res.status(400).json({ success: false, error: 'Payloadda yaroqli qo\'ng\'iroq topilmadi (audio_url kerak).' });
    }

    // PBX'ga DARHOL javob qaytaramiz — audio yuklab olish/Storage'ga yozish uzoq
    // vaqt olishi mumkin, shu tufayli PBX yoki proxy connectionni ECONNRESET bilan
    // uzib yubormasligi uchun qolgan ishlov fon rejimida davom etadi.
    res.status(202).json({
      success: true,
      status: 'processing',
      source: 'pbx-webhook',
      message: 'PBX webhook qabul qilindi, fon rejimida ishlanmoqda.',
      received_count: calls.length,
    });

    const webhookUrl = typeof cfg?.webhook_url === 'string' ? cfg.webhook_url.trim() : '';
    void processPbxWebhookCallsInBackground(calls, webhookUrl, expectedKey);
  } catch (e: any) {
    if (!res.headersSent) {
      return res.status(500).json({ success: false, error: e?.message || 'PBX webhook xatosi.' });
    }
    console.error('PBX webhook xatosi (javob allaqachon yuborilgan):', e?.message || e);
  }
});

// POST /crm/admin/sync-calls
// Bir martalik tarixiy sync (PBX history -> storage -> calls).
// Himoya: ADMIN_SYNC_TOKEN env va x-admin-sync-token header.
router.post('/admin/sync-calls', async (req: Request, res: Response) => {
  try {
    const expectedToken = (process.env.ADMIN_SYNC_TOKEN || '').trim();
    if (!expectedToken) {
      return res.status(500).json({ success: false, error: 'ADMIN_SYNC_TOKEN sozlanmagan.' });
    }

    const providedToken = getAdminSyncTokenFromRequest(req);
    if (!providedToken || providedToken !== expectedToken) {
      return res.status(401).json({ success: false, error: 'Admin token noto\'g\'ri.' });
    }

    const weeks = Number(req.body?.weeks ?? req.query?.weeks ?? 0) || undefined;
    const months = Number(req.body?.months ?? req.query?.months ?? 0) || undefined;
    const from = typeof (req.body?.from ?? req.query?.from) === 'string' ? String(req.body?.from ?? req.query?.from) : undefined;
    const to = typeof (req.body?.to ?? req.query?.to) === 'string' ? String(req.body?.to ?? req.query?.to) : undefined;
    const limit = Number(req.body?.limit ?? req.query?.limit ?? 0) || undefined;
    const maxPages = Number(req.body?.max_pages ?? req.query?.max_pages ?? 0) || undefined;
    const retryCount = Number(req.body?.retry_count ?? req.query?.retry_count ?? 0) || undefined;
    const retryDelayMs = Number(req.body?.retry_delay_ms ?? req.query?.retry_delay_ms ?? 0) || undefined;
    const requestTimeoutMs = Number(req.body?.request_timeout_ms ?? req.query?.request_timeout_ms ?? 0) || undefined;
    const audioTimeoutMs = Number(req.body?.audio_timeout_ms ?? req.query?.audio_timeout_ms ?? 0) || undefined;
    const chunkSize = Number(req.body?.chunk_size ?? req.query?.chunk_size ?? 0) || undefined;
    const writeBatchSize = Number(req.body?.write_batch_size ?? req.query?.write_batch_size ?? 0) || undefined;
    const chunkUnitRaw = req.body?.chunk_unit ?? req.query?.chunk_unit;
    const chunkUnit = chunkUnitRaw === 'month' || chunkUnitRaw === 'day' || chunkUnitRaw === 'hour' ? chunkUnitRaw : undefined;

    const result = await runPbxHistorySync({
      weeks,
      months,
      from,
      to,
      limit,
      maxPages,
      retryCount,
      retryDelayMs,
      requestTimeoutMs,
      audioTimeoutMs,
      chunkUnit,
      chunkSize,
      writeBatchSize,
    });
    await markSynced();

    return res.status(200).json({
      success: true,
      message: 'Tarixiy call sync yakunlandi.',
      result,
    });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e?.message || 'Tarixiy sync xatosi.' });
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
