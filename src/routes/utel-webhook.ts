import { Router, Request, Response } from 'express';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { supabase } from '../lib/supabase';
import { processTranscriptToCall } from './analyze-call';
import { submitAudioForAnalysis, waitForAnalysis, isSalesAiConfigured } from '../lib/salesAiClient';
import { isWorkTime, workWindowLabel } from '../lib/workHours';

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

// Operator (xodim) ichki raqamini aniqlaydi. UTel call_history'da src/dst
// bo'ladi: OUTGOING'da src=operator (ichki, qisqa) / dst=mijoz (uzun),
// INCOMING'da src=mijoz (uzun) / dst=operator. Ichki raqam har doim QISQA
// (<=5 raqam), mijoz raqami uzun (9+). Shu sabab operator = src/dst dan
// qisqasi. (Avval xato: har doim src olingan -> incoming'da mijoz raqami
// "xodim" bo'lib yaratilib, soxta operatorlar paydo bo'lardi.)
function resolveOperatorExt(ch: any): string {
  const cands = [ch?.src, ch?.dst]
    .map((x) => (x == null ? '' : String(x).trim()))
    .filter(Boolean);
  const internal = cands.find((x) => x.replace(/\D/g, '').length > 0 && x.replace(/\D/g, '').length <= 5);
  return internal || '';
}

// Xodimni FAQAT qidiradi (yaratmaydi). Topilmasa null — qo'ng'iroq baribir
// saqlanadi, keyin kompaniya xodimni qo'shsa bog'lanadi.
async function findManagerByExt(companyId: string, ext: string): Promise<string | null> {
  const { data } = await supabase
    .from('managers')
    .select('id')
    .eq('company_id', companyId)
    .eq('pbx_id', ext)
    .limit(1)
    .maybeSingle();
  return data?.id ?? null;
}

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

  // Operator ichki raqami. XODIM YARATMAYMIZ (foydalanuvchi talabi
  // 2026-09-23: "xodimni yaratma — faqat operatorlarning audiosi saqlansin").
  // Ichki raqam qo'ng'iroqning o'ziga (calls.pbx_id) yoziladi; kompaniya
  // xodimni o'zi qo'shganda, o'sha raqamli qo'ng'iroqlar unga bog'lanadi
  // (routes/managers.ts -> backfill). Agar xodim ALLAQACHON qo'shilgan
  // bo'lsa — shu yerda bog'laymiz.
  const src = resolveOperatorExt(ch); // operator ichki raqami (src/dst dan qisqasi)
  const managerId = src ? await findManagerByExt(companyId, src) : null;

  const typeName = String(ch?.type?.name || '').toLowerCase();
  const direction = typeName.includes('out') ? 'outgoing' : typeName.includes('in') ? 'incoming' : 'unknown';

  // Qo'ng'iroq qatorini DARHOL yozamiz (status=processing) — audio dashboard'da
  // ko'rinadi/eshitiladi; matn+tahlil sales-ai-front'dan kelgach yangilanadi.
  //
  // DIQQAT: operator ichki raqami calls.pbx_id'ga YOZILMAYDI — o'sha ustunda
  // UNIQUE cheklov bor (uq_calls_pbx_id, ya'ni u PBX qo'ng'iroq ID'si uchun).
  // U yerga ichki raqam yozilsa, bitta operatorning IKKINCHI qo'ng'irog'i
  // "duplicate key" bilan saqlanmay qolardi. Ichki raqam alohida
  // operator_ext ustunida (supabase/add_operator_ext.sql).
  const baseRow: Record<string, unknown> = {
    company_id: companyId,
    manager_id: managerId,
    audio_url: audioUrl,
    audio_source_url: audioUrl,
    crm_id: callId,
    pbx_call_id: callId,
    direction,
    client_phone: ch?.external_number != null ? String(ch.external_number) : null,
    duration: typeof ch?.duration === 'number' ? ch.duration : null,
    // Ish vaqtida bo'lsa darhol tahlilga ketadi; tashqarisida 'queued'
    // bo'lib turadi va ertalab 09:00 da navbat oladi.
    status: isWorkTime() ? 'processing' : 'queued',
  };

  let insert = await supabase.from('calls').insert({ ...baseRow, operator_ext: src || null }).select('id').single();
  if (insert.error && /operator_ext/i.test(insert.error.message || '')) {
    // SQL hali ishga tushirilmagan (ustun yo'q) — qo'ng'iroq baribir
    // saqlansin, faqat ichki raqamsiz.
    console.warn('calls.operator_ext ustuni yo\'q — supabase/add_operator_ext.sql ishga tushirilsin.');
    insert = await supabase.from('calls').insert(baseRow).select('id').single();
  }
  const { data: call, error: insErr } = insert;
  if (insErr || !call) {
    console.error(`UTel call_saved: calls insert xatosi (call_id=${callId}):`, insErr?.message);
    return;
  }

  // ISH VAQTIDAN TASHQARIDA tahlil qilmaymiz — qo'ng'iroq (audio bilan)
  // saqlandi va 'queued' holatida turadi; ertalab 09:00 da navbat uni
  // o'zi oladi. Bekorga token sarflanmaydi, kun 19:00 da yopiq qoladi.
  if (!isWorkTime()) {
    console.log(`UTel: ish vaqtidan tashqari (${workWindowLabel()}) — ${callId} navbatga qo'yildi.`);
    return;
  }

  // Tahlil (sales-ai + GPT) fon rejimida — ISHONCHLILIK uchun: agar bu
  // ishlov uzilib qolsa (deploy/restart/timeout), qo'ng'iroq 'processing'
  // qoladi va navbat uni keyin qayta oladi. Shu sabab bu yerda
  // await qilib kutmaymiz — void.
  void analyzeUtelCall(call.id, audioUrl, companyId, ch?.external_number != null ? String(ch.external_number) : undefined);
}

// Bitta UTel qo'ng'irog'ini tahlil qiladi: audio -> sales-ai (matn) ->
// Gemini (tahlil) -> calls yangilanadi. Webhook (yangi qo'ng'iroq) va
// recoverUtelCalls (qotib qolgan/eski) ikkalasi ham shu funksiyani ishlatadi.
export async function analyzeUtelCall(
  rowId: string,
  audioUrl: string,
  companyId: string | null,
  clientName?: string,
): Promise<void> {
  if (!isSalesAiConfigured()) {
    console.warn('SALES_AI_API_KEY sozlanmagan — tahlil o\'tkazilmadi.');
    return;
  }
  try {
    const jobId = await submitAudioForAnalysis(audioUrl, clientName);
    const res = await waitForAnalysis(jobId);

    if (res.status !== 'done' || !res.fullText) {
      // Matn yo'q (javobsiz/bo'sh) — dialogni saqlab, tahlilsiz done.
      await supabase.from('calls').update({
        transcript: res.fullText || null,
        transcript_segments: Array.isArray(res.dialog) ? res.dialog : [],
        status: 'done',
        error: null,
      }).eq('id', rowId);
      console.log(`UTel analiz: matn bo'sh (row=${rowId}, status=${res.status})`);
      return;
    }

    // MATNNI DARHOL SAQLAYMIZ. Avval matn faqat Gemini tahlili
    // muvaffaqiyatli tugagandan keyin yozilardi — Gemini 429 (daqiqalik
    // limit) bersa, STT natijasi yo'qolar va navbat audioni qaytadan
    // yuklab, qaytadan matnga o'girardi (400+ qo'ng'iroq shu aylanada
    // qotib qolgan). Endi matn saqlanadi: qayta urinish FAQAT tahlilni
    // takrorlaydi — bir necha soniya, audiosiz.
    await supabase.from('calls').update({
      transcript: res.fullText,
      transcript_segments: Array.isArray(res.dialog) ? res.dialog : [],
      duration: res.durationSec ?? undefined,
    }).eq('id', rowId);

    await processTranscriptToCall(supabase, rowId, res.fullText, res.dialog, companyId);
    console.log(`UTel analiz done (row=${rowId}, so'z: ${res.wordsCount})`);
  } catch (e: any) {
    console.error(`UTel analiz xatosi (row=${rowId}):`, e?.message || e);
    await supabase.from('calls').update({ status: 'failed', error: String(e?.message || e).slice(0, 500) }).eq('id', rowId).then(undefined, () => {});
  }
}

// Matni ALLAQACHON bor qo'ng'iroq: faqat Gemini tahlilini qayta bajaramiz
// (audio yuklanmaydi, STT takrorlanmaydi — bir necha soniya).
async function reanalyzeTranscriptOnly(row: {
  id: string;
  transcript: string;
  transcript_segments: unknown;
  company_id: string | null;
}): Promise<void> {
  try {
    await processTranscriptToCall(
      supabase,
      row.id,
      row.transcript,
      Array.isArray(row.transcript_segments) ? row.transcript_segments : [],
      row.company_id,
    );
  } catch (e: any) {
    console.error(`UTel qayta tahlil xatosi (row=${row.id}):`, e?.message || e);
    await supabase.from('calls').update({ status: 'failed', error: String(e?.message || e).slice(0, 500) }).eq('id', row.id).then(undefined, () => {});
  }
}

// Qotib qolgan / eski qo'ng'iroqlarni qayta tahlil qiladi (ISHONCHLILIK +
// eski failed'larni tuzatish). Har N soniyada server.ts chaqiradi.
// Shartlar: UTel audiosi (api.utc381.utel.uz) bor, transkript hali yo'q,
// status done EMAS (processing/failed), 1 daqiqadan eski (yangi kelayotgani
// bilan poyga qilmaslik uchun). Bir vaqtda cheklangan (parallel) ishlaymiz.
// Bir siklda nechta qo'ng'iroq parallel ishlanadi.
const BATCH = Math.max(1, Number(process.env.UTEL_BATCH || 8));

// NAVBAT FAQAT SHU VAQTDAN KEYINGI QO'NG'IROQLARNI OLADI.
// Foydalanuvchi talabi (2026-09-23): eski to'plangan ~590 ta audio qayta
// ishlanmasin — "bekorga token sarflama", tahlil SHUNDAN KEYIN kelgan
// qo'ng'iroqlardan boshlansin. UTEL_QUEUE_SINCE (ISO sana) Railway
// o'zgaruvchisi shu chegarani belgilaydi; berilmasa — server ishga tushgan
// vaqt (ya'ni eski hech narsa olinmaydi).
//
// DIQQAT: bu navbat (qayta tiklash) uchun. Webhook orqali ENDI kelayotgan
// qo'ng'iroq baribir darhol tahlil qilinadi — u navbatdan o'tmaydi.
const QUEUE_SINCE = (() => {
  const raw = process.env.UTEL_QUEUE_SINCE;
  const t = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : new Date().toISOString();
})();

// Yiqilgan qo'ng'iroqni DARHOL qayta urinmaymiz. Aks holda navbat eng eski
// bir nechta qatorga yopishib qolardi: ular yiqilardi, keyingi siklda yana
// o'shalar tanlanardi (tartib created_at bo'yicha) va YANGI audiolarga
// navbat umuman kelmasdi — production'da aynan shunday bo'ldi (55 ta matn
// qayta-qayta urinilib, Gemini kvotasini yeb turdi). Endi har urinishdan
// keyin qator vaqtincha chetga qo'yiladi (5 daqiqa, har safar ikki barobar,
// ko'pi bilan 1 soat).
const retryAfter = new Map<string, { at: number; delayMs: number }>();
const BASE_BACKOFF_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;

function isCoolingDown(id: string): boolean {
  const r = retryAfter.get(id);
  return !!r && Date.now() < r.at;
}

function markAttempted(id: string): void {
  const prev = retryAfter.get(id);
  const delayMs = prev ? Math.min(prev.delayMs * 2, MAX_BACKOFF_MS) : BASE_BACKOFF_MS;
  retryAfter.set(id, { at: Date.now() + delayMs, delayMs });
}

function markSucceeded(id: string): void {
  retryAfter.delete(id);
}

// Navbatdan bitta to'plam olib ishlaydi. Qaytaradi: nechta ishlandi (0 =
// navbat bo'sh). AVVAL matni bor qo'ng'iroqlar (ular tayyorga yaqin — faqat
// tahlil kerak, bir necha soniya), KEYIN matnsizlari (to'liq STT).
async function runQueueOnce(): Promise<number> {
  const cutoff = new Date(Date.now() - 45_000).toISOString();

  // 1) Matni bor, lekin tahlili tugamagan — eng tez yutuq.
  // ilike '%utel%' — FAQAT UTel qo'ng'iroqlari. Aks holda eski (boshqa
  // manbadagi) o'n minglab qo'ng'iroq ham shu navbatga tushib, Gemini
  // kvotasini bekorga yeb qo'yardi.
  const { data: pending } = await supabase
    .from('calls')
    .select('id, transcript, transcript_segments, company_id')
    .not('transcript', 'is', null)
    .neq('status', 'done')
    .ilike('audio_url', '%utel%')
    .gte('created_at', QUEUE_SINCE)
    .lt('created_at', cutoff)
    .order('created_at', { ascending: true })
    .limit(BATCH * 5);
  const needAnalysis = (pending || [])
    .filter((r) => typeof r.transcript === 'string' && r.transcript.trim() !== '')
    .filter((r) => !isCoolingDown(r.id))
    .slice(0, BATCH);
  if (needAnalysis.length > 0) {
    console.log(`UTel navbat: ${needAnalysis.length} ta matn tahlilga (audiosiz).`);
    await Promise.allSettled(needAnalysis.map(async (r) => {
      markAttempted(r.id);
      await supabase.from('calls').update({ status: 'processing' }).eq('id', r.id);
      await reanalyzeTranscriptOnly(r as any);
    }));
  }

  // 2) Matnsizlar — to'liq quvur (audio -> matn -> tahlil).
  //    AUDIO_TOO_LARGE bo'lganlar tashlab ketiladi: qayta urinish befoyda
  //    va navbatni bloklaydi.
  const { data, error } = await supabase
    .from('calls')
    .select('id, audio_url, company_id, client_phone, error')
    .ilike('audio_url', '%utel%')
    .is('transcript', null)
    .neq('status', 'done')
    .gte('created_at', QUEUE_SINCE)
    .lt('created_at', cutoff)
    .order('created_at', { ascending: true })
    .limit(BATCH * 5);
  if (error) { console.warn('UTel navbat so\'rovi xatosi:', error.message); return needAnalysis.length; }
  const rows = (data || [])
    .filter((r) => typeof r.audio_url === 'string' && r.audio_url.includes('utel'))
    .filter((r) => !String(r.error || '').includes('AUDIO_TOO_LARGE'))
    .filter((r) => !isCoolingDown(r.id))
    .slice(0, BATCH);
  if (rows.length === 0) return needAnalysis.length;

  console.log(`UTel navbat: ${rows.length} ta audio tahlilga.`);
  await Promise.allSettled(rows.map(async (r) => {
    markAttempted(r.id);
    await supabase.from('calls').update({ status: 'processing' }).eq('id', r.id);
    await analyzeUtelCall(r.id, r.audio_url as string, r.company_id ?? null, r.client_phone ?? undefined);
  }));
  return needAnalysis.length + rows.length;
}

// TO'XTOVSIZ ISHCHI (foydalanuvchi talabi 2026-09-23: "hammasini ketma-ket
// audio tahlil qib srazu chiqarib ketsin"). Avval har 45 soniyada 4 tadan
// olardi — orada server bekor turar, 400 ta navbat soatlab cho'zilardi.
// Endi: to'plam tugashi bilan DARHOL keyingisi olinadi; navbat bo'shasa
// 8 soniya kutib yana qaraydi. Tezlikni ikki narsa cheklaydi: BATCH
// (parallel) va Gemini daqiqalik darvozasi (geminiLimiter).
let workerStarted = false;
export function startUtelWorker(): void {
  if (workerStarted) return;
  workerStarted = true;

  void (async function loop() {
    for (;;) {
      try {
        if (!isSalesAiConfigured()) {
          await new Promise((r) => setTimeout(r, 30_000));
          continue;
        }
        // Ish vaqtidan tashqarida navbat TO'XTAYDI (19:00 dan keyin kun
        // yopiq). Har 5 daqiqada qaytib tekshiradi — 09:00 bo'lishi bilan
        // tunda to'plangan qo'ng'iroqlarni o'zi oladi.
        if (!isWorkTime()) {
          await new Promise((r) => setTimeout(r, 5 * 60_000));
          continue;
        }
        const processed = await runQueueOnce();
        // Ish bo'lsa — darhol keyingisiga; bo'lmasa qisqa tanaffus.
        if (processed === 0) await new Promise((r) => setTimeout(r, 8_000));
      } catch (e: any) {
        console.error('UTel navbat ishchisi xatosi:', e?.message || e);
        await new Promise((r) => setTimeout(r, 10_000));
      }
    }
  })();
  console.log(`UTel navbat ishchisi ishga tushdi (bir vaqtda ${BATCH} ta).`);
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
