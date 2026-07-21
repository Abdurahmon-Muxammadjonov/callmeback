import '../env';

import { randomUUID } from 'node:crypto';
import { Agent, setGlobalDispatcher } from 'undici';
import { supabase } from '../lib/supabase';

type Direction = 'incoming' | 'outgoing' | 'unknown';

interface PbxHistoryCall {
  raw: any;
  pbxCallId: string;
  crmId: string;
  startedAt: string | null;
  direction: Direction;
  durationSec: number;
  managerName: string;
  managerId?: string;
  clientPhone: string;
  clientName?: string;
  sourceAudioUrl: string;
}

interface SyncCounters {
  fetched: number;
  imported: number;
  skippedExisting: number;
  skippedInvalid: number;
  failed: number;
}

interface SyncRuntimeConfig {
  historyApiUrl: string;
  apiKey: string;
  audioByCallApiUrl: string;
  audioBucket: string;
  defaultLimit: number;
  maxPages: number;
  requestTimeoutMs: number;
  audioTimeoutMs: number;
  retryCount: number;
  retryDelayMs: number;
  chunkUnit: 'hour' | 'day' | 'month';
  chunkSize: number;
  writeBatchSize: number;
  maxAudioBytes: number;
}

interface RunSyncOptions {
  from?: string;
  to?: string;
  weeks?: number;
  months?: number;
  limit?: number;
  maxPages?: number;
  requestTimeoutMs?: number;
  audioTimeoutMs?: number;
  retryCount?: number;
  retryDelayMs?: number;
  chunkUnit?: 'hour' | 'day' | 'month';
  chunkSize?: number;
  writeBatchSize?: number;
  maxAudioBytes?: number;
}

type RetryableContext = {
  attempt: number;
  retries: number;
  error: unknown;
};

type CallInsertRow = Record<string, any>;

const pbxAgent = new Agent({
  keepAliveTimeout: Number(process.env.PBX_KEEP_ALIVE_TIMEOUT_MS || '30000'),
  keepAliveMaxTimeout: Number(process.env.PBX_KEEP_ALIVE_MAX_TIMEOUT_MS || '120000'),
  connections: Number(process.env.PBX_KEEP_ALIVE_CONNECTIONS || '20'),
  pipelining: Number(process.env.PBX_KEEP_ALIVE_PIPELINING || '1'),
});
setGlobalDispatcher(pbxAgent);

function getRuntimeConfig(overrides: RunSyncOptions = {}): SyncRuntimeConfig {
  const historyApiUrl = (process.env.PBX_HISTORY_API_URL || '').trim();
  const apiKey = (process.env.PBX_API_KEY || '').trim();
  const audioByCallApiUrl = (process.env.PBX_AUDIO_BY_CALL_API_URL || '').trim();
  const audioBucket = (process.env.PBX_AUDIO_BUCKET || 'recordings').trim() || 'recordings';
  const defaultLimit = Number(overrides.limit ?? process.env.PBX_HISTORY_PAGE_LIMIT ?? '100');
  const maxPages = Number(overrides.maxPages ?? process.env.PBX_HISTORY_MAX_PAGES ?? '500');
  const requestTimeoutMs = Number(overrides.requestTimeoutMs ?? process.env.PBX_REQUEST_TIMEOUT_MS ?? '20000');
  const audioTimeoutMs = Number(overrides.audioTimeoutMs ?? process.env.PBX_AUDIO_TIMEOUT_MS ?? '90000');
  const retryCount = Number(overrides.retryCount ?? process.env.PBX_RETRY_COUNT ?? '3');
  const retryDelayMs = Number(overrides.retryDelayMs ?? process.env.PBX_RETRY_DELAY_MS ?? '1500');
  const chunkUnitRaw = String(overrides.chunkUnit ?? process.env.PBX_SYNC_CHUNK_UNIT ?? 'day').trim().toLowerCase();
  const chunkUnit: 'hour' | 'day' | 'month' = chunkUnitRaw === 'hour'
    ? 'hour'
    : (chunkUnitRaw === 'month' ? 'month' : 'day');
  const chunkSize = Number(overrides.chunkSize ?? process.env.PBX_SYNC_CHUNK_SIZE ?? (chunkUnit === 'month' ? '1' : (chunkUnit === 'hour' ? '6' : '7')));
  const writeBatchSize = Number(overrides.writeBatchSize ?? process.env.PBX_WRITE_BATCH_SIZE ?? '20');
  const maxAudioBytes = Number(overrides.maxAudioBytes ?? process.env.PBX_MAX_AUDIO_BYTES ?? `${100 * 1024 * 1024}`);

  if (!historyApiUrl) {
    throw new Error('PBX_HISTORY_API_URL majburiy (history endpoint URL).');
  }
  if (!apiKey) {
    throw new Error('PBX_API_KEY majburiy.');
  }

  return {
    historyApiUrl,
    apiKey,
    audioByCallApiUrl,
    audioBucket,
    defaultLimit,
    maxPages,
    requestTimeoutMs: Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0 ? requestTimeoutMs : 20000,
    audioTimeoutMs: Number.isFinite(audioTimeoutMs) && audioTimeoutMs > 0 ? audioTimeoutMs : 90000,
    retryCount: Number.isFinite(retryCount) && retryCount >= 0 ? Math.min(10, Math.floor(retryCount)) : 3,
    retryDelayMs: Number.isFinite(retryDelayMs) && retryDelayMs > 0 ? retryDelayMs : 1500,
    chunkUnit,
    chunkSize: Number.isFinite(chunkSize) && chunkSize > 0 ? Math.floor(chunkSize) : (chunkUnit === 'month' ? 1 : (chunkUnit === 'hour' ? 6 : 7)),
    writeBatchSize: Number.isFinite(writeBatchSize) && writeBatchSize > 0 ? Math.floor(writeBatchSize) : 20,
    maxAudioBytes: Number.isFinite(maxAudioBytes) && maxAudioBytes > 0 ? Math.floor(maxAudioBytes) : (100 * 1024 * 1024),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableHttpStatus(status: number): boolean {
  return [408, 425, 429, 500, 502, 503, 504].includes(status);
}

function isRetryableNetworkError(error: unknown): boolean {
  const e = error as any;
  const code = String(e?.code || e?.cause?.code || '').toUpperCase();
  if (['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) {
    return true;
  }

  const name = String(e?.name || '').toLowerCase();
  if (name.includes('abort')) return true;

  const message = String(e?.message || '').toLowerCase();
  return (
    message.includes('econnreset')
    || message.includes('socket hang up')
    || message.includes('network error')
    || message.includes('timed out')
    || message.includes('fetch failed')
    || message.includes('aborted')
  );
}

function installProcessGuards(scope: string): void {
  process.on('unhandledRejection', (reason) => {
    console.error(`[${scope}] unhandledRejection:`, (reason as any)?.message || reason);
  });

  process.on('uncaughtException', (error) => {
    const msg = (error as any)?.message || String(error);
    if (isRetryableNetworkError(error)) {
      console.error(`[${scope}] uncaughtException network:`, msg);
      return;
    }
    console.error(`[${scope}] uncaughtException:`, msg);
  });
}

async function runWithRetry<T>(
  task: (attempt: number) => Promise<T>,
  options: {
    retries: number;
    delayMs: number;
    shouldRetry?: (ctx: RetryableContext) => boolean;
    onRetry?: (ctx: RetryableContext) => void;
  },
): Promise<T> {
  const maxAttempts = Math.max(1, options.retries + 1);
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await task(attempt);
    } catch (error) {
      lastError = error;
      const shouldRetry = options.shouldRetry ? options.shouldRetry({ attempt, retries: options.retries, error }) : true;
      const canRetry = shouldRetry && attempt < maxAttempts;
      if (!canRetry) throw error;

      options.onRetry?.({ attempt, retries: options.retries, error });
      await sleep(Math.max(0, options.delayMs));
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Retry jarayoni noma’lum xato bilan tugadi.');
}

function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D+/g, '');
  if (!digits) return '';
  if (digits.length <= 9) return digits;
  return digits.slice(-9);
}

function toDirection(raw: string): Direction {
  const v = raw.toLowerCase();
  if (v === 'incoming' || v === 'inbound') return 'incoming';
  if (v === 'outgoing' || v === 'outbound') return 'outgoing';
  return 'unknown';
}

function pickString(obj: any, keys: string[]): string {
  for (const key of keys) {
    const value = obj?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

function pickNumber(obj: any, keys: string[]): number {
  for (const key of keys) {
    const value = obj?.[key];
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function toIsoOrNull(raw: string): string | null {
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function getArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

function parsePeriodRange(options: RunSyncOptions = {}): { from: string; to: string } {
  const now = new Date();
  const weeksArg = Number(options.weeks ?? getArg('weeks') ?? process.env.PBX_SYNC_WEEKS ?? '0');
  const monthsArg = Number(options.months ?? getArg('months') ?? process.env.PBX_SYNC_MONTHS ?? '0');

  const fromArg = options.from || getArg('from') || process.env.PBX_SYNC_FROM;
  const toArg = options.to || getArg('to') || process.env.PBX_SYNC_TO;

  let from = fromArg ? new Date(fromArg) : new Date(now);
  let to = toArg ? new Date(toArg) : now;

  if (!fromArg) {
    if (monthsArg > 0) {
      from.setMonth(from.getMonth() - monthsArg);
    } else {
      const weeks = weeksArg > 0 ? weeksArg : 4;
      from.setDate(from.getDate() - weeks * 7);
    }
  }

  if (Number.isNaN(from.getTime())) throw new Error('PBX_SYNC_FROM yoki --from noto‘g‘ri sana.');
  if (Number.isNaN(to.getTime())) throw new Error('PBX_SYNC_TO yoki --to noto‘g‘ri sana.');
  if (from.getTime() > to.getTime()) throw new Error('from <= to bo‘lishi kerak.');

  return { from: from.toISOString(), to: to.toISOString() };
}

function extractCalls(payload: any): any[] {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.calls)) return payload.calls;
  if (Array.isArray(payload?.records)) return payload.records;
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?._embedded?.calls)) return payload._embedded.calls;
  return [];
}

function hasMorePages(payload: any, fetchedCount: number, limit: number, page: number): boolean {
  const nextPage = payload?.next_page ?? payload?.nextPage ?? payload?.pagination?.next_page;
  if (typeof nextPage === 'number') return nextPage > page;

  const hasMoreFlag = payload?.has_more ?? payload?.hasMore ?? payload?.pagination?.has_more;
  if (typeof hasMoreFlag === 'boolean') return hasMoreFlag;

  const totalPages = Number(payload?.total_pages ?? payload?.pagination?.total_pages ?? 0);
  if (Number.isFinite(totalPages) && totalPages > 0) return page < totalPages;

  return fetchedCount === limit;
}

function parseHistoryCall(raw: any): PbxHistoryCall | null {
  const pbxCallId = pickString(raw, ['pbx_call_id', 'pbxCallId', 'call_id', 'callId', 'id', 'uniqueid']);
  const sourceAudioUrl = pickString(raw, ['audio_url', 'audioUrl', 'record_url', 'recordUrl', 'recording_url', 'recordingUrl']);
  const phone = pickString(raw, [
    'client_phone',
    'clientPhone',
    'phone',
    'phone_number',
    'phoneNumber',
    'caller_number',
    'callerNumber',
    'callee_number',
    'calleeNumber',
  ]);
  const normalizedPhone = normalizePhone(phone);

  if (!pbxCallId) return null;
  if (!normalizedPhone) return null;

  const direction = toDirection(pickString(raw, ['direction', 'call_direction', 'callDirection', 'type', 'call_type']));
  const startedAt = toIsoOrNull(pickString(raw, ['started_at', 'startedAt', 'created_at', 'createdAt', 'timestamp', 'date']));
  const durationSec = Math.max(0, Math.floor(pickNumber(raw, ['duration', 'duration_sec', 'durationSec', 'billsec'])));
  const managerName = pickString(raw, ['manager_name', 'managerName', 'operator_name', 'operatorName', 'employee_name', 'employeeName']) || 'Tayinlanmagan';
  const managerId = pickString(raw, ['manager_id', 'managerId']) || undefined;

  return {
    raw,
    pbxCallId,
    crmId: pbxCallId,
    startedAt,
    direction,
    durationSec,
    managerName,
    managerId,
    clientPhone: phone,
    clientName: pickString(raw, ['client_name', 'clientName', 'contact_name', 'contactName', 'lead_name', 'leadName']) || undefined,
    sourceAudioUrl,
  };
}

async function fetchJson(url: string, apiKey: string): Promise<any> {
  return fetchJsonWithRetry(url, apiKey, {
    timeoutMs: 20000,
    retryCount: 3,
    retryDelayMs: 1500,
  });
}

async function fetchJsonWithRetry(
  url: string,
  apiKey: string,
  options: { timeoutMs: number; retryCount: number; retryDelayMs: number },
): Promise<any> {
  return runWithRetry(async () => {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json,*/*',
        Connection: 'keep-alive',
        'X-API-Key': apiKey,
        Authorization: `Bearer ${apiKey}`,
      },
      signal: AbortSignal.timeout(options.timeoutMs),
    });

    if (!res.ok) {
      const error = new Error(`PBX so‘rov xatosi: ${res.status} ${res.statusText}`) as Error & { status?: number };
      error.status = res.status;
      throw error;
    }

    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    if (contentType.includes('application/json')) return res.json();

    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('PBX JSON qaytarmadi.');
    }
  }, {
    retries: options.retryCount,
    delayMs: options.retryDelayMs,
    shouldRetry: ({ error }) => {
      const e = error as any;
      const status = Number(e?.status || 0);
      return isRetryableNetworkError(error) || isRetryableHttpStatus(status);
    },
    onRetry: ({ attempt, retries, error }) => {
      console.warn(`PBX JSON retry ${attempt}/${retries + 1}:`, (error as any)?.message || error);
    },
  });
}

function buildHistoryUrl(historyApiUrl: string, from: string, to: string, page: number, limit: number): string {
  const u = new URL(historyApiUrl);
  u.searchParams.set('from', from);
  u.searchParams.set('to', to);
  u.searchParams.set('page', String(page));
  u.searchParams.set('limit', String(limit));
  return u.toString();
}

async function fetchHistoryAudioUrl(call: PbxHistoryCall, config: SyncRuntimeConfig): Promise<string> {
  if (call.sourceAudioUrl) return call.sourceAudioUrl;
  if (!config.audioByCallApiUrl) throw new Error('Audio URL yo‘q va PBX_AUDIO_BY_CALL_API_URL berilmagan.');

  let requestUrl = config.audioByCallApiUrl;
  if (requestUrl.includes('{call_id}')) {
    requestUrl = requestUrl.replace('{call_id}', encodeURIComponent(call.pbxCallId));
  } else {
    const u = new URL(requestUrl);
    u.searchParams.set('call_id', call.pbxCallId);
    requestUrl = u.toString();
  }

  const payload = await fetchJsonWithRetry(requestUrl, config.apiKey, {
    timeoutMs: config.requestTimeoutMs,
    retryCount: config.retryCount,
    retryDelayMs: config.retryDelayMs,
  });
  const audioUrl = pickString(payload, ['audio_url', 'audioUrl', 'record_url', 'recordUrl', 'recording_url'])
    || pickString(payload?.call, ['audio_url', 'audioUrl', 'record_url', 'recordUrl', 'recording_url']);

  if (!audioUrl) throw new Error('Audio URL aniqlanmadi (call lookup).');
  return audioUrl;
}

function mimeToExt(mimeType: string): string {
  if (mimeType.includes('wav')) return 'wav';
  if (mimeType.includes('ogg')) return 'ogg';
  if (mimeType.includes('mp4') || mimeType.includes('m4a') || mimeType.includes('aac')) return 'm4a';
  return 'mp3';
}

async function readStreamToBufferInChunks(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) throw new Error('Audio stream mavjud emas.');

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

    total += value.byteLength;
    if (total > maxBytes) {
      throw new Error(`Audio fayl juda katta: ${total} bytes (limit ${maxBytes}).`);
    }
    chunks.push(Buffer.from(value));
  }

  return Buffer.concat(chunks, total);
}

async function persistAudio(audioUrl: string, config: SyncRuntimeConfig): Promise<{ publicUrl: string; path: string }> {
  const response = await runWithRetry(async () => fetch(audioUrl, {
    method: 'GET',
    redirect: 'follow',
    headers: {
      Accept: 'audio/*,*/*',
      Connection: 'keep-alive',
      'X-API-Key': config.apiKey,
      Authorization: `Bearer ${config.apiKey}`,
      'User-Agent': 'Mozilla/5.0 (compatible; ProcellPBXHistorySync/1.0)',
    },
    signal: AbortSignal.timeout(config.audioTimeoutMs),
  }), {
    retries: config.retryCount,
    delayMs: config.retryDelayMs,
    shouldRetry: ({ error }) => isRetryableNetworkError(error),
    onRetry: ({ attempt, retries, error }) => {
      console.warn(`Audio fetch retry ${attempt}/${retries + 1}:`, (error as any)?.message || error);
    },
  });
  if (!response.ok) throw new Error(`Audio yuklab bo‘lmadi: HTTP ${response.status}`);

  const contentType = (response.headers.get('content-type') || 'audio/mpeg').split(';')[0].trim().toLowerCase();
  if (contentType.startsWith('text/') || contentType.includes('html') || contentType.includes('json')) {
    throw new Error(`Audio emas (content-type=${contentType}).`);
  }

  const buffer = await readStreamToBufferInChunks(response, config.maxAudioBytes);
  if (!buffer.length) throw new Error('Audio body bo‘sh.');

  await supabase.storage.createBucket(config.audioBucket, { public: true }).catch(() => {});
  const ext = mimeToExt(contentType);
  const day = new Date().toISOString().slice(0, 10);
  const objectPath = `pbx/history/${day}/${randomUUID()}.${ext}`;

  const { error: uploadError } = await supabase.storage
    .from(config.audioBucket)
    .upload(objectPath, buffer, { contentType, upsert: false });
  if (uploadError) throw new Error(`Storage upload xatosi: ${uploadError.message}`);

  const { data } = supabase.storage.from(config.audioBucket).getPublicUrl(objectPath);
  if (!data?.publicUrl) throw new Error('Storage public URL olinmadi.');

  return { publicUrl: data.publicUrl, path: objectPath };
}

async function loadUsersPhoneMap(): Promise<Map<string, { id: string; name: string; phone: string | null }>> {
  const map = new Map<string, { id: string; name: string; phone: string | null }>();

  let from = 0;
  const chunk = 1000;
  while (true) {
    const to = from + chunk - 1;
    const { data, error } = await supabase
      .from('users')
      .select('id, name, phone')
      .not('phone', 'is', null)
      .range(from, to);

    if (error) throw new Error(`users o‘qib bo‘lmadi: ${error.message}`);
    if (!data || data.length === 0) break;

    for (const user of data as any[]) {
      const normalized = normalizePhone(String(user.phone || ''));
      if (!normalized) continue;
      if (!map.has(normalized)) {
        map.set(normalized, {
          id: String(user.id),
          name: String(user.name || ''),
          phone: user.phone ? String(user.phone) : null,
        });
      }
    }

    if (data.length < chunk) break;
    from += chunk;
  }

  return map;
}

async function getOrCreateManagerByName(name: string): Promise<{ id: string; name: string }> {
  const clean = name.trim() || 'Tayinlanmagan';
  const { data: existing, error: findErr } = await supabase
    .from('managers')
    .select('id, name')
    .eq('name', clean)
    .limit(1);
  if (findErr) throw new Error(`manager lookup xatosi: ${findErr.message}`);
  if (existing && existing.length > 0) return { id: existing[0].id, name: existing[0].name };

  const { data: created, error: createErr } = await supabase
    .from('managers')
    .insert({ name: clean, status: 'active' })
    .select('id, name')
    .single();
  if (createErr || !created) throw new Error(`manager yaratib bo‘lmadi: ${createErr?.message || 'unknown'}`);

  return { id: created.id, name: created.name };
}

async function callExistsByCrmId(crmId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('calls')
    .select('id')
    .eq('crm_id', crmId)
    .maybeSingle();
  if (error && error.code !== 'PGRST116') {
    throw new Error(`calls tekshirish xatosi: ${error.message}`);
  }
  return !!data?.id;
}

function buildCallInsertRow(params: {
  call: PbxHistoryCall;
  managerId: string;
  client?: { id: string; name: string; phone: string | null };
  audioPublicUrl: string;
  audioSourceUrl: string;
  audioStoragePath: string;
}): CallInsertRow {
  const createdAt = params.call.startedAt || new Date().toISOString();

  const row: Record<string, any> = {
    manager_id: params.managerId,
    crm_id: params.call.crmId,
    pbx_call_id: params.call.pbxCallId,
    direction: params.call.direction,
    audio_url: params.audioPublicUrl,
    audio_source_url: params.audioSourceUrl,
    audio_storage_url: params.audioPublicUrl,
    audio_storage_path: params.audioStoragePath,
    client_phone: params.call.clientPhone,
    client_name: params.call.clientName || params.client?.name || null,
    created_at: createdAt,
    status: 'done',
    duration: params.call.durationSec,
  };

  if (params.client?.id) {
    row.client_id = params.client.id;
    if (!row.client_name) row.client_name = params.client.name;
  }

  return row;
}

function isDuplicateInsertError(error: any): boolean {
  const code = String(error?.code || '').toUpperCase();
  const message = String(error?.message || '').toLowerCase();
  return code === '23505' || message.includes('duplicate key');
}

async function insertCallRowsBatch(
  rows: CallInsertRow[],
  batchSize: number,
): Promise<{ inserted: number; failed: number; duplicates: number }> {
  if (rows.length === 0) return { inserted: 0, failed: 0, duplicates: 0 };

  let inserted = 0;
  let failed = 0;
  let duplicates = 0;
  const step = Math.max(1, batchSize);

  for (let start = 0; start < rows.length; start += step) {
    const slice = rows.slice(start, start + step);
    const { error } = await supabase.from('calls').insert(slice);
    if (!error) {
      inserted += slice.length;
      continue;
    }

    console.warn(`Batch insert xatosi, fallback one-by-one: ${error.message}`);
    for (const row of slice) {
      const single = await supabase.from('calls').insert(row);
      if (!single.error) {
        inserted += 1;
        continue;
      }
      if (isDuplicateInsertError(single.error)) {
        duplicates += 1;
      } else {
        failed += 1;
        console.error(`calls insert xatosi (crm_id=${row.crm_id}):`, single.error.message);
      }
    }
  }

  return { inserted, failed, duplicates };
}

function generateDateChunks(
  fromIso: string,
  toIso: string,
  chunkUnit: 'hour' | 'day' | 'month',
  chunkSize: number,
): Array<{ from: string; to: string }> {
  const from = new Date(fromIso);
  const to = new Date(toIso);
  const out: Array<{ from: string; to: string }> = [];
  const step = Math.max(1, chunkSize);

  let cursor = new Date(from);
  while (cursor.getTime() <= to.getTime()) {
    const next = new Date(cursor);
    if (chunkUnit === 'month') {
      next.setMonth(next.getMonth() + step);
    } else if (chunkUnit === 'hour') {
      next.setHours(next.getHours() + step);
    } else {
      next.setDate(next.getDate() + step);
    }

    const chunkEnd = new Date(next.getTime() - 1);
    const boundedEnd = chunkEnd.getTime() > to.getTime() ? to : chunkEnd;
    out.push({ from: new Date(cursor).toISOString(), to: boundedEnd.toISOString() });

    cursor = new Date(boundedEnd.getTime() + 1);
  }

  return out;
}

export async function runPbxHistorySync(options: RunSyncOptions = {}): Promise<SyncCounters> {
  const { from, to } = parsePeriodRange(options);
  const config = getRuntimeConfig(options);
  const limit = config.defaultLimit > 0 ? config.defaultLimit : 100;
  const chunks = generateDateChunks(from, to, config.chunkUnit, config.chunkSize);

  console.log(`PBX history sync boshlandi: from=${from} to=${to} chunks=${chunks.length} (${config.chunkUnit}:${config.chunkSize})`);

  const usersByPhone = await loadUsersPhoneMap();
  console.log(`Users phone map tayyor: ${usersByPhone.size}`);

  const counters: SyncCounters = {
    fetched: 0,
    imported: 0,
    skippedExisting: 0,
    skippedInvalid: 0,
    failed: 0,
  };

  const managerCache = new Map<string, { id: string; name: string }>();
  const pendingRows: CallInsertRow[] = [];
  let skippedChunks = 0;

  const flushPendingRows = async () => {
    if (pendingRows.length === 0) return;
    const result = await insertCallRowsBatch(pendingRows, config.writeBatchSize);
    counters.imported += result.inserted;
    counters.failed += result.failed;
    counters.skippedExisting += result.duplicates;
    pendingRows.length = 0;
  };

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
    const chunk = chunks[chunkIndex];
    console.log(`Chunk ${chunkIndex + 1}/${chunks.length}: from=${chunk.from} to=${chunk.to}`);
    try {
      let page = 1;
      while (page <= config.maxPages) {
        const url = buildHistoryUrl(config.historyApiUrl, chunk.from, chunk.to, page, limit);
        const payload = await fetchJsonWithRetry(url, config.apiKey, {
          timeoutMs: config.requestTimeoutMs,
          retryCount: config.retryCount,
          retryDelayMs: config.retryDelayMs,
        });
        const rawCalls = extractCalls(payload);

        if (rawCalls.length === 0) {
          console.log(`Chunk ${chunkIndex + 1}, page ${page}: yozuv yo‘q, tugadi.`);
          break;
        }

        console.log(`Chunk ${chunkIndex + 1}, page ${page}: ${rawCalls.length} ta history call olindi.`);

        for (const raw of rawCalls) {
          counters.fetched += 1;
          const parsed = parseHistoryCall(raw);
          if (!parsed) {
            counters.skippedInvalid += 1;
            continue;
          }

          try {
            const exists = await callExistsByCrmId(parsed.crmId);
            if (exists) {
              counters.skippedExisting += 1;
              continue;
            }

            const managerNameKey = parsed.managerName.trim() || 'Tayinlanmagan';
            let manager = managerCache.get(managerNameKey);
            if (!manager) {
              manager = await getOrCreateManagerByName(managerNameKey);
              managerCache.set(managerNameKey, manager);
            }

            const normalizedPhone = normalizePhone(parsed.clientPhone);
            const mappedClient = normalizedPhone ? usersByPhone.get(normalizedPhone) : undefined;

            const sourceAudioUrl = await fetchHistoryAudioUrl(parsed, config);
            const persisted = await persistAudio(sourceAudioUrl, config);

            pendingRows.push(buildCallInsertRow({
              call: parsed,
              managerId: manager.id,
              client: mappedClient,
              audioPublicUrl: persisted.publicUrl,
              audioSourceUrl: sourceAudioUrl,
              audioStoragePath: persisted.path,
            }));
            if (pendingRows.length >= config.writeBatchSize) {
              await flushPendingRows();
            }
          } catch (error: any) {
            counters.failed += 1;
            console.error(`Call import failed (id=${parsed.crmId}):`, error?.message || error);
          }
        }

        await flushPendingRows();

        if (!hasMorePages(payload, rawCalls.length, limit, page)) break;
        page += 1;
      }
    } catch (chunkError: any) {
      skippedChunks += 1;
      counters.failed += 1;
      console.error(`Chunk ${chunkIndex + 1} skip qilindi (from=${chunk.from} to=${chunk.to}):`, chunkError?.message || chunkError);
      await flushPendingRows().catch(() => {});
      continue;
    }
  }

  await flushPendingRows();

  if (skippedChunks > 0) {
    console.warn(`PBX history sync ogohlantirish: ${skippedChunks} ta chunk tarmoq/xato sabab skip qilindi.`);
  }
  console.log('PBX history sync tugadi:', counters);
  return counters;
}

if (require.main === module) {
  installProcessGuards('pbx-history-sync');
  runPbxHistorySync()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('PBX history sync umumiy xato:', error?.message || error);
      process.exit(1);
    });
}
