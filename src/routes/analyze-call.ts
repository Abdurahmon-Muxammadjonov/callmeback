import { Router, Request, Response } from 'express';
import multer from 'multer';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { unlink, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { processLocalAudioWithGroq, processLongAudioWithGroq } from '../lib/groq-audio';

const router = Router();

// Yuklangan audio faylni DISKKA yozamiz (heap'da ulkan buffer ushlamaymiz).
// Limit 2GB — uzun audio yozuvlar uchun.
const upload = multer({
  storage: multer.diskStorage({ destination: os.tmpdir() }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
});

// Bir vaqtda nechta qo'ng'iroq parallel tahlil qilinadi (memory/limit nazorati).
const ANALYZE_CONCURRENCY = parseInt(process.env.ANALYZE_CONCURRENCY || '4', 10);

interface LostReason {
  reason_text: string;
  count: number;
}

interface CriteriaScore {
  title: string;
  category: string | null;
  score: number;
}

interface TranscriptSegment {
  speaker: string; // 'Manager' yoki 'Mijoz'
  text: string;
  start: number;   // segment boshlanishi (sekund)
}

interface AuditResult {
  transcript: string;
  total_calls: number;
  incoming_count: number;
  outgoing_count: number;
  duration: number;
  unanswered_count: number;
  bad_leads_count: number;
  traffic_conversion: number;
  sales_conversion: number;
  kpi_score: number;
  penalty_amount: number;
  bonus_amount: number;
  rop_comment: string;
  stage_1_to_2: number;
  stage_2_to_3: number;
  stage_3_to_4: number;
  lost_reasons: LostReason[];
  sentiment: string;
  risk: string;
  criteria_scores: CriteriaScore[];
  transcript_segments: TranscriptSegment[];
  summary: string;          // Xulosa — menejer nima qildi, qayerda xato qildi
  client_info: string;      // Mijoz haqida ma'lumot
  final_agreement: string;  // Oxirgi kelishuv
  next_steps: string[];     // Keyingi qadamlar
}

interface CriticalAlert {
  severity: 'critical';
  code: 'LOW_QUALIFIED_CALL_VOLUME';
  message: string;
  manager_id: string;
  qualified_calls_today: number;
  threshold: number;
  timestamp: string;
}

const KPI_THRESHOLD = 40;
const KPI_MIN_DURATION_SEC = 60;

let cachedMetrics: any = null;
let lastCacheTime = 0;
const CACHE_TTL_MS = 10000;

function getSupabaseAdmin(): SupabaseClient {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const serviceRoleKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !serviceRoleKey) {
    throw new Error('Supabase konfiguratsiyasi yo\'q: NEXT_PUBLIC_SUPABASE_URL va SUPABASE_SERVICE_ROLE_KEY ni .env.local da belgilang.');
  }
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { 'X-Client-Info': 'prosell-analyze-call/2.0' } },
  });
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isValidUUID = (v: string) => UUID_REGEX.test(v);

const isValidHttpUrl = (v: string) => {
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
};

// Bazadagi aktiv qoidalarni o'qib, Groq tahlili uchun qo'shimcha ko'rsatma matnini quradi.
// Admin yangi qoida qo'shsa, keyingi tahlilda darhol shu yerda paydo bo'ladi.
async function buildDynamicRules(supabase: SupabaseClient): Promise<string> {
  const { data, error } = await supabase
    .from('criteria')
    .select('title, description, penalty_amount, category, type')
    .eq('is_active', true);
  if (error || !data || data.length === 0) return '';

  const lines = data.map((c) => {
    const penalty = Number(c.penalty_amount) || 0;
    const penaltyTxt = penalty > 0 ? ` -> Buzilsa jarima: ${penalty} UZS` : '';
    const cat = c.category ? ` [kategoriya: ${c.category}]` : '';
    const typ = c.type ? ` (${c.type})` : '';
    return `  - ${c.title}${typ}${cat}: ${c.description}${penaltyTxt}`;
  });

  return (
    `\n\nQO'SHIMCHA DINAMIK QOIDALAR (admin tomonidan belgilangan, qat'iy qo'llang):\n${lines.join('\n')}` +
    `\n\nHar bir AKTIV dinamik qoidani criteria_scores massivida 0–100 ball bilan bahola; ` +
    `har bir element uchun qoidaning title va category sini ham qaytar.`
  );
}

interface AudioInput {
  audioUrl?: string;
  audioBuffer?: Buffer;
  filePath?: string;
  mimeType?: string;
}

function extFromMime(mimeType: string): string {
  if (mimeType.includes('wav')) return 'wav';
  if (mimeType.includes('mp4') || mimeType.includes('m4a') || mimeType.includes('aac')) return 'm4a';
  if (mimeType.includes('ogg')) return 'ogg';
  return 'mp3';
}

function tmpAudioPath(ext: string): string {
  return path.join(os.tmpdir(), `procell-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
}

// Manbani (URL / buffer / fayl yo'li) Groq orqali audit qiladi.
async function auditCallWithGroq(input: AudioInput, extraRules = ''): Promise<AuditResult> {
  let tempFilePath: string | null = null;
  try {
    const groqResult = input.filePath
      ? await processLocalAudioWithGroq(input.filePath, extraRules)
      : input.audioBuffer
        ? await (async () => {
            const fileExt = extFromMime(input.mimeType || 'audio/mpeg');
            const localPath = tmpAudioPath(fileExt);
            await writeFile(localPath, input.audioBuffer as Buffer);
            tempFilePath = localPath;
            return processLocalAudioWithGroq(localPath, extraRules);
          })()
        : input.audioUrl
          ? await processLongAudioWithGroq(input.audioUrl, extraRules)
          : null;

    if (!groqResult) {
      throw new Error('Audio manbai yo\'q: audioUrl, audioBuffer yoki filePath kerak.');
    }

    const normalized: Partial<AuditResult> = {
      transcript: groqResult.transcript,
      total_calls: 1,
      incoming_count: 0,
      outgoing_count: 0,
      duration: 0,
      unanswered_count: 0,
      bad_leads_count: 0,
      traffic_conversion: 0,
      sales_conversion: groqResult.analysis.deal_closed ? 100 : 0,
      kpi_score: 0,
      penalty_amount: 0,
      bonus_amount: 0,
      rop_comment: groqResult.analysis.operator_evaluation,
      stage_1_to_2: 0,
      stage_2_to_3: 0,
      stage_3_to_4: 0,
      lost_reasons: [],
      sentiment: groqResult.analysis.sentiment,
      risk: groqResult.analysis.client_mood,
      criteria_scores: [],
      transcript_segments: [],
      summary: groqResult.analysis.summary,
      client_info: groqResult.analysis.client_mood,
      final_agreement: groqResult.analysis.deal_closed
        ? 'Mijoz bitimga rozilik bildirgan (Groq tahliliga ko\'ra).'
        : 'Bitim yopilmagan (Groq tahliliga ko\'ra).',
      next_steps: [],
    };

    return normalizeAuditResult(normalized);
  } finally {
    if (tempFilePath) {
      try { await unlink(tempFilePath); } catch { /* ignore */ }
    }
  }
}

function normalizeAuditResult(r: Partial<AuditResult>): AuditResult {
  const clamp = (v: number | undefined, min: number, max: number) =>
    Math.max(min, Math.min(max, v ?? min));
  const intMin0 = (v: number | undefined) => Math.max(0, Math.floor(v ?? 0));

  return {
    transcript: typeof r.transcript === 'string' ? r.transcript : '',
    total_calls: intMin0(r.total_calls),
    incoming_count: intMin0(r.incoming_count),
    outgoing_count: intMin0(r.outgoing_count),
    duration: intMin0(r.duration),
    unanswered_count: intMin0(r.unanswered_count),
    bad_leads_count: intMin0(r.bad_leads_count),
    traffic_conversion: Number(clamp(r.traffic_conversion, 0, 100).toFixed(2)),
    sales_conversion: Number(clamp(r.sales_conversion, 0, 100).toFixed(2)),
    kpi_score: Number(clamp(r.kpi_score, 0, 100).toFixed(2)),
    penalty_amount: Math.max(0, Number(r.penalty_amount ?? 0)),
    bonus_amount: Math.max(0, Number(r.bonus_amount ?? 0)),
    rop_comment: typeof r.rop_comment === 'string' ? r.rop_comment : '',
    stage_1_to_2: intMin0(r.stage_1_to_2),
    stage_2_to_3: intMin0(r.stage_2_to_3),
    stage_3_to_4: intMin0(r.stage_3_to_4),
    lost_reasons: Array.isArray(r.lost_reasons)
      ? r.lost_reasons
          .filter((x) => x && typeof x.reason_text === 'string')
          .map((x) => ({
            reason_text: x.reason_text.slice(0, 500),
            count: Math.max(1, Math.floor(x.count ?? 1)),
          }))
      : [],
    sentiment: typeof r.sentiment === 'string' ? r.sentiment : '',
    risk: typeof r.risk === 'string' ? r.risk : '',
    criteria_scores: Array.isArray(r.criteria_scores)
      ? r.criteria_scores
          .filter((x) => x && typeof x.title === 'string')
          .map((x) => ({
            title: x.title.slice(0, 300),
            category: typeof x.category === 'string' ? x.category : null,
            score: Math.max(0, Math.min(100, Math.floor(Number(x.score) || 0))),
          }))
      : [],
    transcript_segments: Array.isArray(r.transcript_segments)
      ? r.transcript_segments
          .filter((x) => x && typeof x.text === 'string' && x.text.trim() !== '')
          .map((x) => ({
            speaker: typeof x.speaker === 'string' && x.speaker.trim() ? x.speaker.trim() : 'Noma\'lum',
            text: x.text,
            start: Math.max(0, Number(x.start) || 0),
          }))
      : [],
    summary: typeof r.summary === 'string' ? r.summary : '',
    client_info: typeof r.client_info === 'string' ? r.client_info : '',
    final_agreement: typeof r.final_agreement === 'string' ? r.final_agreement : '',
    next_steps: Array.isArray(r.next_steps)
      ? r.next_steps.filter((x) => typeof x === 'string' && x.trim() !== '').map((x) => x.trim())
      : [],
  };
}

async function evaluateManagerKpi(
  supabase: SupabaseClient,
  managerId: string
): Promise<{ qualified_calls_today: number; alert: CriticalAlert | null }> {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  const { count, error } = await supabase
    .from('calls')
    .select('id', { count: 'exact', head: true })
    .eq('manager_id', managerId)
    .gt('duration', KPI_MIN_DURATION_SEC)
    .gte('created_at', todayStart.toISOString());

  if (error) {
    throw new Error(`KPI query failed: ${error.message}`);
  }

  const qualified = count ?? 0;
  const isCritical = qualified < KPI_THRESHOLD;

  return {
    qualified_calls_today: qualified,
    alert: isCritical
      ? {
          severity: 'critical',
          code: 'LOW_QUALIFIED_CALL_VOLUME',
          message: `Manager has only ${qualified}/${KPI_THRESHOLD} qualified calls (>${KPI_MIN_DURATION_SEC}s) today`,
          manager_id: managerId,
          qualified_calls_today: qualified,
          threshold: KPI_THRESHOLD,
          timestamp: new Date().toISOString(),
        }
      : null,
  };
}

// manager_id berilmaganda ishlatiladigan "Tayinlanmagan" menejer (bir marta yaratiladi).
const DEFAULT_MANAGER_NAME = 'Tayinlanmagan';
function makeAutoCrmId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function getOrCreateDefaultManager(
  supabase: SupabaseClient
): Promise<{ id: string; name: string; status: string }> {
  const { data: existing } = await supabase
    .from('managers')
    .select('id, name, status')
    .eq('name', DEFAULT_MANAGER_NAME)
    .limit(1);
  if (existing && existing.length > 0) return existing[0];

  const { data: created, error } = await supabase
    .from('managers')
    .insert({ name: DEFAULT_MANAGER_NAME, status: 'active', crm_id: makeAutoCrmId('auto-default') })
    .select('id, name, status')
    .single();
  if (error || !created) {
    throw new Error(`Default manager yaratib bo'lmadi: ${error?.message || 'unknown'}`);
  }
  return created;
}

// CRM ismi bo'yicha menejer(operator)ni topadi yoki avtomatik yaratadi.
// CRM xodim ismini yuborsa — backend uni avtomatik saqlab, qo'ng'iroqni shunga bog'laydi.
async function getOrCreateManagerByName(
  supabase: SupabaseClient,
  name: string,
): Promise<{ id: string; name: string; status: string }> {
  const clean = name.trim();
  const { data: existing } = await supabase
    .from('managers').select('id, name, status').eq('name', clean).limit(1);
  if (existing && existing.length > 0) return existing[0];

  const { data: created, error } = await supabase
    .from('managers').insert({ name: clean, status: 'active', crm_id: makeAutoCrmId('auto-manager') }).select('id, name, status').single();
  if (error || !created) {
    throw new Error(`Manager yaratib bo'lmadi: ${error?.message || 'unknown'}`);
  }
  return created;
}

// Yuklangan audio faylni Supabase Storage'ga saqlaydi va public URL qaytaradi
// (keyin platformada qayta eshitish uchun). Muvaffaqiyatsiz bo'lsa null.
const AUDIO_BUCKET = 'recordings';
async function uploadAudioToStorage(
  supabase: SupabaseClient,
  buffer: Buffer,
  mimeType: string
): Promise<string | null> {
  try {
    await supabase.storage.createBucket(AUDIO_BUCKET, { public: true }).catch(() => {});
    const ext = mimeType.includes('wav') ? 'wav'
      : mimeType.includes('mp4') || mimeType.includes('m4a') || mimeType.includes('aac') ? 'm4a'
      : mimeType.includes('ogg') ? 'ogg' : 'mp3';
    const path = `calls/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
    const { error } = await supabase.storage.from(AUDIO_BUCKET).upload(path, buffer, { contentType: mimeType, upsert: false });
    if (error) {
      console.error('Storage upload failed:', error.message);
      return null;
    }
    const { data } = supabase.storage.from(AUDIO_BUCKET).getPublicUrl(path);
    return data?.publicUrl || null;
  } catch (e) {
    console.error('Storage upload exception:', (e as Error).message);
    return null;
  }
}

// calls jadvalining ustun qiymatlari (yakka va batch rejim uchun umumiy).
function callRowFields(audit: AuditResult) {
  return {
    total_calls: audit.total_calls,
    incoming_count: audit.incoming_count,
    outgoing_count: audit.outgoing_count,
    duration: audit.duration,
    unanswered_count: audit.unanswered_count,
    bad_leads_count: audit.bad_leads_count,
    kpi_score: audit.kpi_score,
    penalty_amount: audit.penalty_amount,
    bonus_amount: audit.bonus_amount,
    rop_comment: audit.rop_comment,
    transcript: audit.transcript,
    sentiment: audit.sentiment,
    risk: audit.risk,
    transcript_segments: audit.transcript_segments,
    summary: audit.summary,
    client_info: audit.client_info,
    final_agreement: audit.final_agreement,
    next_steps: audit.next_steps,
    bad_lead: audit.bad_leads_count > 0,
  };
}

// Bog'liq jadvallarga (conversions/lost_reasons/call_criteria_scores) yozish promise'lari.
function childWritePromises(supabase: SupabaseClient, callId: string, audit: AuditResult) {
  const writes = [
    supabase.from('conversions').insert({
      call_id: callId,
      traffic_conversion: audit.traffic_conversion,
      sales_conversion: audit.sales_conversion,
      stage_1_to_2: audit.stage_1_to_2,
      stage_2_to_3: audit.stage_2_to_3,
      stage_3_to_4: audit.stage_3_to_4,
    }),
  ];
  if (audit.lost_reasons.length > 0) {
    writes.push(
      supabase.from('lost_reasons').insert(
        audit.lost_reasons.map((r) => ({ call_id: callId, reason_text: r.reason_text, count: r.count, status: 'open' }))
      )
    );
  }
  if (audit.criteria_scores.length > 0) {
    writes.push(
      supabase.from('call_criteria_scores').insert(
        audit.criteria_scores.map((c) => ({ call_id: callId, title: c.title, category: c.category ?? null, score: c.score }))
      )
    );
  }
  return writes;
}

// Cheklangan parallellik: bir vaqtda eng ko'pi bilan `limit` ta worker ishlaydi.
// Bitta worker xato bersa, qolganlari to'xtamaydi (xato log qilinadi).
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const poolSize = Math.max(1, Math.min(limit, items.length));
  const runners = Array.from({ length: poolSize }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) break;
      try {
        await worker(items[i], i);
      } catch (e) {
        console.error('Concurrency worker error:', (e as Error).message);
      }
    }
  });
  await Promise.all(runners);
}

// ===================== BATCH (fon rejim) =====================
export interface BatchCallItem {
  audio_url?: string;
  manager_id?: string;
  manager_name?: string;
  platform_id?: string;
  crm_id?: string;
  pbx_call_id?: string;
  direction?: 'incoming' | 'outgoing' | 'unknown';
  client_id?: string;
  client_name?: string;
  client_phone?: string;
  audio_source_url?: string;
  audio_storage_url?: string;
  audio_storage_path?: string;
  call_status?: string;
}
interface PreparedCall {
  callId: string;
  audioUrl: string;
  managerId: string;
}

// Shu jarayonda HOZIR tahlil qilinayotgan qo'ng'iroq id'lari.
// Watchdog/recovery shu ro'yxatdagilarni "osilib qolgan" deb xato qayta ishlamasligi uchun.
const inFlightCalls = new Set<string>();

// Bitta batch qo'ng'irog'ini tahlil qilib, oldindan yaratilgan qatorni yangilaydi.
// Bittasi yiqilsa — faqat o'sha 'failed' bo'ladi, qolganlariga ta'sir qilmaydi.
async function processOneBatchCall(supabase: SupabaseClient, prep: PreparedCall, extraRules: string): Promise<void> {
  inFlightCalls.add(prep.callId);
  try {
    const audit = await auditCallWithGroq({ audioUrl: prep.audioUrl }, extraRules);
    const { error: upErr } = await supabase
      .from('calls')
      .update({ ...callRowFields(audit), status: 'done', error: null })
      .eq('id', prep.callId);
    if (upErr) throw new Error(upErr.message);

    const settled = await Promise.allSettled(childWritePromises(supabase, prep.callId, audit));
    settled.forEach((r, i) => {
      if (r.status === 'rejected') console.error(`Batch ${prep.callId} child #${i} failed:`, r.reason);
    });
  } catch (e) {
    console.error(`Batch call ${prep.callId} failed:`, (e as Error).message);
    await supabase
      .from('calls')
      .update({ status: 'failed', error: (e as Error).message.slice(0, 500) })
      .eq('id', prep.callId)
      .then(undefined, () => {});
  } finally {
    inFlightCalls.delete(prep.callId);
  }
}

// Butun batch'ni fon rejimida, cheklangan parallellik bilan ishlaydi.
async function processBatchInBackground(supabase: SupabaseClient, prepared: PreparedCall[]): Promise<void> {
  try {
    const extraRules = await buildDynamicRules(supabase);
    await runWithConcurrency(prepared, ANALYZE_CONCURRENCY, (p) => processOneBatchCall(supabase, p, extraRules));
    console.log(`Batch tugadi: ${prepared.length} ta qo'ng'iroq tahlil qilindi.`);
  } catch (e) {
    console.error('Batch background error:', (e as Error).message);
  }
}

// ===================== RECOVERY (qayta tiklash) =====================
// Server qayta ishga tushganda yoki davriy (watchdog) ravishda: 'processing' da
// osilib qolgan (restart/deploy natijasida tashlab ketilgan) va ixtiyoriy ravishda
// 'failed' qo'ng'iroqlarni qayta tahlilga qo'yadi. Shu tufayli CRM batch'i yarim
// qolsa ham hech bir qo'ng'iroq YO'QOLMAYDI — 100% qayta ishlanadi.
const STALE_PROCESSING_MS = 3 * 60 * 1000; // 3 daqiqadan ko'p 'processing' = osilib qolgan deb hisoblaymiz

let recoveryRunning = false; // bir vaqtda faqat bitta recovery yurishi uchun

export async function recoverStuckCalls(opts: { includeFailed?: boolean } = {}): Promise<{ recovered: number; ids: string[] }> {
  if (recoveryRunning) return { recovered: 0, ids: [] };
  recoveryRunning = true;
  try {
    let supabase: SupabaseClient;
    try {
      supabase = getSupabaseAdmin();
    } catch {
      return { recovered: 0, ids: [] }; // env yo'q — jim chiqamiz
    }

    const staleBefore = new Date(Date.now() - STALE_PROCESSING_MS).toISOString();
    const staleProcessing = `and(status.eq.processing,created_at.lt.${staleBefore})`;
    const orFilter = opts.includeFailed ? `status.eq.failed,${staleProcessing}` : staleProcessing;

    const { data, error } = await supabase
      .from('calls')
      .select('id, audio_url, manager_id')
      .or(orFilter)
      .not('audio_url', 'is', null)
      .limit(200);
    if (error) {
      console.error('recoverStuckCalls query failed:', error.message);
      return { recovered: 0, ids: [] };
    }

    const prepared: PreparedCall[] = (data || [])
      // audio_url o'qiladigan bo'lsin, manager bog'langan bo'lsin, va shu jarayonda
      // hozir ishlanayotgan bo'lmasin (dublikat ishlovni oldini olamiz).
      .filter((r: any) => typeof r.audio_url === 'string' && isValidHttpUrl(r.audio_url) && r.manager_id && !inFlightCalls.has(r.id))
      .map((r: any) => ({ callId: r.id, audioUrl: r.audio_url, managerId: r.manager_id }));

    if (prepared.length === 0) return { recovered: 0, ids: [] };

    const ids = prepared.map((p) => p.callId);
    // Idempotentlik: qayta tahlildan oldin eski bog'liq yozuvlarni tozalaymiz (dublikat bo'lmasin).
    await Promise.allSettled([
      supabase.from('conversions').delete().in('call_id', ids),
      supabase.from('lost_reasons').delete().in('call_id', ids),
      supabase.from('call_criteria_scores').delete().in('call_id', ids),
    ]);
    // Qayta ishlash uchun belgilaymiz (status processing, eski xatoni tozalaymiz).
    await supabase.from('calls').update({ status: 'processing', error: null }).in('id', ids);

    console.log(`recoverStuckCalls: ${prepared.length} ta qo'ng'iroq qayta tahlilga qo'yildi.`);
    void processBatchInBackground(supabase, prepared);
    return { recovered: prepared.length, ids };
  } finally {
    recoveryRunning = false;
  }
}

// Batch payload'ni validatsiya qilib, qatorlarni 'processing' bilan yaratadi va
// 202 javob uchun ma'lumot qaytaradi. Tahlil fon rejimida davom etadi.
export async function enqueueBatchCalls(items: BatchCallItem[], supabase: SupabaseClient): Promise<{ status: number; body: any }> {
  if (!Array.isArray(items) || items.length === 0) {
    return { status: 400, body: { success: false, error: 'calls bo\'sh massiv bo\'lmasligi kerak.' } };
  }
  if (items.length > 200) {
    return { status: 400, body: { success: false, error: 'Bir batch\'da maksimal 200 ta qo\'ng\'iroq.' } };
  }

  const nameMap = new Map<string, string>();
  for (const nm of new Set(items.map((it) => (it?.manager_name || '').trim()).filter(Boolean))) {
    const m = await getOrCreateManagerByName(supabase, nm);
    nameMap.set(nm, m.id);
  }

  let defaultManager: { id: string } | null = null;
  if (items.some((it) => !it?.manager_id && !(it?.manager_name || '').trim())) {
    defaultManager = await getOrCreateDefaultManager(supabase);
  }

  const candidates: Array<{
    index: number;
    row: {
      manager_id: string;
      audio_url: string;
      status: string;
      platform_id?: string;
      crm_id?: string;
      pbx_call_id?: string;
      direction?: 'incoming' | 'outgoing' | 'unknown';
      client_id?: string;
      client_name?: string;
      client_phone?: string;
      audio_source_url?: string;
      audio_storage_url?: string;
      audio_storage_path?: string;
    };
    meta: { audioUrl: string; managerId: string };
  }> = [];
  const skipped: Array<{ index: number; error: string }> = [];

  items.forEach((it, i) => {
    if (!it?.audio_url || typeof it.audio_url !== 'string' || !isValidHttpUrl(it.audio_url)) {
      skipped.push({ index: i, error: 'audio_url yaroqsiz' });
      return;
    }

    let mid = it.manager_id;
    if (mid && !isValidUUID(mid)) {
      skipped.push({ index: i, error: 'manager_id yaroqsiz UUID' });
      return;
    }

    if (!mid && (it.manager_name || '').trim()) mid = nameMap.get((it.manager_name as string).trim());
    if (!mid) mid = defaultManager!.id;

    const crmId = typeof it.crm_id === 'string' ? it.crm_id.trim() : '';
    if (it.crm_id !== undefined && !crmId) {
      skipped.push({ index: i, error: 'crm_id bo\'sh bo\'lmasligi kerak' });
      return;
    }

    const row: {
      manager_id: string;
      audio_url: string;
      status: string;
      platform_id?: string;
      crm_id?: string;
      pbx_call_id?: string;
      direction?: 'incoming' | 'outgoing' | 'unknown';
      client_id?: string;
      client_name?: string;
      client_phone?: string;
      audio_source_url?: string;
      audio_storage_url?: string;
      audio_storage_path?: string;
    } = {
      manager_id: mid,
      audio_url: it.audio_url,
      status: 'processing',
    };
    if (it.platform_id) row.platform_id = it.platform_id;
    if (crmId) row.crm_id = crmId;
    if (it.pbx_call_id) row.pbx_call_id = it.pbx_call_id;
    row.direction = it.direction || 'unknown';
    if (it.client_id) row.client_id = it.client_id;
    if (it.client_name) row.client_name = it.client_name;
    if (it.client_phone) row.client_phone = it.client_phone;
    if (it.audio_source_url) row.audio_source_url = it.audio_source_url;
    if (it.audio_storage_url) row.audio_storage_url = it.audio_storage_url;
    if (it.audio_storage_path) row.audio_storage_path = it.audio_storage_path;

    candidates.push({ index: i, row, meta: { audioUrl: it.audio_url, managerId: mid } });
  });

  const crmIds = candidates
    .map((c) => c.row.crm_id)
    .filter((v): v is string => typeof v === 'string' && v.length > 0);

  if (crmIds.length > 0) {
    const { data: existed, error: existedErr } = await supabase
      .from('calls')
      .select('crm_id')
      .in('crm_id', crmIds);
    if (existedErr) {
      return { status: 500, body: { success: false, error: `Database Error: ${existedErr.message}` } };
    }

    const existedSet = new Set((existed || []).map((r: any) => String(r.crm_id)));
    for (const c of candidates) {
      if (c.row.crm_id && existedSet.has(c.row.crm_id)) {
        skipped.push({ index: c.index, error: `crm_id allaqachon mavjud (${c.row.crm_id})` });
      }
    }
  }

  const skippedIndexes = new Set(skipped.map((s) => s.index));
  const rows = candidates.filter((c) => !skippedIndexes.has(c.index)).map((c) => c.row);
  const meta = candidates.filter((c) => !skippedIndexes.has(c.index)).map((c) => c.meta);

  if (rows.length === 0) {
    return { status: 400, body: { success: false, error: 'Hech qanday yaroqli qo\'ng\'iroq topilmadi.', skipped } };
  }

  const { data: inserted, error } = await supabase.from('calls').insert(rows).select('id');
  if (error || !inserted) {
    return { status: 500, body: { success: false, error: `Database Error: ${error?.message || 'insert failed'}` } };
  }

  const prepared: PreparedCall[] = inserted.map((r: any, k: number) => ({
    callId: r.id,
    audioUrl: meta[k].audioUrl,
    managerId: meta[k].managerId,
  }));

  void processBatchInBackground(supabase, prepared);

  return {
    status: 202,
    body: {
      success: true,
      status: 'processing',
      message: 'Batch parsing initialized in background.',
      accepted_count: prepared.length,
      accepted: prepared.map((p) => p.callId),
      skipped,
    },
  };
}

// Qo'lda qayta tiklash: osilib qolgan 'processing' + 'failed' qo'ng'iroqlarni qayta tahlilga qo'yadi.
// Frontend "Qayta urinish" tugmasi yoki CRM webhook shuni chaqirishi mumkin.
router.post('/recover', async (_req: Request, res: Response) => {
  try {
    const out = await recoverStuckCalls({ includeFailed: true });
    return res.status(200).json({ success: true, ...out });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e?.message || 'recover failed' });
  }
});

router.post('/', upload.single('audio'), async (req: Request, res: Response) => {
  try {
    const hasSupabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
    const hasSupabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
    const missingVars: string[] = [];
    if (!process.env.GROQ_API_KEY) missingVars.push('GROQ_API_KEY');
    if (!hasSupabaseUrl) missingVars.push('SUPABASE_URL (yoki NEXT_PUBLIC_SUPABASE_URL)');
    if (!hasSupabaseKey) missingVars.push('SUPABASE_SECRET_KEY (yoki SUPABASE_SERVICE_ROLE_KEY)');
    if (missingVars.length > 0) {
      console.error('[analyze-call] Missing env vars:', missingVars.join(', '));
      return res.status(503).json({
        success: false,
        error: `Missing backend credentials: ${missingVars.join(', ')}. Railway → Variables bo'limiga qo'shing.`,
        missing: missingVars,
      });
    }

    const supabase = getSupabaseAdmin();

    // ===== BATCH REJIM: body.calls = [{audio_url, manager_id}, ...] → 202 + fon =====
    if (Array.isArray(req.body?.calls)) {
      const out = await enqueueBatchCalls(req.body.calls, supabase);
      return res.status(out.status).json(out.body);
    }

    // ===== YAKKA REJIM (sinxron) =====
    // manager_id ham JSON, ham multipart (req.body) dan o'qiladi.
    let { manager_id } = req.body ?? {};
    const platformId = (req.body && typeof req.body.platform_id === 'string' && req.body.platform_id) ? req.body.platform_id : null;
    const bodyAudioUrl = (req.body && typeof req.body.audio_url === 'string') ? req.body.audio_url.trim() : '';
    const uploadedFile = (req as any).file as { path: string; mimetype: string } | undefined;

    // Audio manbai: yuklangan FAYL yoki audio_url — kamida bittasi kerak.
    if (!uploadedFile && (!bodyAudioUrl || !isValidHttpUrl(bodyAudioUrl))) {
      return res.status(400).json({
        success: false,
        error: 'Audio kerak: "audio" fayl (multipart) yoki yaroqli "audio_url" yuboring.',
      });
    }

    // manager_id IXTIYORIY:
    //  - manager_id (UUID) berilsa → o'sha menejer
    //  - manager_name berilsa (CRM xodim ismi) → topiladi yoki AVTOMATIK yaratiladi
    //  - hech biri yo'q → "Tayinlanmagan" menejer
    const managerName = (req.body && typeof req.body.manager_name === 'string' && req.body.manager_name.trim())
      ? req.body.manager_name.trim() : '';
    let manager: { id: string; name: string; status: string };
    if (manager_id !== undefined && manager_id !== null && manager_id !== '') {
      if (typeof manager_id !== 'string' || !isValidUUID(manager_id)) {
        return res.status(400).json({ success: false, error: 'manager_id berilsa, yaroqli UUID bo\'lishi kerak.' });
      }
      const { data, error: managerLookupError } = await supabase
        .from('managers')
        .select('id, name, status')
        .eq('id', manager_id)
        .single();
      if (managerLookupError || !data) {
        return res.status(404).json({ success: false, error: 'Manager not found' });
      }
      manager = data;
    } else if (managerName) {
      manager = await getOrCreateManagerByName(supabase, managerName);
      manager_id = manager.id;
    } else {
      manager = await getOrCreateDefaultManager(supabase);
      manager_id = manager.id;
    }

    const extraRules = await buildDynamicRules(supabase);

    // Audit kirishi: fayl bo'lsa diskdagi fayldan, aks holda URL'dan.
    let audio_url = bodyAudioUrl;
    let audit: AuditResult;
    if (uploadedFile) {
      audit = await auditCallWithGroq({ filePath: uploadedFile.path, mimeType: uploadedFile.mimetype }, extraRules);
      // Faylni Storage'ga saqlab, qayta eshitish uchun public URL olamiz, so'ng tmp'ni tozalaymiz.
      try {
        const buf = await readFile(uploadedFile.path);
        audio_url = (await uploadAudioToStorage(supabase, buf, uploadedFile.mimetype)) || '';
      } finally {
        await unlink(uploadedFile.path).catch(() => {});
      }
    } else {
      audit = await auditCallWithGroq({ audioUrl: bodyAudioUrl }, extraRules);
    }

    const { data: callRow, error: callInsertError } = await supabase
      .from('calls')
      .insert({ manager_id, audio_url, status: 'done', ...(platformId ? { platform_id: platformId } : {}), ...callRowFields(audit) })
      .select('id')
      .single();

    if (callInsertError || !callRow) {
      console.error('Call insert failed:', callInsertError);
      return res.status(500).json({ success: false, error: 'Failed to persist call record' });
    }

    const callId = callRow.id as string;

    const results = await Promise.allSettled(childWritePromises(supabase, callId, audit));
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.error(`Insert #${i} failed:`, r.reason);
      }
    });

    const kpi = await evaluateManagerKpi(supabase, manager_id);

    if (kpi.alert && manager.status !== 'flagged') {
      const { error: flagError } = await supabase
        .from('managers')
        .update({ status: 'flagged' })
        .eq('id', manager_id);
      if (flagError) {
        console.error('Manager flag update failed:', flagError);
      }
    }

    // amoCRM / n8n integratsiyasi — best-effort, javobni bloklamaydi.
    if (process.env.N8N_WEBHOOK_URL) {
      fetch(process.env.N8N_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'call.analyzed',
          source: 'procell-ai-audit',
          call: {
            call_id: callId,
            manager_name: manager.name,
            manager_id,
            kpi_score: audit.kpi_score,
            penalty_amount: audit.penalty_amount,
            bonus_amount: audit.bonus_amount,
            rop_comment: audit.rop_comment,
            lost_reasons: audit.lost_reasons,
            audio_url,
          },
        }),
      }).catch((e) => console.error('n8n webhook failed:', e));
    }

    return res.status(200).json({
      success: true,
      call_id: callId,
      manager: {
        id: manager.id,
        name: manager.name,
        status: kpi.alert ? 'flagged' : manager.status,
      },
      audit: {
        transcript: audit.transcript,
        transcript_segments: audit.transcript_segments,
        rop_comment: audit.rop_comment,
        summary: audit.summary,
        sentiment: audit.sentiment,
        risk: audit.risk,
        client_info: audit.client_info,
        final_agreement: audit.final_agreement,
        next_steps: audit.next_steps,
        criteria_scores: audit.criteria_scores,
        kpi_score: audit.kpi_score,
        penalty_amount: audit.penalty_amount,
        bonus_amount: audit.bonus_amount,
        metrics: {
          total_calls: audit.total_calls,
          incoming_count: audit.incoming_count,
          outgoing_count: audit.outgoing_count,
          duration: audit.duration,
          unanswered_count: audit.unanswered_count,
          bad_leads_count: audit.bad_leads_count,
        },
        conversions: {
          traffic_conversion: audit.traffic_conversion,
          sales_conversion: audit.sales_conversion,
          stage_1_to_2: audit.stage_1_to_2,
          stage_2_to_3: audit.stage_2_to_3,
          stage_3_to_4: audit.stage_3_to_4,
        },
        lost_reasons: audit.lost_reasons,
      },
      kpi: {
        qualified_calls_today: kpi.qualified_calls_today,
        threshold: KPI_THRESHOLD,
        is_critical: !!kpi.alert,
        alert: kpi.alert,
      },
    });
  } catch (err: any) {
    console.error('Audit handler error:', err);
    const message = String(err?.message || 'Unknown error');
    const invalidGroqKey = /invalid api key|invalid_api_key/i.test(message);
    if (invalidGroqKey) {
      return res.status(503).json({
        success: false,
        error: 'Server configuration error: invalid GROQ_API_KEY.',
        missing: ['GROQ_API_KEY'],
      });
    }
    const statusCode = typeof err?.statusCode === 'number' ? err.statusCode : 500;
    return res.status(statusCode).json({ success: false, error: message });
  }
});

router.get('/', async (_req: Request, res: Response) => {
  try {
    const now = Date.now();
    if (cachedMetrics && (now - lastCacheTime < CACHE_TTL_MS)) {
      return res.status(200).json({
        success: true,
        data: cachedMetrics,
        cached: true,
      });
    }

    const supabase = getSupabaseAdmin();

    const [callsRes, conversionsRes, lostReasonsRes] = await Promise.all([
      supabase.from('calls').select('id, duration'),
      supabase.from('conversions').select('traffic_conversion, sales_conversion'),
      supabase.from('lost_reasons').select('reason_text')
    ]);

    if (callsRes.error) throw callsRes.error;
    if (conversionsRes.error) throw conversionsRes.error;
    if (lostReasonsRes.error) throw lostReasonsRes.error;

    const totalCalls = callsRes.data?.length || 0;
    const avgDuration = totalCalls > 0
      ? (callsRes.data?.reduce((acc, c) => acc + (c.duration || 0), 0) || 0) / totalCalls
      : 0;

    const totalConversions = conversionsRes.data?.length || 0;
    const averages = {
      traffic_conversion: totalConversions > 0 ? (conversionsRes.data?.reduce((acc, s) => acc + Number(s.traffic_conversion), 0) || 0) / totalConversions : 0,
      sales_conversion: totalConversions > 0 ? (conversionsRes.data?.reduce((acc, s) => acc + Number(s.sales_conversion), 0) || 0) / totalConversions : 0,
    };

    const lostReasonsSummary: Record<string, number> = {};
    lostReasonsRes.data?.forEach((lr) => {
      lostReasonsSummary[lr.reason_text] = (lostReasonsSummary[lr.reason_text] || 0) + 1;
    });

    cachedMetrics = {
      totalCalls,
      averageDurationSeconds: Math.round(avgDuration),
      averages,
      lostReasonsSummary,
      cachedAt: new Date().toISOString(),
    };
    lastCacheTime = now;

    return res.status(200).json({
      success: true,
      data: cachedMetrics,
      cached: false,
    });
  } catch (error: any) {
    console.error('Metrics handler error:', error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to retrieve metrics.',
    });
  }
});

export default router;
