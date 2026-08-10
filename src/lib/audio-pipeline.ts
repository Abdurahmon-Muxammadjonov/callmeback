import { GoogleGenAI, Type } from '@google/genai';
import axios from 'axios';
import FormData from 'form-data';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegStatic from 'ffmpeg-static';
import fs from 'node:fs';
import { copyFile, readdir, mkdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

if (ffmpegStatic) {
  ffmpeg.setFfmpegPath(ffmpegStatic);
}

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

// Muxlisa STT bir so'rovda maksimal 60 soniyalik audio qabul qiladi —
// xavfsizlik zaxirasi uchun 50 soniyaga bo'lamiz.
const SEGMENT_SECONDS = 50;
const ANALYZE_MODEL = 'gemini-3.6-flash';
const TMP_ROOT = path.join(os.tmpdir(), 'procell-audio');
const MUXLISA_STT_URL = 'https://service.muxlisa.uz/api/v2/stt';

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

function sortChunkFiles(files: string[]): string[] {
  return [...files].sort((left, right) => {
    const leftNum = Number(path.basename(left).match(/(\d+)/)?.[1] || 0);
    const rightNum = Number(path.basename(right).match(/(\d+)/)?.[1] || 0);
    return leftNum - rightNum;
  });
}

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

async function splitAudioToChunks(inputFilePath: string, chunksDir: string): Promise<string[]> {
  await mkdir(chunksDir, { recursive: true });
  // WAV'ga qayta kodlaymiz (stream-copy emas) — shunda har bir bo'lak har doim
  // to'liq to'g'ri sarlavha/format bilan chiqadi (kesish nuqtasida buzilgan MP3
  // freym bo'lish ehtimoli yo'q). Muxlisa bilan WAV avval sinalgan va ishlaydi.
  const outputPattern = path.join(chunksDir, 'chunk-%05d.wav');

  try {
    await new Promise<void>((resolve, reject) => {
      ffmpeg(inputFilePath)
        .outputOptions([
          '-f segment',
          `-segment_time ${SEGMENT_SECONDS}`,
          '-ar 16000',
          '-ac 1',
        ])
        .output(outputPattern)
        .on('end', () => resolve())
        .on('error', (error: Error) => reject(error))
        .run();
    });
  } catch (error: any) {
    const msg = String(error?.message || error || '');
    if (msg.toLowerCase().includes('cannot find ffmpeg') || msg.toLowerCase().includes('ffmpeg was not found')) {
      console.warn('ffmpeg topilmadi, chunk qilish o\'rniga bitta fayl transkripsiya qilinadi.');
      return [inputFilePath];
    }
    throw error;
  }

  const files = (await readdir(chunksDir))
    .filter((name) => name.startsWith('chunk-'))
    .map((name) => path.join(chunksDir, name));

  if (files.length === 0) {
    const inputStats = await stat(inputFilePath);
    if (inputStats.size > 0) return [inputFilePath];
    throw new Error('Chunk fayllar yaratilmadi. ffmpeg chiqishini tekshiring.');
  }

  return sortChunkFiles(files);
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

// Muxlisa.uz — nutqni matnga aylantirish (STT). Ko'p bo'lak parallel yuborilganda
// ularning serveri vaqtinchalik 5xx berishi mumkin — shu uchun qayta uriniladi.
async function transcribeChunkWithMuxlisa(chunkPath: string): Promise<string> {
  const apiKey = process.env.MUXLISA_API_KEY;
  if (!apiKey) {
    throw new Error('MUXLISA_API_KEY yo\'q.');
  }

  const maxAttempts = 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const form = new FormData();
    form.append('audio', fs.createReadStream(chunkPath));

    try {
      const response = await axios.request({
        method: 'POST',
        maxBodyLength: Infinity,
        url: MUXLISA_STT_URL,
        headers: { 'x-api-key': apiKey, ...form.getHeaders() },
        data: form,
        timeout: 120000,
      });

      const text = response.data?.text;
      if (typeof text !== 'string') {
        throw new Error(`Muxlisa kutilmagan javob formati qaytardi: ${path.basename(chunkPath)}`);
      }

      return text.trim();
    } catch (error) {
      lastError = error;
      if (isRetryableAxiosError(error) && attempt < maxAttempts) {
        console.warn(`Muxlisa STT qayta urinish ${attempt}/${maxAttempts} (${path.basename(chunkPath)}):`, (error as any)?.message);
        await sleep(1500 * attempt);
        continue;
      }
      throw describeAxiosError(error, `Muxlisa STT so'rovi xato qaytardi (${path.basename(chunkPath)})`);
    }
  }

  throw describeAxiosError(lastError, `Muxlisa STT so'rovi xato qaytardi (${path.basename(chunkPath)})`);
}

// Cheklangan parallellik: bir vaqtda eng ko'pi bilan `limit` ta bo'lak yuboriladi
// (Muxlisa serverini ortiqcha yuklab, 5xx xatolarga sabab bo'lmasligi uchun).
async function mapWithConcurrency<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const poolSize = Math.max(1, Math.min(limit, items.length));

  const runners = Array.from({ length: poolSize }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) break;
      results[i] = await worker(items[i]);
    }
  });

  await Promise.all(runners);
  return results;
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

// Gemini — Muxlisa bergan transkriptni qo'ng'iroq tahlil skripti (mezonlari) bo'yicha baholaydi.
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

const MUXLISA_CONCURRENCY = parseInt(process.env.MUXLISA_CONCURRENCY || '4', 10);

async function transcribeAndAnalyze(chunkPaths: string[], extraRules: string): Promise<{ transcript: string; analysis: CallAnalysis }> {
  const transcriptParts = await mapWithConcurrency(
    chunkPaths,
    MUXLISA_CONCURRENCY,
    (chunkPath) => transcribeChunkWithMuxlisa(chunkPath)
  );

  const transcript = transcriptParts
    .map((part) => part.trim())
    .filter(Boolean)
    .join('\n\n')
    .trim();

  if (!transcript) {
    throw new Error('Transcription bo\'sh chiqdi.');
  }

  const analysis = await analyzeTranscript(transcript, extraRules);

  return { transcript, analysis };
}

export async function processLongAudio(audioUrl: string, extraRules = ''): Promise<AudioProcessResult> {
  if (!process.env.MUXLISA_API_KEY) {
    throw new Error('MUXLISA_API_KEY yo\'q.');
  }
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY yo\'q.');
  }

  const workspaceDir = path.join(TMP_ROOT, `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const sourcePath = path.join(workspaceDir, 'source-audio.mp3');
  const chunksDir = path.join(workspaceDir, 'chunks');

  const createdFiles: string[] = [];
  console.time('audio-pipeline');

  try {
    await mkdir(workspaceDir, { recursive: true });

    await downloadAudioToTmp(audioUrl, sourcePath);
    createdFiles.push(sourcePath);

    const chunkPaths = await splitAudioToChunks(sourcePath, chunksDir);
    createdFiles.push(...chunkPaths);

    const { transcript, analysis } = await transcribeAndAnalyze(chunkPaths, extraRules);

    return { transcript, analysis, chunks: chunkPaths.length };
  } catch (error: any) {
    throw new Error(`Audio pipeline xatosi: ${error?.message || 'unknown'}`);
  } finally {
    await removePathSafe(chunksDir);
    for (const filePath of createdFiles) {
      await removePathSafe(filePath);
    }
    await removePathSafe(workspaceDir);
    console.timeEnd('audio-pipeline');
  }
}

export async function processLocalAudio(localAudioPath: string, extraRules = ''): Promise<AudioProcessResult> {
  if (!process.env.MUXLISA_API_KEY) {
    throw new Error('MUXLISA_API_KEY yo\'q.');
  }
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY yo\'q.');
  }

  const workspaceDir = path.join(TMP_ROOT, `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const sourcePath = path.join(workspaceDir, `source-audio${path.extname(localAudioPath) || '.mp3'}`);
  const chunksDir = path.join(workspaceDir, 'chunks');

  const createdFiles: string[] = [];
  console.time('audio-pipeline');

  try {
    await mkdir(workspaceDir, { recursive: true });

    await copyFile(localAudioPath, sourcePath);
    createdFiles.push(sourcePath);

    const chunkPaths = await splitAudioToChunks(sourcePath, chunksDir);
    createdFiles.push(...chunkPaths);

    const { transcript, analysis } = await transcribeAndAnalyze(chunkPaths, extraRules);

    return { transcript, analysis, chunks: chunkPaths.length };
  } catch (error: any) {
    throw new Error(`Audio pipeline xatosi: ${error?.message || 'unknown'}`);
  } finally {
    await removePathSafe(chunksDir);
    for (const filePath of createdFiles) {
      await removePathSafe(filePath);
    }
    await removePathSafe(workspaceDir);
    console.timeEnd('audio-pipeline');
  }
}
