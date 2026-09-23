// sales-ai-front (Whisper) — audio -> matn (transcript) + tahlil (analysis)
// tashqi xizmati. Foydalanuvchi 2026-09-23'da UTel audiolarini shu xizmatga
// yuborishни tanladi (ichki Aisha/Gemini o'rniga — Aisha balansi/auth
// ishlamaydi). Natija procell.uz JAMALS qo'ng'iroqlariga yoziladi.
//
// API (foydalanuvchi bergan):
//   POST /api/v1/calls  (Bearer, multipart: file, client_name) -> {id, status:"pending"}
//   GET  /api/v1/calls/:id (Bearer) -> {call{status,duration_sec,...}, transcript{full_text,dialog,talk_ratio,words_count}, analysis{...}}
// Status oqimi kuzatildi: pending -> transcribing -> done (yoki failed).

const BASE = (process.env.SALES_AI_BASE_URL || 'https://sales-ai-front.vercel.app').replace(/\/+$/, '');
const API_KEY = process.env.SALES_AI_API_KEY || '';

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
  const audioResp = await fetch(audioUrl, {
    headers: { 'User-Agent': 'Procell-Audio/1.0', Accept: 'audio/*,*/*' },
  });
  if (!audioResp.ok) throw new Error(`Audio yuklab bo'lmadi: HTTP ${audioResp.status}`);
  const buf = Buffer.from(await audioResp.arrayBuffer());
  if (!buf.length) throw new Error('Audio bo\'sh.');

  // 2) sales-ai-front'ga multipart POST.
  const form = new FormData();
  const ext = audioUrl.toLowerCase().includes('.mp3') ? 'mp3' : 'wav';
  form.append('file', new Blob([buf]), `call.${ext}`);
  if (clientName) form.append('client_name', clientName);

  const resp = await fetch(`${BASE}/api/v1/calls`, {
    method: 'POST',
    headers: { ...authHeader() },
    body: form,
  });
  const body: any = await resp.json().catch(() => ({}));
  if (!resp.ok || !body?.id) {
    throw new Error(`sales-ai POST xatosi: HTTP ${resp.status} ${JSON.stringify(body).slice(0, 200)}`);
  }
  return String(body.id);
}

// Bitta tahlil natijasini oladi (bir marta).
export async function fetchAnalysisOnce(id: string): Promise<SalesAiResult> {
  const resp = await fetch(`${BASE}/api/v1/calls/${id}`, { headers: { ...authHeader() } });
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
