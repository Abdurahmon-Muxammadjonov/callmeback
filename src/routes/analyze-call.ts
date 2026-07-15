import { Router, Request, Response } from 'express';
import multer from 'multer';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { SchemaType, type Schema } from '@google/generative-ai';
import { GoogleAIFileManager, FileState } from '@google/generative-ai/server';
import { createWriteStream } from 'node:fs';
import { stat, unlink, readFile, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import os from 'node:os';
import path from 'node:path';

const router = Router();

// Yuklangan audio faylni DISKKA yozamiz (heap'da ulkan buffer ushlamaymiz).
// Limit 2GB — Gemini File API katta/uzoq audiolarni qo'llaydi (30 daqiqa+).
const upload = multer({
  storage: multer.diskStorage({ destination: os.tmpdir() }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
});

// Inline (base64) chegarasi: shundan kichik bo'lsa to'g'ridan-to'g'ri inline,
// kattasi Gemini File API orqali yuboriladi (20MB inline limitini chetlab o'tadi).
const INLINE_MAX_BYTES = 18 * 1024 * 1024;
// Bir vaqtda nechta qo'ng'iroq parallel tahlil qilinadi (memory/limit nazorati).
const ANALYZE_CONCURRENCY = parseInt(process.env.ANALYZE_CONCURRENCY || '4', 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

interface GeminiAuditResult {
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
const GEMINI_INLINE_LIMIT_BYTES = 20 * 1024 * 1024;

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

const STRICT_AUDITOR_INSTRUCTION = `You are an uncompromising, expert AI Sales Quality Assurance (QA) Auditor for the "Procell" platform. Your task is to analyze the provided audio transcript of an Uzbek sales call and strictly evaluate the manager's performance against the official script structure.

You must score the call and populate the JSON response schema according to these detailed operational stages:

### 1. EVALUATION CRITERIA (Script Stages)
- **Stage 0 & 1: Preparation & Greeting ("Salomlashish")**
  * Check if the manager uses an energetic, helpful tone.
  * Must state their name and mention they are from "Axror Abrooriyev's team".
  * Must cite the lead source ("brend sahifamizga qoldirilgan so'rov") and execute a strategic pause for confirmation.
- **Stage 2: Filtering ("Filtrlash")**
  * Must ask the filter question: "Kurs haqida ma'lumot olmoqchimisiz yoki biznesda qatnashmoqchimisiz?"
  * Must qualify the prospect's profession/niche to see if they fit. If they don't fit, the call should be professionally shortened.
- **Stage 3: Programming ("Programmalashtirish")**
  * Must gain permission to lead the call: "Suhbatimiz faloncha daqiqa bo'ladi... savollar beraman va oxirida birgalikda qaror qabul qilamiz. Kelishdikmi?"
- **Stage 4 & 5: Discovery & SPIN ("Ehtiyoj aniqlash & A dan B nuqtaga")**
  * Must uncover Point A (current state/problems) and Point B (goals, income desires by September).
  * Must dive into "Hidden Needs" and obstacles: "O'zingiz mustaqil bunga erisholmayapsizmi? To'siq nima?"
- **Stage 6: Presentation ("Taqdimot")**
  * Must pitch the specific course modules based on client needs (Standard: 5M, Premium: 12M, VIP: 25M UZS).
  * Must tie value to price before revealing the amount if the client is price-focused.
- **Stage 7: Objection Handling ("E'tirozlar")**
  * Must strictly follow the formula: **Acceptance + Argument + Offer** (Qabul qilish + Argument + Taklif) for objections like "Qimmat" (Expensive), "O'ylab ko'raman" (I'll think about it), or "Pulim yo'q" (No money).
- **Stage 8: Closing ("Yopish")**
  * Must push for a commitment or deposit/reservation (Bron: 1,500,000 UZS) and set deadlines.

### 2. AUTOMATIC FINANCIAL PENALTIES (Deducted from Base Salary parameters)
- **Suv ko'pirtirish (Fluff/Filler content)**: Vague, unprofessional chitchat instead of driving script value -> Penalty: 20,000 UZS.
- **No Programming / No Discovery**: Skipping Stage 3 or failing to find deep hidden needs in Stage 5 -> Penalty: 30,000 UZS.
- **Broken Objection Formula**: Handled objections without using the Acceptance+Argument+Offer sequence -> Penalty: 25,000 UZS.
- **Missed Close**: Failed to offer a hard reservation ("Bron") or payment link -> Penalty: 25,000 UZS.

### 3. AUTOMATIC BONUS STATUS
- If \`sales_conversion\` or \`traffic_conversion\` is greater than 75% and the KPI Score is above 80% -> Award Bonus: 50,000 UZS. Else, 0.

### 4. OUTPUT INSTRUCTIONS
- Generate an accurate word-for-word string \`transcript\`.
- ALSO populate \`transcript_segments\`: the FULL dialogue split turn-by-turn. For every spoken turn output an object { speaker, text, start } where speaker is exactly "Manager" or "Mijoz", text is the verbatim Uzbek words for that turn, and start is the approximate start time in SECONDS from the beginning of the audio. Keep chronological order and do not skip any turn.
- Calculate absolute metrics for the JSON payload.
- Provide a 2-3 sentence strict, constructive \`rop_comment\` written in fluent UZBEK, addressing exactly which script stages were executed perfectly and where penalties were applied.
- Populate \`summary\` (UZBEK, multi-line): a fuller audit summary — what the manager did well and exactly what they did wrong, which stages succeeded and which failed.
- Populate \`client_info\` (UZBEK): everything learned about the client — profession, business, niche, current problems, goals, follower counts, budget, income. Be specific with numbers mentioned.
- Populate \`final_agreement\` (UZBEK): the final agreement — which tariff/price was chosen, deposit (zakolat) amount, and the agreed call-back time. If no deal was closed, state that clearly.
- Populate \`next_steps\` (UZBEK array): concrete follow-up actions (e.g. send card number via Telegram, call back at 16:30 to verify deposit, send promised videos, add client to channel).
- Do not output any prose outside the valid JSON.`;

const RESPONSE_SCHEMA: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    transcript: { type: SchemaType.STRING },
    total_calls: { type: SchemaType.INTEGER },
    incoming_count: { type: SchemaType.INTEGER },
    outgoing_count: { type: SchemaType.INTEGER },
    duration: { type: SchemaType.INTEGER },
    unanswered_count: { type: SchemaType.INTEGER },
    bad_leads_count: { type: SchemaType.INTEGER },
    traffic_conversion: { type: SchemaType.NUMBER },
    sales_conversion: { type: SchemaType.NUMBER },
    kpi_score: { type: SchemaType.NUMBER, description: 'Overall strict KPI score from 0 to 100' },
    penalty_amount: { type: SchemaType.NUMBER, description: 'Calculated penalty in UZS based on mistakes' },
    bonus_amount: { type: SchemaType.NUMBER, description: 'Calculated bonus in UZS' },
    rop_comment: { type: SchemaType.STRING, description: '2-3 specific audit sentences in Uzbek (ROP Izoh)' },
    stage_1_to_2: { type: SchemaType.INTEGER },
    stage_2_to_3: { type: SchemaType.INTEGER },
    stage_3_to_4: { type: SchemaType.INTEGER },
    lost_reasons: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          reason_text: { type: SchemaType.STRING },
          count: { type: SchemaType.INTEGER },
        },
        required: ['reason_text', 'count'],
      },
    },
    sentiment: { type: SchemaType.STRING, description: 'Umumiy hissiy ton (masalan: ijobiy/neytral/salbiy + qisqa izoh, Uzbek)' },
    risk: { type: SchemaType.STRING, description: 'Asosiy xavf/risk darajasi va sababi (Uzbek)' },
    criteria_scores: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          title: { type: SchemaType.STRING },
          category: { type: SchemaType.STRING },
          score: { type: SchemaType.INTEGER, description: '0 dan 100 gacha ball' },
        },
        required: ['title', 'score'],
      },
    },
    transcript_segments: {
      type: SchemaType.ARRAY,
      description: 'To\'liq dialog: har bir gap alohida (kim aytdi + matn + taxminiy vaqt)',
      items: {
        type: SchemaType.OBJECT,
        properties: {
          speaker: { type: SchemaType.STRING, description: "'Manager' yoki 'Mijoz'" },
          text: { type: SchemaType.STRING, description: 'Aynan nima gapirilgani (so\'zma-so\'z)' },
          start: { type: SchemaType.NUMBER, description: 'Segment boshlanish vaqti (sekundlarda)' },
        },
        required: ['speaker', 'text'],
      },
    },
    summary: { type: SchemaType.STRING, description: 'Qo\'ng\'iroq xulosasi: menejer nimani yaxshi, nimani noto\'g\'ri qildi (ko\'p qatorli) — Uzbek' },
    client_info: { type: SchemaType.STRING, description: 'Mijoz haqida to\'plangan barcha ma\'lumot (kasbi, biznesi, muammosi, maqsadi, byudjeti) — Uzbek' },
    final_agreement: { type: SchemaType.STRING, description: 'Oxirgi kelishuv: tanlangan tarif, summa, zakolat, qayta bog\'lanish vaqti — Uzbek' },
    next_steps: {
      type: SchemaType.ARRAY,
      description: 'Keyingi qadamlar ro\'yxati (Uzbek)',
      items: { type: SchemaType.STRING },
    },
  },
  required: [
    'transcript',
    'total_calls',
    'incoming_count',
    'outgoing_count',
    'duration',
    'unanswered_count',
    'bad_leads_count',
    'traffic_conversion',
    'sales_conversion',
    'kpi_score',
    'penalty_amount',
    'bonus_amount',
    'rop_comment',
    'stage_1_to_2',
    'stage_2_to_3',
    'stage_3_to_4',
    'lost_reasons',
  ],
};

// Bazadagi aktiv qoidalarni o'qib, Gemini uchun qo'shimcha ko'rsatma matnini quradi.
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

const RETRIABLE_RE = /UNAVAILABLE|RESOURCE_EXHAUSTED|overloaded|high demand/i;

function isRetriableGeminiError(e: any): boolean {
  const status = e?.status ?? e?.response?.status ?? e?.code;
  return status === 503 || status === 429 || RETRIABLE_RE.test(e?.message || '');
}

// Exponential backoff + jitter bilan qayta urinish (vaqtinchalik 503/429 uchun).
async function callGeminiWithRetry<T>(
  fn: () => Promise<T>,
  { retries = 4, baseMs = 1000 }: { retries?: number; baseMs?: number } = {}
): Promise<T> {
  let lastErr: any;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      lastErr = e;
      const status = e?.status ?? e?.response?.status ?? e?.code;
      if (!isRetriableGeminiError(e) || attempt === retries) throw e;
      const delay = baseMs * 2 ** attempt + Math.floor(Math.random() * 400); // jitter
      console.warn(`Gemini ${status} — retry ${attempt + 1}/${retries} ${delay}ms ichida`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// Gemini xatosini frontend uchun toza xabarga aylantiradi.
function makeBusyError(e: any): Error & { statusCode: number } {
  const busy = isRetriableGeminiError(e);
  const err = new Error(
    busy
      ? "AI auditor (Gemini) hozir band. Iltimos, bir necha daqiqadan so'ng qayta urining."
      : `Gemini Direct API Error: ${e?.message || e}`
  ) as Error & { statusCode: number };
  // Band/limit (503/429) -> 503; boshqa Gemini xatolari (404 model, 400 kalit) -> 502.
  err.statusCode = busy ? 503 : 502;
  return err;
}

// Bitta Gemini generateContent so'rovi. Xato bo'lsa, .status bilan Error tashlaydi.
async function requestGeminiOnce(model: string, requestBody: object): Promise<any> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });
  if (!resp.ok) {
    const errText = await resp.text();
    const err = new Error(`Gemini Direct API Error: ${errText}`) as Error & { status?: number };
    err.status = resp.status;
    throw err;
  }
  return resp.json();
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

// URL'dan vaqtinchalik faylga STREAM qiladi — ulkan buffer'ni Node heap'iga yuklamaydi.
async function streamUrlToTempFile(url: string): Promise<{ filePath: string; mimeType: string }> {
  // Brauzerga o'xshash sarlavhalar — ko'p CRM serverlari User-Agent'siz so'rovni bloklaydi.
  const res = await fetch(url, {
    redirect: 'follow',
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ProsellBot/1.0)', Accept: 'audio/*,*/*' },
  });
  if (!res.ok || !res.body) throw new Error(`Audio fetch failed: HTTP ${res.status}`);
  const ct = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  // CRM ba'zan audio o'rniga HTML/JSON (login yoki xato sahifa) qaytaradi.
  if (ct.startsWith('text/') || ct.includes('html') || ct.includes('json')) {
    throw new Error(
      `Audio fetch failed: URL audio emas (content-type: ${ct || 'noma\'lum'}). ` +
      `CRM linki avtorizatsiya yoki redirect talab qilishi mumkin — faylni Catbox/Supabase Storage kabi ` +
      `to'g'ridan-to'g'ri ochiladigan manzilga joylang yoki "audio" faylni multipart bilan yuboring.`,
    );
  }
  const mimeType = ct || 'audio/mpeg';
  const filePath = tmpAudioPath(extFromMime(mimeType));
  await pipeline(Readable.fromWeb(res.body as any), createWriteStream(filePath));
  return { filePath, mimeType };
}

// Audio "part" (inline yoki File API) ni Gemini'ga yuboradi; retry + model fallback bilan.
async function runGeminiAudit(audioPart: any, extraRules: string): Promise<Partial<GeminiAuditResult>> {
  const primaryModel = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const fallbackModel = process.env.GEMINI_FALLBACK_MODEL || 'gemini-2.0-flash';

  const requestBody = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: "Auditor! Transcribe and strictly judge this sales call using the structural options provided." },
          audioPart,
        ],
      },
    ],
    systemInstruction: { parts: [{ text: STRICT_AUDITOR_INSTRUCTION + extraRules }] },
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0.1,
    },
  };

  let geminiData: any;
  try {
    geminiData = await callGeminiWithRetry(() => requestGeminiOnce(primaryModel, requestBody));
  } catch (primaryErr: any) {
    if (isRetriableGeminiError(primaryErr) && fallbackModel && fallbackModel !== primaryModel) {
      console.warn(`Birlamchi model (${primaryModel}) band — fallback (${fallbackModel}) bilan urinamiz`);
      try {
        geminiData = await callGeminiWithRetry(() => requestGeminiOnce(fallbackModel, requestBody), { retries: 1 });
      } catch (fallbackErr: any) {
        throw makeBusyError(fallbackErr);
      }
    } else {
      throw makeBusyError(primaryErr);
    }
  }

  const resultText = geminiData.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!resultText) throw new Error('Gemini returned empty response content');
  try {
    return JSON.parse(resultText) as Partial<GeminiAuditResult>;
  } catch (e) {
    throw new Error(`Gemini returned invalid JSON: ${(e as Error).message}`);
  }
}

// Diskdagi audio faylni tahlil qiladi: HAQIQIY uzunlik + (kichik→inline / katta→File API).
async function auditAudioFile(filePath: string, mimeType: string, extraRules: string): Promise<GeminiAuditResult> {
  // Audio faylning HAQIQIY uzunligini diskdan o'lchaymiz (Gemini taxminiga ishonmaymiz).
  let realDurationSec = 0;
  try {
    const mm = await import('music-metadata');
    const meta = await mm.parseFile(filePath);
    realDurationSec = Math.round(meta.format.duration || 0);
  } catch (e) {
    console.warn('Audio duration parse failed:', (e as Error).message);
  }

  const { size } = await stat(filePath);
  let audioPart: any;
  let uploadedFileName: string | undefined;

  if (size <= INLINE_MAX_BYTES) {
    // Kichik fayl — inline base64 (tez, qo'shimcha yuklash kerak emas).
    const buf = await readFile(filePath);
    audioPart = { inlineData: { mimeType, data: buf.toString('base64') } };
  } else {
    // Katta/uzoq audio (30 daqiqa+) — Gemini File API. Heap'ga base64 yuklamaymiz.
    const fm = new GoogleAIFileManager(process.env.GEMINI_API_KEY || '');
    const uploaded = await fm.uploadFile(filePath, { mimeType, displayName: path.basename(filePath) });
    uploadedFileName = uploaded.file.name;
    let f = uploaded.file;
    // Fayl ACTIVE bo'lguncha kutamiz (Gemini uni qabul qilib qayta ishlaydi).
    let guard = 0;
    while (f.state === FileState.PROCESSING && guard++ < 150) {
      await sleep(2000);
      f = await fm.getFile(uploaded.file.name);
    }
    if (f.state !== FileState.ACTIVE) {
      throw new Error(`Gemini fayl ishlovi muvaffaqiyatsiz (state: ${f.state})`);
    }
    audioPart = { fileData: { fileUri: f.uri, mimeType } };
  }

  try {
    const parsed = await runGeminiAudit(audioPart, extraRules);
    const result = normalizeAuditResult(parsed);
    if (realDurationSec > 0) result.duration = realDurationSec; // 1:58 emas, aniq 27:00
    return result;
  } finally {
    // Gemini'ga yuklangan faylni tozalaymiz (best-effort).
    if (uploadedFileName) {
      try {
        const fm = new GoogleAIFileManager(process.env.GEMINI_API_KEY || '');
        await fm.deleteFile(uploadedFileName);
      } catch {
        /* ignore */
      }
    }
  }
}

// Manbani (URL / buffer / fayl yo'li) diskdagi faylga keltirib, auditAudioFile chaqiradi.
async function auditCallWithGemini(input: AudioInput, extraRules = ''): Promise<GeminiAuditResult> {
  let filePath: string;
  let mimeType: string;
  let cleanupTemp = false;

  if (input.filePath) {
    filePath = input.filePath; // multer diskka yozgan fayl — egasi tozalaydi
    mimeType = input.mimeType || 'audio/mpeg';
  } else if (input.audioBuffer) {
    mimeType = input.mimeType || 'audio/mpeg';
    filePath = tmpAudioPath(extFromMime(mimeType));
    await writeFile(filePath, input.audioBuffer);
    cleanupTemp = true;
  } else if (input.audioUrl) {
    const r = await streamUrlToTempFile(input.audioUrl);
    filePath = r.filePath;
    mimeType = r.mimeType;
    cleanupTemp = true;
  } else {
    throw new Error('Audio manbai yo\'q: audioUrl, audioBuffer yoki filePath kerak.');
  }

  try {
    return await auditAudioFile(filePath, mimeType, extraRules);
  } finally {
    if (cleanupTemp) {
      try { await unlink(filePath); } catch { /* ignore */ }
    }
  }
}

function normalizeAuditResult(r: Partial<GeminiAuditResult>): GeminiAuditResult {
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
    .insert({ name: DEFAULT_MANAGER_NAME, status: 'active' })
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
    .from('managers').insert({ name: clean, status: 'active' }).select('id, name, status').single();
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
function callRowFields(audit: GeminiAuditResult) {
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
function childWritePromises(supabase: SupabaseClient, callId: string, audit: GeminiAuditResult) {
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
    const audit = await auditCallWithGemini({ audioUrl: prep.audioUrl }, extraRules);
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
    if (!process.env.GEMINI_API_KEY || !hasSupabaseUrl || !hasSupabaseKey) {
      return res.status(500).json({
        success: false,
        error: 'Server configuration error: missing required environment credentials.',
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
    let audit: GeminiAuditResult;
    if (uploadedFile) {
      audit = await auditCallWithGemini({ filePath: uploadedFile.path, mimeType: uploadedFile.mimetype }, extraRules);
      // Faylni Storage'ga saqlab, qayta eshitish uchun public URL olamiz, so'ng tmp'ni tozalaymiz.
      try {
        const buf = await readFile(uploadedFile.path);
        audio_url = (await uploadAudioToStorage(supabase, buf, uploadedFile.mimetype)) || '';
      } finally {
        await unlink(uploadedFile.path).catch(() => {});
      }
    } else {
      audit = await auditCallWithGemini({ audioUrl: bodyAudioUrl }, extraRules);
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
    const statusCode = typeof err?.statusCode === 'number' ? err.statusCode : 500;
    return res.status(statusCode).json({ success: false, error: err.message });
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
