import { Router, Request, Response } from 'express';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { supabase } from '../lib/supabase';
import { getOrCreateManagerByPbxId, processTranscriptToCall } from './analyze-call';
import { submitAudioForAnalysis, waitForAnalysis, isSalesAiConfigured } from '../lib/salesAiClient';

// ============================================================================
// UTel (utc381.utel.uz) — O'zbek virtual PBX / bulutli telefoniya webhook.
// BOSQICH 1: har bir hodisani to'liq log qiladi (payload'ni ko'rish uchun).
// BOSQICH 2 (2026-09-23): "call_saved" hodisasida audioni (call_history.
// recorded_file_url) mavjud enqueueBatchCalls quvuriga berib, JAMALS
// kompaniyasiga qo'ng'iroq sifatida yozadi (handleUtelCallSaved). Audio
// URL auth'siz ochiladi (tekshirildi). Boshqa hodisalar (call_started,
// dial_*, call_ended) hozircha faqat log qilinadi.
// QOLGAN (keyingi bosqich): STT'ni Whisper'ga o'tkazish (hozir quvur Aisha
// ishlatadi, uning balansi tugagan — audio saqlanadi/eshitiladi, lekin
// tahlil bo'lmaydi); webhook'ga maxfiy yo'l tokeni / imzo (UTel imzo
// bermaydi — foydalanuvchi tasdiqladi).
//
// UTel dashboard -> Integratsiyalar -> Webhooks'da yoqilgan hodisalar:
//   Call Started, Call Ended, Dial Started, Dial Answered, Dial Ended,
//   Call Transferred, Call Saved.
//
// DIQQAT — bu endpoint hozircha AUTENTIFIKATSIYASIZ (ochiq). Bu ATAYLAB,
// FAQAT payload'ни ko'rish bosqichi uchun. Productiongacha:
//   - UTel imzo sarlavhasi/maxfiy kaliti bormi — hujjat/support'dan
//     aniqlash (bosqich 3). Bo'lsa — rawBody bo'yicha tekshirish.
//   - Bo'lmasa — hech bo'lmaganda maxfiy yo'l tokeni (masalan
//     /webhook/utel/<random>) yoki IP allowlist qo'shish.
// ============================================================================

const router = Router();

// Railway fayl tizimi EFEMER — deploy/restart'da yo'qoladi. Shu sabab asosiy
// log konsolga (railway logs bilan ko'riladi); fayl faqat qulaylik uchun.
const LOG_DIR = process.env.UTEL_LOG_DIR || path.join(os.tmpdir(), 'utel-webhooks');

// UTel akkaunt (domain) -> qaysi kompaniyaga tegishli. Har bir mijoz o'z UTel
// akkaunti bilan ulanadi; qo'ng'iroq shu kompaniyaga yoziladi (multi-tenant).
// Hozircha JAMALS bitta (foydalanuvchi tasdiqladi 2026-09-23). Kelajakda
// yangi UTel mijozi qo'shilsa — shu map'ga qator qo'shiladi (yoki DB'ga
// ko'chiriladi). Domain payload'ning "domain" maydonidan keladi.
const UTEL_DOMAIN_TO_COMPANY: Record<string, string> = {
  'api.utc381.utel.uz': '24823352-465e-43ea-913c-9f9d7270b9e9', // JAMALS INTERNATIONAL ACADEMY
};

function companyIdForDomain(domain?: unknown): string | null {
  if (typeof domain !== 'string' || !domain) return null;
  const host = domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase().trim();
  return UTEL_DOMAIN_TO_COMPANY[host] || null;
}

// "call_saved" — yozuv (audio) tayyor bo'lgan yagona hodisa. Audio
// call_history.recorded_file_url'da (to'g'ridan-to'g'ri .wav, auth'siz —
// 2026-09-23 tekshirildi). Mavjud enqueueBatchCalls quvuriga beramiz: u
// operatorni (manager_pbx_id = src) JAMALS ichida yaratadi/topadi, qo'ng'iroq
// qatorini yozadi, audioni saqlaydi va tahlilga qo'yadi. Dedup: crm_id =
// call_id — bir xil call_saved ikki marta kelsa, ikkinchisi o'tkazib
// yuboriladi.
async function handleUtelCallSaved(payload: any): Promise<void> {
  const ch = payload?.call_history;
  const callId = ch?.call_id || (ch?.id != null ? String(ch.id) : '');
  const audioUrl = typeof ch?.recorded_file_url === 'string' ? ch.recorded_file_url.trim() : '';

  if (!callId) { console.warn('UTel call_saved: call_id yo\'q — o\'tkazib yuborildi.'); return; }
  if (!audioUrl) { console.warn(`UTel call_saved: recorded_file_url yo\'q (call_id=${callId}).`); return; }

  const companyId = companyIdForDomain(payload?.domain);
  if (!companyId) {
    console.warn(`UTel call_saved: "${payload?.domain}" domeni uchun kompaniya topilmadi (call_id=${callId}).`);
    return;
  }

  // Dedup: shu call_id allaqachon yozilgan bo'lsa — takrorlamaymiz (UTel
  // hodisani qayta yuborishi mumkin).
  const { data: existing } = await supabase.from('calls').select('id').eq('crm_id', callId).limit(1).maybeSingle();
  if (existing?.id) { console.log(`UTel call_saved: ${callId} allaqachon mavjud — o'tkazib yuborildi.`); return; }

  // Operator (ichki raqam src) JAMALS ichida topiladi/yaratiladi.
  const src = ch?.src != null ? String(ch.src).trim() : '';
  let managerId: string | null = null;
  if (src) {
    try {
      const m = await getOrCreateManagerByPbxId(supabase, src, companyId);
      managerId = m.id;
    } catch (e: any) {
      console.error(`UTel call_saved: operator (${src}) yaratib bo'lmadi:`, e?.message);
    }
  }

  const typeName = String(ch?.type?.name || '').toLowerCase();
  const direction = typeName.includes('out') ? 'outgoing' : typeName.includes('in') ? 'incoming' : 'unknown';

  // Qo'ng'iroq qatorini DARHOL yozamiz (status=processing) — audio dashboard'da
  // ko'rinadi/eshitiladi; matn+tahlil sales-ai-front'dan kelgach yangilanadi.
  const { data: call, error: insErr } = await supabase
    .from('calls')
    .insert({
      company_id: companyId,
      manager_id: managerId,
      audio_url: audioUrl,
      audio_source_url: audioUrl,
      crm_id: callId,
      pbx_call_id: callId,
      direction,
      client_phone: ch?.external_number != null ? String(ch.external_number) : null,
      duration: typeof ch?.duration === 'number' ? ch.duration : null,
      status: 'processing',
    })
    .select('id')
    .single();
  if (insErr || !call) {
    console.error(`UTel call_saved: calls insert xatosi (call_id=${callId}):`, insErr?.message);
    return;
  }

  // sales-ai-front (Whisper) bilan tahlil — Aisha/Gemini o'rniga (foydalanuvchi
  // tanlovi). Sozlanmagan bo'lsa qo'ng'iroq 'processing' qolaveradi (audio bor).
  if (!isSalesAiConfigured()) {
    console.warn('SALES_AI_API_KEY sozlanmagan — audio saqlandi, tahlil o\'tkazilmadi.');
    return;
  }
  try {
    const clientName = ch?.external_number != null ? String(ch.external_number) : undefined;
    const jobId = await submitAudioForAnalysis(audioUrl, clientName);
    const res = await waitForAnalysis(jobId);

    if (res.status !== 'done' || !res.fullText) {
      // Matn chiqmadi (masalan javobsiz qo'ng'iroq) — transkript/dialogni
      // saqlaymiz, tahlilsiz done qilamiz (Gemini uchun matn yo'q).
      await supabase.from('calls').update({
        transcript: res.fullText || null,
        transcript_segments: Array.isArray(res.dialog) ? res.dialog : [],
        status: 'done',
        error: null,
      }).eq('id', call.id);
      console.log(`UTel call_saved -> sales-ai: matn bo'sh (call_id=${callId}, status=${res.status})`);
    } else {
      // Matn bor — sales-ai transkriptini (va dialog segmentlarini) Gemini
      // bilan tahlil qilib, calls qatorini to'liq to'ldiramiz (KPI, izoh,
      // sentiment, mezonlar...). Foydalanuvchi arxitekturasi: matn sales-ai,
      // tahlil Gemini.
      await processTranscriptToCall(supabase, call.id, res.fullText, res.dialog, companyId);
      console.log(`UTel call_saved -> sales-ai+Gemini done (call_id=${callId}, so'z: ${res.wordsCount})`);
    }
  } catch (e: any) {
    console.error(`UTel call_saved sales-ai xatosi (call_id=${callId}):`, e?.message || e);
    await supabase.from('calls').update({ status: 'failed', error: String(e?.message || e).slice(0, 500) }).eq('id', call.id).then(undefined, () => {});
  }
}

function buildEntry(req: Request) {
  const rawBody = (req as any).rawBody instanceof Buffer
    ? (req as any).rawBody.toString('utf8')
    : undefined;
  return {
    receivedAt: new Date().toISOString(),
    ip: req.ip,
    method: req.method,
    url: req.originalUrl,
    contentType: req.headers['content-type'] ?? null,
    headers: req.headers,
    query: req.query,
    body: req.body,        // parsed (JSON bo'lsa)
    rawBody,               // xom matn (parse muvaffaqiyatsiz bo'lsa ham ko'rinadi)
  };
}

// POST /webhook/utel — UTel hodisalari shu yerga keladi.
router.post('/utel', async (req: Request, res: Response) => {
  // 1) DARHOL 200 OK — webhook jo'natuvchilari tez javob (ack) kutadi;
  //    kechiksa UTel qayta yuborishi yoki xato deb belgilashi mumkin.
  //    Og'ir ish (log/fayl) javobdan KEYIN bajariladi.
  res.status(200).json({ ok: true });

  // 2) To'liq so'rovni log qilamiz — hech qanday holatda tashlamaydi.
  try {
    const entry = buildEntry(req);

    // Railway loglarida ko'rinadi: `railway logs` yoki dashboard.
    console.log('════════════════ UTEL WEBHOOK ════════════════');
    console.log(JSON.stringify(entry, null, 2));
    console.log('═══════════════════════════════════════════════');

    // Faylga ham yozamiz (lokal ishlab chiqishda qulay; Railway'da efemer).
    try {
      await mkdir(LOG_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const fname = `utel-${stamp}-${Math.random().toString(36).slice(2, 8)}.json`;
      await writeFile(path.join(LOG_DIR, fname), JSON.stringify(entry, null, 2), 'utf8');
      console.log(`UTel webhook: nusxa faylga yozildi -> ${path.join(LOG_DIR, fname)}`);
    } catch (fileErr: any) {
      // Fayl yozib bo'lmasa (efemer/read-only FS) — bu KUTILGAN, faqat
      // ogohlantiramiz; asosiy log baribir konsolda.
      console.warn('UTel webhook: faylga yozib bo\'lmadi (konsol logi baribir bor):', fileErr?.message);
    }

    // "call_saved" bo'lsa — audioni JAMALS qo'ng'iroqlari sifatida ishga
    // qo'yamiz (200 ack allaqachon yuborilgan, bu fon rejimida).
    if (req.body && typeof req.body === 'object' && req.body.name === 'call_saved') {
      void handleUtelCallSaved(req.body);
    }
  } catch (e: any) {
    // Log bosqichidagi xato 200 ack'ни BUZMASIN (u allaqachon yuborilgan).
    console.error('UTel webhook log xatosi:', e?.message || e);
  }
});

// GET /webhook/utel — ba'zi panellar webhook'ni GET bilan "tirikmi" deb
// sinaydi; brauzerdan tekshirish uchun ham qulay.
router.get('/utel', (_req: Request, res: Response) => {
  res.status(200).json({
    ok: true,
    message: 'UTel webhook receiver tirik. Hodisalar POST bilan kutilmoqda (bosqich 1: kuzatish).',
  });
});

export default router;
