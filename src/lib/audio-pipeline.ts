import { GoogleGenAI, Type } from '@google/genai';
import axios from 'axios';
import FormData from 'form-data';
import fs from 'node:fs';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

export interface CriteriaScore {
  title: string;
  category: string | null;
  score: number;
}

export interface LostReason {
  reason_text: string;
}

export interface CallAnalysis {
  sentiment: 'positive' | 'negative' | 'neutral';
  client_mood: string;
  operator_evaluation: string;
  deal_closed: boolean;
  summary: string;
  kpi_score: number;
  client_info: string;
  final_agreement: string;
  next_steps: string[];
  lost_reasons: LostReason[];
  criteria_scores: CriteriaScore[];
}

export interface AudioProcessResult {
  transcript: string;
  analysis: CallAnalysis;
  chunks: number;
}

const ANALYZE_MODEL = 'gemini-3.6-flash';
const TMP_ROOT = path.join(os.tmpdir(), 'procell-audio');

// Aisha (aisha.group) — o'zbekcha nutqni matnga aylantirish (STT). v2 endpoint
// uzun audio faylni bitta so'rovda (chunking'siz) qabul qiladi va fon rejimida
// ishlaydi — natija task_id orqali poll qilib olinadi.
const AISHA_BASE_URL = 'https://back.aisha.group';
const AISHA_STT_POST_URL = `${AISHA_BASE_URL}/api/v2/stt/post/`;
const AISHA_STT_GET_URL = (id: number | string) => `${AISHA_BASE_URL}/api/v2/stt/get/${id}/`;
const AISHA_POLL_INTERVAL_MS = 4000;
const AISHA_MAX_WAIT_MS = 15 * 60 * 1000; // 15 daqiqa — juda uzun qo'ng'iroqlar uchun ham yetarli.

const CALL_ANALYSIS_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    sentiment: { type: Type.STRING, format: 'enum', enum: ['positive', 'negative', 'neutral'] },
    client_mood: { type: Type.STRING, description: "Mijozning kayfiyati/holati haqida qisqa izoh" },
    operator_evaluation: { type: Type.STRING, description: "Menejer/operatorning ishi, ohangi, professionalligi haqida tahlil" },
    deal_closed: { type: Type.BOOLEAN },
    summary: { type: Type.STRING, description: "Suhbatning 3-4 jumlalik xulosasi" },
    kpi_score: { type: Type.INTEGER, description: "Menejerning shu qo'ng'iroqdagi umumiy sifat bahosi, 0 dan 100 gacha" },
    client_info: { type: Type.STRING, description: "Mijoz haqida transkriptdan aniqlangan ma'lumot (ism, ehtiyoj, kontekst)" },
    final_agreement: { type: Type.STRING, description: "Suhbat oxiridagi kelishuv yoki natija" },
    next_steps: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "Keyingi qadamlar/harakatlar ro'yxati (bo'lmasa bo'sh massiv)",
    },
    lost_reasons: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: { reason_text: { type: Type.STRING } },
        required: ['reason_text'],
      },
      description: "Agar bitim yopilmagan bo'lsa, sabablari (bo'lsa bo'sh massiv)",
    },
    criteria_scores: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          category: { type: Type.STRING, nullable: true },
          score: { type: Type.INTEGER },
        },
        required: ['title', 'score'],
      },
      description: "Faqat quyida DINAMIK QOIDALAR berilgan bo'lsa to'ldiring — har bir qoida uchun title, category va 0-100 ball. Qoida berilmagan bo'lsa — bo'sh massiv.",
    },
  },
  required: [
    'sentiment', 'client_mood', 'operator_evaluation', 'deal_closed', 'summary',
    'kpi_score', 'client_info', 'final_agreement', 'next_steps', 'lost_reasons', 'criteria_scores',
  ],
};

// Axios xatosidan HTTP status + javob tanasini chiqarib, aniq xabar quradi
// (aks holda faqat "Request failed with status code 400" kabi foydasiz matn qoladi).
function describeAxiosError(error: unknown, context: string): Error {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const data = error.response?.data;
    const bodyText = typeof data === 'string'
      ? data.slice(0, 500)
      : data
        ? JSON.stringify(data).slice(0, 500)
        : error.message;
    return new Error(`${context}: HTTP ${status ?? '?'} — ${bodyText}`);
  }
  return error instanceof Error ? error : new Error(`${context}: ${String(error)}`);
}

async function downloadAudioToTmp(audioUrl: string, targetFilePath: string): Promise<void> {
  let response;
  try {
    response = await axios.get(audioUrl, {
      responseType: 'stream',
      maxRedirects: 5,
      timeout: 120000,
      headers: {
        'User-Agent': 'Procell-Audio/1.0',
        Accept: 'audio/*,*/*',
      },
    });
  } catch (error) {
    throw describeAxiosError(error, `Audio yuklab olishda xato (${audioUrl})`);
  }

  if (!response.data) {
    throw new Error('Audio stream bo\'sh qaytdi.');
  }

  await pipeline(response.data, fs.createWriteStream(targetFilePath));
}

function isRetryableAxiosError(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false;
  const status = error.response?.status;
  if (status && [429, 500, 502, 503, 504].includes(status)) return true;
  return !error.response; // tarmoq xatosi (timeout, connection reset va h.k.)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface AishaSttPostResponse {
  id: number;
  task_id: string;
  status: string;
}

interface AishaSttGetResponse {
  id: number;
  status: string; // PENDING | SUCCESS | FAILED (yoki shunga o'xshash)
  transcript?: string;
}

// Audio faylni Aisha'ga yuboradi (async job yaratadi). Tarmoq/5xx xatolarida qayta uriniladi.
async function submitAishaSttJob(filePath: string): Promise<AishaSttPostResponse> {
  const apiKey = process.env.AISHA_API_KEY;
  if (!apiKey) {
    throw new Error('AISHA_API_KEY yo\'q.');
  }

  const maxAttempts = 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const form = new FormData();
    form.append('audio', fs.createReadStream(filePath));
    form.append('language', 'uz');
    form.append('has_diarization', 'false');
    form.append('is_summary', 'false');

    try {
      const response = await axios.request<AishaSttPostResponse>({
        method: 'POST',
        maxBodyLength: Infinity,
        url: AISHA_STT_POST_URL,
        headers: { 'X-Api-Key': apiKey, ...form.getHeaders() },
        data: form,
        timeout: 120000,
      });

      if (typeof response.data?.id !== 'number') {
        throw new Error(`Aisha kutilmagan javob formati qaytardi: ${JSON.stringify(response.data).slice(0, 300)}`);
      }

      return response.data;
    } catch (error) {
      lastError = error;
      if (isRetryableAxiosError(error) && attempt < maxAttempts) {
        console.warn(`Aisha STT topshirish qayta urinish ${attempt}/${maxAttempts}:`, (error as any)?.message);
        await sleep(1500 * attempt);
        continue;
      }
      throw describeAxiosError(error, 'Aisha STT so\'rovi xato qaytardi');
    }
  }

  throw describeAxiosError(lastError, 'Aisha STT so\'rovi xato qaytardi');
}

// Job tugaguncha poll qiladi (X-Api-Key bilan — task-status/JWT endpoint'i emas,
// hujjatlashtirilgan /api/v2/stt/get/{id}/ ishlatiladi, chunki u ham API key bilan ishlaydi).
async function pollAishaSttResult(id: number): Promise<string> {
  const apiKey = process.env.AISHA_API_KEY as string;
  const deadline = Date.now() + AISHA_MAX_WAIT_MS;

  while (Date.now() < deadline) {
    await sleep(AISHA_POLL_INTERVAL_MS);

    let response;
    try {
      response = await axios.get<AishaSttGetResponse>(AISHA_STT_GET_URL(id), {
        headers: { 'X-Api-Key': apiKey },
        timeout: 30000,
      });
    } catch (error) {
      // Poll paytidagi vaqtinchalik tarmoq xatosi — job'ni bekor qilmasdan keyingi
      // urinishda davom etamiz (retryable bo'lmasa ham, chunki bu faqat status so'rovi).
      console.warn('Aisha STT holatini so\'rashda vaqtinchalik xato:', (error as any)?.message);
      continue;
    }

    const status = (response.data?.status || '').toUpperCase();
    if (status === 'SUCCESS') {
      const transcript = response.data?.transcript;
      if (typeof transcript !== 'string') {
        throw new Error('Aisha SUCCESS qaytardi, lekin transcript yo\'q.');
      }
      return transcript.trim();
    }
    if (status && status !== 'PENDING') {
      throw new Error(`Aisha STT job muvaffaqiyatsiz tugadi (status: ${status}).`);
    }
    // PENDING — davom etamiz.
  }

  throw new Error(`Aisha STT javobi ${Math.round(AISHA_MAX_WAIT_MS / 60000)} daqiqada kelmadi (timeout).`);
}

async function transcribeWithAisha(filePath: string): Promise<string> {
  const job = await submitAishaSttJob(filePath);
  return pollAishaSttResult(job.id);
}

// Gemini bepul tarifida daqiqalik so'rov limiti bor (masalan 20 RPM) — ko'p qo'ng'iroq
// bir vaqtda tahlilga tushsa, "429 RESOURCE_EXHAUSTED" bilan vaqtincha rad etilishi mumkin.
// Xabarda odatda "Please retry in Ns" ko'rsatiladi — shuni o'qib, aynan shuncha kutamiz.
function isRetryableGeminiError(error: unknown): boolean {
  const anyErr = error as any;
  const status = anyErr?.status ?? anyErr?.code ?? anyErr?.response?.status;
  if (status === 429 || status === 'RESOURCE_EXHAUSTED') return true;
  if (typeof status === 'number' && status >= 500) return true;
  const msg = String(anyErr?.message ?? anyErr ?? '');
  return /RESOURCE_EXHAUSTED|"code"\s*:\s*429|"code"\s*:\s*5\d\d|rate limit/i.test(msg);
}

function extractGeminiRetryDelayMs(error: unknown, fallbackMs: number): number {
  const msg = String((error as any)?.message ?? error ?? '');
  const match = msg.match(/retry in ([\d.]+)s/i);
  if (match) {
    const seconds = parseFloat(match[1]);
    if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1000) + 1000;
  }
  return fallbackMs;
}

// Gemini — Aisha bergan transkriptni qo'ng'iroq tahlil skripti (mezonlari) bo'yicha baholaydi.
async function analyzeTranscript(transcript: string, extraRules = ''): Promise<CallAnalysis> {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY yo\'q.');
  }

  const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  const systemPrompt = [
    'Siz tajribali call-center QA analitikisiz. Berilgan qo\'ng\'iroq transkriptini chuqur va diqqat bilan tahlil qiling.',
    'Barcha matn maydonlarini (client_mood, operator_evaluation, summary, client_info, final_agreement, next_steps, lost_reasons) o\'zbek tilida yozing.',
    'kpi_score — menejerning shu qo\'ng\'iroqdagi umumiy ish sifatini 0-100 oralig\'ida real baholang (faqat 0 yoki 100 emas, transkript mazmuniga qarab farqlansin).',
    'criteria_scores massivini FAQAT quyida "QO\'SHIMCHA DINAMIK QOIDALAR" berilgan bo\'lsa to\'ldiring — har bir faol qoida uchun alohida ball bering. Qoidalar berilmagan bo\'lsa, criteria_scores bo\'sh massiv ([]) bo\'lsin.',
    'Agar bitim yopilmagan bo\'lsa, lost_reasons massivida sababini yozing; yopilgan bo\'lsa — bo\'sh massiv.',
    extraRules,
  ]
    .filter(Boolean)
    .join('\n\n');

  const maxAttempts = 4;
  let response: Awaited<ReturnType<typeof client.models.generateContent>> | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      response = await client.models.generateContent({
        model: ANALYZE_MODEL,
        contents: `Quyidagi qo'ng'iroq transkriptini tahlil qil:\n\n${transcript}`,
        config: {
          systemInstruction: systemPrompt,
          responseMimeType: 'application/json',
          responseSchema: CALL_ANALYSIS_SCHEMA,
        },
      });
      break;
    } catch (error) {
      if (isRetryableGeminiError(error) && attempt < maxAttempts) {
        const delay = extractGeminiRetryDelayMs(error, 15000 * attempt);
        console.warn(`Gemini tahlil qayta urinish ${attempt}/${maxAttempts}, ${Math.round(delay / 1000)}s kutilmoqda:`, (error as any)?.message);
        await sleep(delay);
        continue;
      }
      throw error;
    }
  }
  if (!response) {
    throw new Error('Gemini javobi olinmadi (barcha urinishlar tugadi).');
  }

  const text = response.text;
  if (!text) {
    throw new Error('Gemini javobi bo\'sh qaytdi.');
  }

  const parsed = JSON.parse(text) as Partial<CallAnalysis>;
  const sentiment = parsed.sentiment;
  if (sentiment !== 'positive' && sentiment !== 'negative' && sentiment !== 'neutral') {
    throw new Error('Gemini JSON sentiment maydoni noto\'g\'ri.');
  }

  const clampScore = (v: unknown): number => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));

  return {
    sentiment,
    client_mood: typeof parsed.client_mood === 'string' ? parsed.client_mood : '',
    operator_evaluation: typeof parsed.operator_evaluation === 'string' ? parsed.operator_evaluation : '',
    deal_closed: Boolean(parsed.deal_closed),
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    kpi_score: clampScore(parsed.kpi_score),
    client_info: typeof parsed.client_info === 'string' ? parsed.client_info : '',
    final_agreement: typeof parsed.final_agreement === 'string' ? parsed.final_agreement : '',
    next_steps: Array.isArray(parsed.next_steps)
      ? parsed.next_steps.filter((s): s is string => typeof s === 'string' && s.trim() !== '')
      : [],
    lost_reasons: Array.isArray(parsed.lost_reasons)
      ? parsed.lost_reasons
          .filter((r): r is LostReason => !!r && typeof r.reason_text === 'string' && r.reason_text.trim() !== '')
          .map((r) => ({ reason_text: r.reason_text }))
      : [],
    criteria_scores: Array.isArray(parsed.criteria_scores)
      ? parsed.criteria_scores
          .filter((c): c is CriteriaScore => !!c && typeof c.title === 'string' && c.title.trim() !== '')
          .map((c) => ({
            title: c.title,
            category: typeof c.category === 'string' ? c.category : null,
            score: clampScore(c.score),
          }))
      : [],
  };
}

async function removePathSafe(targetPath: string): Promise<void> {
  try {
    await rm(targetPath, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
}

async function transcribeAndAnalyze(filePath: string, extraRules: string): Promise<{ transcript: string; analysis: CallAnalysis }> {
  const transcript = await transcribeWithAisha(filePath);

  if (!transcript) {
    throw new Error('Transcription bo\'sh chiqdi.');
  }

  const analysis = await analyzeTranscript(transcript, extraRules);

  return { transcript, analysis };
}

export async function processLongAudio(audioUrl: string, extraRules = ''): Promise<AudioProcessResult> {
  if (!process.env.AISHA_API_KEY) {
    throw new Error('AISHA_API_KEY yo\'q.');
  }
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY yo\'q.');
  }

  const workspaceDir = path.join(TMP_ROOT, `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const sourcePath = path.join(workspaceDir, 'source-audio.mp3');

  console.time('audio-pipeline');

  try {
    await mkdir(workspaceDir, { recursive: true });

    await downloadAudioToTmp(audioUrl, sourcePath);

    const { transcript, analysis } = await transcribeAndAnalyze(sourcePath, extraRules);

    return { transcript, analysis, chunks: 1 };
  } catch (error: any) {
    throw new Error(`Audio pipeline xatosi: ${error?.message || 'unknown'}`);
  } finally {
    await removePathSafe(workspaceDir);
    console.timeEnd('audio-pipeline');
  }
}

export async function processLocalAudio(localAudioPath: string, extraRules = ''): Promise<AudioProcessResult> {
  if (!process.env.AISHA_API_KEY) {
    throw new Error('AISHA_API_KEY yo\'q.');
  }
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY yo\'q.');
  }

  const workspaceDir = path.join(TMP_ROOT, `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const sourcePath = path.join(workspaceDir, `source-audio${path.extname(localAudioPath) || '.mp3'}`);

  console.time('audio-pipeline');

  try {
    await mkdir(workspaceDir, { recursive: true });

    await copyFile(localAudioPath, sourcePath);

    const { transcript, analysis } = await transcribeAndAnalyze(sourcePath, extraRules);

    return { transcript, analysis, chunks: 1 };
  } catch (error: any) {
    throw new Error(`Audio pipeline xatosi: ${error?.message || 'unknown'}`);
  } finally {
    await removePathSafe(workspaceDir);
    console.timeEnd('audio-pipeline');
  }
}