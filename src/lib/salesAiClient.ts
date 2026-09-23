// sales-ai-front (Whisper) — audio -> matn (transcript) + tahlil (analysis)
// tashqi xizmati. Foydalanuvchi 2026-09-23'da UTel audiolarini shu xizmatga
// yuborishни tanladi (ichki Aisha/Gemini o'rniga — Aisha balansi/auth
// ishlamaydi). Natija procell.uz JAMALS qo'ng'iroqlariga yoziladi.
//
// API (foydalanuvchi bergan):
//   POST /api/v1/calls  (Bearer, multipart: file, client_name) -> {id, status:"pending"}
//   GET  /api/v1/calls/:id (Bearer) -> {call{status,duration_sec,...}, transcript{full_text,dialog,talk_ratio,words_count}, analysis{...}}
// Status oqimi kuzatildi: pending -> transcribing -> done (yoki failed).

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const BASE = (process.env.SALES_AI_BASE_URL || 'https://sales-ai-front.vercel.app').replace(/\/+$/, '');
const API_KEY = process.env.SALES_AI_API_KEY || '';

// Xizmat (Vercel) so'rov tanasiga ~4.5 MB chegara qo'yadi: undan katta fayl
// HTTP 413 bilan rad etiladi. UTel esa SIQILMAGAN .wav beradi (~1 MB/daqiqa),
// ya'ni 4-5 daqiqadan uzun har qanday qo'ng'iroq umuman matnga o'girilmasdi —
// 2026-09-23'da aynan shu aniqlandi (393 soniyalik qo'ng'iroq = 6 MB = 413).
// Shu sabab audio yuborishdan oldin MP3'ga siqiladi (mono, 16 kHz, 24 kbps —
// nutq uchun yetarli): 6 MB -> ~1 MB, 30 daqiqalik qo'ng'iroq ham sig'adi.
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

// ffmpeg: avval ffmpeg-static (npm), bo'lmasa tizimdagisi.
function ffmpegPath(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const p = require('ffmpeg-static');
    if (typeof p === 'string' && p && existsSync(p)) return p;
  } catch { /* paket yo'q — tizimdagisiga o'tamiz */ }
  for (const p of ['/usr/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg']) {
    if (existsSync(p)) return p;
  }
  return null;
}

// WAV -> MP3. Muvaffaqiyatsiz bo'lsa null (asl fayl yuboriladi).
async function compressToMp3(buf: Buffer): Promise<Buffer | null> {
  const bin = ffmpegPath();
  if (!bin) {
    console.warn('ffmpeg topilmadi — audio siqilmasdan yuboriladi.');
    return null;
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'procell-mp3-'));
  const inPath = path.join(dir, 'in.wav');
  const outPath = path.join(dir, 'out.mp3');
  try {
    await writeFile(inPath, buf);
    await new Promise<void>((resolve, reject) => {
      const ps = spawn(bin, ['-hide_banner', '-loglevel', 'error', '-y', '-i', inPath,
        '-vn', '-ac', '1', '-ar', '16000', '-b:a', '24k', outPath]);
      let err = '';
      ps.stderr.on('data', (d) => { err += String(d).slice(0, 500); });
      ps.on('error', reject);
      ps.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg xatosi (${code}): ${err}`))));
    });
    return Buffer.from(await readFile(outPath));
  } catch (e: any) {
    console.warn('Audio siqib bo\'lmadi:', e?.message || e);
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export interface SalesAiResult {
  status: string;                 // done | failed | ...
  durationSec: number | null;
  fullText: string;
  dialog: unknown[];              // [{speaker,text,...}] — sales-ai-front formati
  talkRatio: Record<string, unknown>;
  wordsCount: number;
  analysis: any;                  // KPI/ball/izoh — strukturasi haqiqiy (gaplashilgan)
                                  // qo'ng'iroq kelganda aniqlanadi; hozircha xom saqlanadi
  raw: any;
}

function authHeader(): Record<string, string> {
  if (!API_KEY) throw new Error('SALES_AI_API_KEY sozlanmagan.');
  return { Authorization: `Bearer ${API_KEY}` };
}

// Audioni URL'dan yuklab, sales-ai-front'ga multipart yuboradi. Qaytaradi: tahlil id.
export async function submitAudioForAnalysis(audioUrl: string, clientName?: string): Promise<string> {
  // 1) UTel'dan audioni yuklab olamiz (auth'siz ochiladi — tekshirilgan).
  // TIMEOUT majburiy: Node'ning fetch'ida standart timeout YO'Q. Timeoutsiz
  // bitta osilib qolgan yuklash butun navbatni abadiy to'xtatib qo'yadi
  // (2026-09-23'da shunga yaqin holat kuzatildi).
  const audioResp = await fetch(audioUrl, {
    headers: { 'User-Agent': 'Procell-Audio/1.0', Accept: 'audio/*,*/*' },
    signal: AbortSignal.timeout(120_000),
  });
  if (!audioResp.ok) throw new Error(`Audio yuklab bo'lmadi: HTTP ${audioResp.status}`);
  const raw = Buffer.from(await audioResp.arrayBuffer());
  if (!raw.length) throw new Error('Audio bo\'sh.');

  // 2) Siqamiz (MP3). Siqib bo'lmasa — asl faylni yuboramiz.
  let buf: Buffer = raw;
  let ext = audioUrl.toLowerCase().includes('.mp3') ? 'mp3' : 'wav';
  if (ext !== 'mp3') {
    const mp3 = await compressToMp3(raw);
    if (mp3 && mp3.length && mp3.length < raw.length) {
      buf = mp3;
      ext = 'mp3';
      console.log(`Audio siqildi: ${(raw.length / 1024 / 1024).toFixed(1)} MB -> ${(buf.length / 1024 / 1024).toFixed(1)} MB`);
    }
  }
  if (buf.length > MAX_UPLOAD_BYTES) {
    throw new Error(`AUDIO_TOO_LARGE: siqilgandan keyin ham katta (${(buf.length / 1024 / 1024).toFixed(1)} MB).`);
  }

  // 3) sales-ai-front'ga multipart POST.
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(buf)]), `call.${ext}`);
  if (clientName) form.append('client_name', clientName);

  const resp = await fetch(`${BASE}/api/v1/calls`, {
    method: 'POST',
    headers: { ...authHeader() },
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  const body: any = await resp.json().catch(() => ({}));
  if (!resp.ok || !body?.id) {
    // 413 = fayl xizmat limitidan katta. Bu QAYTA URINSA HAM tuzalmaydi —
    // maxsus belgi qo'yamiz, navbat (recoverUtelCalls) bunday qo'ng'iroqlarni
    // qayta olmasin va boshqalarni bloklamasin.
    if (resp.status === 413) {
      throw new Error(`AUDIO_TOO_LARGE: audio sales-ai limitidan katta (${(buf.length / 1024 / 1024).toFixed(1)} MB).`);
    }
    throw new Error(`sales-ai POST xatosi: HTTP ${resp.status} ${JSON.stringify(body).slice(0, 200)}`);
  }
  return String(body.id);
}

// Bitta tahlil natijasini oladi (bir marta).
export async function fetchAnalysisOnce(id: string): Promise<SalesAiResult> {
  const resp = await fetch(`${BASE}/api/v1/calls/${id}`, {
    headers: { ...authHeader() },
    signal: AbortSignal.timeout(30_000),
  });
  const body: any = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(`sales-ai GET xatosi: HTTP ${resp.status}`);
  const call = body?.call || {};
  const tr = body?.transcript || {};
  return {
    status: String(call.status || body?.status || 'unknown'),
    durationSec: call.duration_sec ?? null,
    fullText: tr.full_text || '',
    dialog: Array.isArray(tr.dialog) ? tr.dialog : [],
    talkRatio: tr.talk_ratio || {},
    wordsCount: tr.words_count || 0,
    analysis: body?.analysis ?? null,
    raw: body,
  };
}

// done/failed bo'lguncha kutadi (poll). Standart: har 8s, 3 daqiqagacha.
export async function waitForAnalysis(id: string, opts: { intervalMs?: number; timeoutMs?: number } = {}): Promise<SalesAiResult> {
  const interval = opts.intervalMs ?? 8000;
  const deadline = Date.now() + (opts.timeoutMs ?? 180_000);
  let last: SalesAiResult | null = null;
  while (Date.now() < deadline) {
    last = await fetchAnalysisOnce(id);
    if (last.status === 'done' || last.status === 'failed' || last.status === 'error') return last;
    await new Promise((r) => setTimeout(r, interval));
  }
  return last || { status: 'timeout', durationSec: null, fullText: '', dialog: [], talkRatio: {}, wordsCount: 0, analysis: null, raw: null };
}

export function isSalesAiConfigured(): boolean {
  return !!API_KEY;
}
