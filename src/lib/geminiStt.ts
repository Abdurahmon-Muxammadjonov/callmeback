// ============================================================================
// GEMINI STT — sales-ai nosoz bo'lganda ZAXIRA transkripsiya (2026-10-15)
//
// NIMA BO'LDI: 2026-10-04 dan sales-ai-front (Whisper) har bir audioni
// 'transcribing' holatida qoldirib, matn qaytarmay qo'ydi. Circuit breaker
// navbatni pauzaga qo'ydi — 11 kunda 5619 qo'ng'iroq tahlilsiz qoldi.
// Xizmatning o'zi boshqa Railway hisobida, biz tuzata olmaymiz.
//
// NEGA GEMINI (o'lchandi, 2026-10-15, 75 soniyalik haqiqiy o'zbekcha suhbat):
//   OpenAI whisper-1            — qozoqcha/kirill aralash, yaroqsiz
//   OpenAI gpt-4o-transcribe    — ozarbayjoncha harflar, yaroqsiz
//   gpt-4o-transcribe-diarize   — turkcha + "ışık ışık ..." takror, yaroqsiz
//   Aisha (o'zbek STT)          — kalit 403 "Authentication failed"
//   Gemini 3.8 Flash            — toza o'zbekcha lotin, A/B spikerlar va
//                                 vaqt belgilari to'g'ri  <-- tanlandi
//
// Natija sales-ai bilan BIR XIL shaklda (SalesAiResult) qaytadi: dialog
// segmentlari {speaker, start, end, text} — withTimeCodes() va dashboard
// (CallDetail) aynan shu maydonlarni o'qiydi.
//
// ISHONCHLILIK: Gemini yuqori yuklamada 503 ("high demand"), limitda 429
// qaytaradi. Shu sabab: har so'rov geminiLimiter darvozasidan o'tadi,
// 503/429/5xx da kutib qayta uriniladi va keyingi modelga o'tiladi.
// Hammasi yiqilsa — xato tashlanadi, qo'ng'iroq 'failed' bo'ladi va navbat
// uni backoff bilan keyin qayta oladi (yo'qolmaydi).
// ============================================================================

import { withGeminiSlot } from './geminiLimiter';
import type { SalesAiResult } from './salesAiClient';

const API = 'https://generativelanguage.googleapis.com/v1beta/models';

// Tartib muhim: birinchisi asosiy, qolganlari 503/404 bo'lsa zaxira.
// gemini-2.5-flash 2026-10 da yangi foydalanuvchilar uchun o'chirilgan (404).
function models(): string[] {
  const raw = process.env.GEMINI_STT_MODELS || 'gemini-3.8-flash,gemini-3.5-flash,gemini-flash-latest';
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export function isGeminiSttConfigured(): boolean {
  return !!process.env.GEMINI_API_KEY;
}

const PROMPT = [
  "Bu O'ZBEK tilidagi telefon qo'ng'irog'i yozuvi (odatda sotuvchi va mijoz).",
  "Uni SO'ZMA-SO'Z, lotin yozuvidagi o'zbek tilida transkripsiya qil.",
  "Hech narsa qo'shma, tarjima qilma, qisqartirma; eshitilmagan yoki tushunarsiz joyni O'YLAB TOPMA.",
  "Rus tilida aytilgan so'zlar bo'lsa — o'z holicha (kirill yoki lotin) yoz.",
  "Har bir gapiruvchini ROLI bo'yicha belgila: S — kompaniya xodimi (sotuvchi/operator: kompaniya nomidan gapiradi, o'zini tanishtiradi, taklif qiladi),",
  "M — mijoz. Chiquvchi qo'ng'iroqda ko'pincha birinchi bo'lib mijoz \"Alo\" deydi — rolni gapning mazmunidan aniqla, tartibidan emas.",
  "start va end — audio boshidan sekundlarda.",
  "Jiringlash, musiqa yoki sukutni yozma. Agar suhbat umuman bo'lmasa — segments bo'sh ro'yxat.",
  'Faqat JSON qaytar: {"segments":[{"speaker":"S","start":0.0,"end":0.0,"text":"..."}]}',
].join(' ');

export interface SttSegment {
  speaker: string;
  /* Gemini rolni mazmundan aniqlaydi (sales-ai diarizatsiyasida yo'q).
   * Bor bo'lsa GPT (withTimeCodes) va dashboard "birinchi gapirgan —
   * sotuvchi" taxminining o'rniga shuni ishlatadi. */
  role?: 'seller' | 'client';
  start: number;
  end: number;
  text: string;
}

/** Gemini javobini tekshiradi va tozalaydi (sof funksiya — test qilinadi).
 *  - bo'sh matnli segmentlar tashlanadi;
 *  - vaqtlar son, manfiy emas, audio uzunligidan oshmaydi (durationSec berilsa);
 *  - segmentlar vaqt bo'yicha tartiblanadi;
 *  - spiker 'SPEAKER_NN' shakliga keltiriladi (sales-ai bilan bir xil):
 *    S (sotuvchi) — SPEAKER_00 + role 'seller', M (mijoz) — SPEAKER_01 +
 *    role 'client'; boshqa belgilar vaqt tartibida keyingi raqamlarni oladi. */
export function normalizeSegments(raw: unknown, durationSec?: number | null): SttSegment[] {
  const list = Array.isArray((raw as any)?.segments) ? (raw as any).segments : Array.isArray(raw) ? raw : [];
  const cap = Number(durationSec) > 0 ? Number(durationSec) + 5 : Infinity;
  const out: Array<SttSegment & { key: string }> = [];
  for (const s of list as any[]) {
    const text = String(s?.text ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const key = String(s?.speaker ?? '').trim().toUpperCase() || 'A';
    let start = Number(s?.start);
    let end = Number(s?.end);
    if (!Number.isFinite(start) || start < 0) start = out.length ? out[out.length - 1].end : 0;
    if (!Number.isFinite(end) || end < start) end = start;
    start = Math.min(start, cap);
    end = Math.min(end, cap);
    out.push({ key, speaker: '', start: Math.round(start * 10) / 10, end: Math.round(end * 10) / 10, text });
  }
  out.sort((a, b) => a.start - b.start);
  const ids = new Map<string, string>([['S', 'SPEAKER_00'], ['M', 'SPEAKER_01']]);
  return out.map(({ key, ...seg }) => {
    if (!ids.has(key)) ids.set(key, `SPEAKER_${String(ids.size).padStart(2, '0')}`);
    const role = key === 'S' ? 'seller' : key === 'M' ? 'client' : undefined;
    return { ...seg, speaker: ids.get(key)!, ...(role ? { role } : {}) };
  });
}

class RetryableError extends Error {}

async function callModel(model: string, audioB64: string, mime: string): Promise<unknown> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY sozlanmagan.');
  const resp = await fetch(`${API}/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      contents: [{ parts: [{ inline_data: { mime_type: mime, data: audioB64 } }, { text: PROMPT }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0, maxOutputTokens: 32768 },
    }),
    // 30 daqiqalik audio ham sig'ishi uchun keng; Node fetch'da standart timeout yo'q.
    signal: AbortSignal.timeout(6 * 60_000),
  });
  const body: any = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = `Gemini STT ${model}: HTTP ${resp.status} ${String(body?.error?.message || '').slice(0, 160)}`;
    // 404 — model o'chirilgan: keyingi modelga o'tish uchun ham "retryable".
    if (resp.status === 429 || resp.status === 404 || resp.status >= 500) throw new RetryableError(msg);
    throw new Error(msg);
  }
  const cand = body?.candidates?.[0];
  const text = (cand?.content?.parts || []).map((p: any) => p?.text || '').join('');
  if (!text) {
    // Javob kesilgan yoki xavfsizlik filtri — boshqa model bilan urinib ko'ramiz.
    throw new RetryableError(`Gemini STT ${model}: bo'sh javob (finishReason=${cand?.finishReason || '?'})`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new RetryableError(`Gemini STT ${model}: JSON emas (finishReason=${cand?.finishReason || '?'})`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Audio (MP3/WAV bufer) -> sales-ai bilan bir xil shakldagi natija. */
export async function transcribeWithGemini(
  buf: Buffer,
  ext: 'mp3' | 'wav',
  durationSec?: number | null,
): Promise<SalesAiResult> {
  const b64 = buf.toString('base64');
  const mime = ext === 'mp3' ? 'audio/mp3' : 'audio/wav';
  const list = models();
  let lastErr: unknown = null;
  // Har model 3 marta, orada o'sib boruvchi kutish (503 "high demand"
  // odatda bir-ikki daqiqada o'tadi — 2026-10-15 o'lchovida 2-aylanishda o'tdi).
  // Hammasi yiqilsa ham qo'ng'iroq yo'qolmaydi: 'failed' bo'ladi va navbat
  // uni backoff bilan qayta oladi.
  for (let round = 0; round < 3; round++) {
    for (const model of list) {
      try {
        const raw = await withGeminiSlot(() => callModel(model, b64, mime));
        const segs = normalizeSegments(raw, durationSec);
        const fullText = segs.map((s) => s.text).join(' ');
        const speakers = new Set(segs.map((s) => s.speaker));
        console.log(`Gemini STT (${model}): ${segs.length} segment, ${speakers.size} spiker, ${fullText.length} belgi.`);
        return {
          status: 'done',
          durationSec: null, // davomiylik UTel/bazadagidek qoladi (Gemini uni o'lchamaydi)
          fullText,
          dialog: segs,
          talkRatio: {},
          wordsCount: fullText ? fullText.split(/\s+/).length : 0,
          analysis: null,
          raw: { provider: 'gemini', model },
        };
      } catch (e) {
        lastErr = e;
        if (!(e instanceof RetryableError)) throw e;
        console.warn(String((e as Error).message));
        await sleep(8_000 * (round + 1));
      }
    }
  }
  throw new Error(`Gemini STT natija bermadi: ${String((lastErr as Error)?.message || lastErr).slice(0, 200)}`);
}
