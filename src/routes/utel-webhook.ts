import { Router, Request, Response } from 'express';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { supabase } from '../lib/supabase';
import { processTranscriptToCall } from './analyze-call';
import { submitAudioForAnalysis, waitForAnalysis, waitBudgetMs, isSalesAiConfigured } from '../lib/salesAiClient';
import {
  recordOutcome, isPaused as isSttPaused, shouldProbe, markProbed,
  maybeAlertAdmin, countsTowardHealth, SUSPECT_STATUS,
} from '../lib/sttHealth';
import { isWorkTime, workWindowLabel } from '../lib/workHours';
import { probeWavDurationSec } from '../lib/audioDuration';
import { classifyShortCall } from '../lib/openaiAnalyzer';

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
// MIJOZ raqamini aniqlaydi: src/dst dan UZUNI (operator ichki raqami qisqa).
//
// DIQQAT (2026-09-23): avval client_phone sifatida ch.external_number
// olinardi — u MIJOZNIKI EMAS, kompaniyaning o'z shahar raqami. Natijada
// 696 qo'ng'iroqdan 695 tasida bir xil raqam (555889939) turib qolgan edi.
function resolveClientNumber(ch: any): string | null {
  const cands = [ch?.src, ch?.dst]
    .map((x) => (x == null ? '' : String(x).trim()))
    .filter(Boolean);
  const external = cands.find((x) => x.replace(/\D/g, '').length > 5);
  if (external) return external;
  return ch?.external_number != null ? String(ch.external_number) : null;
}

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

  const rawDur = Number(ch?.duration);
  const durationSec = Number.isFinite(rawDur) && rawDur > 0
    ? Math.round(rawDur)
    : (await probeWavDurationSec(audioUrl)) ?? 0;

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
    client_phone: resolveClientNumber(ch),
    // UTel ko'pincha duration=0 yuboradi — bunda davomiylikni audio
    // faylning o'zidan (WAV sarlavhasi + hajm) o'lchaymiz.
    duration: durationSec,
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
  void analyzeUtelCall(call.id, audioUrl, companyId, resolveClientNumber(ch) ?? undefined);
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
  // Operatorning kunlik tahlil limiti to'lgan bo'lsa — to'xtaymiz.
  if (!(await passesDailyLimit(rowId))) return;
  try {
    // Qo'ng'iroq davomiyligini oldindan olamiz: kutish budjeti shunga qarab
    // belgilanadi va pastdagi "ishonchlilik tekshiruvi" uchun ham kerak.
    const { data: durRow } = await supabase.from('calls').select('duration').eq('id', rowId).maybeSingle();
    const durSec = Math.max(0, Number(durRow?.duration) || 0);

    const jobId = await submitAudioForAnalysis(audioUrl, clientName);
    const res = await waitForAnalysis(jobId, { timeoutMs: waitBudgetMs(durSec) });

    // HAR BIR QO'NG'IROQDA YO BALL, YO SABAB BO'LSIN (foydalanuvchi talabi
    // 2026-09-24). Suhbat bo'lmagan yoki juda qisqa qo'ng'iroqda sotuv
    // skriptini baholash ma'nosiz — ball 0 bo'lib qolar va "tahlil
    // qilinmagan"dek ko'rinardi. Endi bunday qo'ng'iroq ham TAHLIL
    // qilinadi: sababi aniqlanadi ("Aloqa sifati yomon", "Javobsiz",
    // "Noto'g'ri raqam" ...) va izohga yoziladi.
    const text = res.fullText || '';
    const trimmed = text.trim();
    const SHORT_LIMIT = 250; // belgidan qisqa = to'liq suhbat emas

    // ============================================================
    // CIRCUIT BREAKER (2026-09-27)
    //
    // Bo'sh matnni bitta qo'ng'iroq darajasida haqiqiy javobsizdan
    // ajratib bo'lmaydi. Shuning uchun GLOBAL o'lchov: oxirgi N ta
    // yetarlicha uzun qo'ng'iroqning ko'pchiligi bo'sh chiqsa —
    // xizmat nosoz, navbat pauza qilinadi.
    //
    // Pauza paytida qo'ng'iroq "Javobsiz" deb YOZILMAYDI: u
    // 'stt_suspect' holatida qoladi. Bu holat 'done' emas, demak
    // xizmat tiklangach navbat uni o'zi qayta oladi.
    // ============================================================
    const isEmpty = trimmed.length < 50;
    const justTripped = recordOutcome(isEmpty, durSec);
    if (isEmpty && (justTripped || isSttPaused())) {
      await supabase.from('calls').update({
        status: SUSPECT_STATUS,
        error: 'STT bo\'sh matn qaytardi — xizmat nosoz deb belgilandi, keyin qayta urinamiz.',
      }).eq('id', rowId);
      console.warn(`UTel: row=${rowId} 'stt_suspect' holatida qoldirildi (xizmat pauzada).`);
      return;
    }

    // ============================================================
    // STT TUGAMAGAN BO'LSA — BU "SUHBAT BO'LMAGAN" DEGANI EMAS.
    //
    // XATO (2026-09-24 19:01 — 2026-09-27, 2842 qo'ng'iroq yo'qoldi):
    // shart `res.status !== 'done' || qisqa` edi. Ya'ni STT timeout
    // bo'lsa ham (bo'sh matn), qo'ng'iroq darhol "Javobsiz" /
    // "Aloqa sifati yomon" deb belgilanar va status='done' yozilar edi.
    // Navbat esa `.neq('status','done')` bilan tanlaydi — demak bunday
    // qator BOSHQA HECH QACHON qayta urinilmasdi. Natijada 906 soniyalik
    // (15 daqiqalik) haqiqiy sotuv suhbati "Aloqa sifati yomon" bo'lib
    // qolgan.
    //
    // Endi: STT tugamagan bo'lsa XATO tashlanadi -> catch status='failed'
    // qiladi (dropped_reason YOZILMAYDI) -> navbat qayta uradi.
    //
    // Ikkinchi himoya: uzun audiodan bo'm-bo'sh matn kelishi ham STT
    // nosozligi, "javobsiz" emas — 60 soniyadan uzun qo'ng'iroqda
    // amalda gap bo'lmasligi mumkin emas.
    // ============================================================
    const emptyFromLongAudio = durSec >= 60 && isEmpty;
    if (res.status !== 'done' || emptyFromLongAudio) {
      throw new Error(
        `STT natija bermadi (status=${res.status}, audio ${durSec}s, matn ${trimmed.length} belgi) — qayta urinamiz.`,
      );
    }

    if (trimmed.length < SHORT_LIMIT) {
      const dur = durSec;
      const { category, note } = await classifyShortCall(text, dur);
      await supabase.from('calls').update({
        transcript: text || null,
        transcript_segments: Array.isArray(res.dialog) ? res.dialog : [],
        rop_comment: `(Baholanmadi) ${category}. ${note}`,
        dropped_reason: category,
        summary: note,
        status: 'done',
        error: null,
      }).eq('id', rowId);
      console.log(`UTel analiz: qisqa/suhbatsiz — ${category} (row=${rowId}, ${text.length} belgi)`);
      return;
    }

    // MATNNI DARHOL SAQLAYMIZ. Avval matn faqat Gemini tahlili
    // muvaffaqiyatli tugagandan keyin yozilardi — Gemini 429 (daqiqalik
    // limit) bersa, STT natijasi yo'qolar va navbat audioni qaytadan
    // yuklab, qaytadan matnga o'girardi (400+ qo'ng'iroq shu aylanada
    // qotib qolgan). Endi matn saqlanadi: qayta urinish FAQAT tahlilni
    // takrorlaydi — bir necha soniya, audiosiz.
    const upd: Record<string, unknown> = {
      transcript: text,
      transcript_segments: Array.isArray(res.dialog) ? res.dialog : [],
    };
    // STT xizmati davomiylikni bilsa — shuni yozamiz (UTel 0 yuborgan bo'lishi mumkin).
    if (Number(res.durationSec) > 0) upd.duration = Math.round(Number(res.durationSec));
    await supabase.from('calls').update(upd).eq('id', rowId);

    await processTranscriptToCall(supabase, rowId, text, res.dialog, companyId);
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
  if (!(await passesDailyLimit(row.id))) return;
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
// ============================================================================
// OPERATOR KUNLIK TAHLIL LIMITI (foydalanuvchi talabi 2026-09-25)
//
// Har bir operatorga kuniga CHEKLANGAN hajmda audio tahlil qilinadi
// (standart 1 soat). Limit to'lgach, o'sha operatorning keyingi
// qo'ng'iroqlari SAQLANADI (audio yo'qolmaydi, eshitib bo'ladi), lekin
// matnga o'girilmaydi va baholanmaydi — "Kunlik limitdan oshdi" deb
// belgilanadi va "Audio yozuvlar" bo'limida shunday ko'rinadi.
//
// Limitga FAQAT tahlil qilingan audio hisoblanadi: limit tufayli
// o'tkazib yuborilganlar hisobni oshirmaydi.
//
// Sozlash: OPERATOR_DAILY_AUDIO_LIMIT_SEC (soniyada, 0 = limitsiz).
// ============================================================================
const OPERATOR_DAILY_LIMIT_SEC = Math.max(0, Number(process.env.OPERATOR_DAILY_AUDIO_LIMIT_SEC ?? 3600));
export const LIMIT_REASON = 'Kunlik limitdan oshdi';

function tashkentDayBounds(atIso: string): { from: string; to: string } {
  const key = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tashkent', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(atIso));
  return {
    from: new Date(`${key}T00:00:00+05:00`).toISOString(),
    to: new Date(`${key}T23:59:59.999+05:00`).toISOString(),
  };
}

// Operatorning o'sha kuni TAHLIL QILINGAN audiosi (soniyada).
async function analyzedSecondsToday(companyId: string, ext: string, atIso: string): Promise<number> {
  const { from, to } = tashkentDayBounds(atIso);
  const { data } = await supabase
    .from('calls')
    .select('duration, dropped_reason, transcript, kpi_score, status')
    .eq('company_id', companyId)
    .eq('operator_ext', ext)
    .gte('created_at', from)
    .lte('created_at', to)
    .limit(2000);
  return (data || [])
    // Limit tufayli o'tkazib yuborilganlar hisobga kirmaydi.
    .filter((r: any) => r.dropped_reason !== LIMIT_REASON)
    // Qayta navbatdagi eski qo'ng'iroqlar ham byudjetni yemaydi.
    .filter((r: any) => r.status !== REQUEUED_STATUS)
    // Faqat haqiqatan ishlov berilganlar (matn olingan yoki baholangan).
    .filter((r: any) => r.transcript || Number(r.kpi_score) > 0 || r.dropped_reason)
    .reduce((s: number, r: any) => s + Math.max(0, Number(r.duration) || 0), 0);
}

// QAYTA NAVBATGA QO'YILGAN (eski) QO'NG'IROQ BELGISI (2026-09-27).
//
// 24-sentabrdagi STT uzilishi tufayli tahlilsiz qolgan qo'ng'iroqlar
// qo'lda qayta navbatga qo'yiladi. Ular status='requeued' bilan
// belgilanadi va shu belgi ikki narsani beradi:
//   1) KUNLIK LIMITGA KIRMAYDI — aks holda o'sha kunning byudjeti
//      allaqachon sarflangani uchun hammasi darhol "Kunlik limitdan
//      oshdi" bo'lib qaytardi. Global limit (3600) jonli qo'ng'iroqlar
//      uchun o'zgarishsiz qoladi.
//   2) PAST USTUVORLIK — navbat avval jonli qo'ng'iroqlarni oladi
//      (runQueueOnce'ga qarang).
// Yangi DB ustuni kerak emas: navbat `.neq('status','done')` bilan
// tanlagani uchun 'requeued' ham o'z-o'zidan olinadi.
export const REQUEUED_STATUS = 'requeued';

// Qo'ng'iroqni tahlil qilsa bo'ladimi? Bo'lmasa — belgilab, false qaytaradi.
async function passesDailyLimit(rowId: string): Promise<boolean> {
  if (!OPERATOR_DAILY_LIMIT_SEC) return true;
  const { data: row } = await supabase
    .from('calls')
    .select('company_id, operator_ext, duration, created_at, status')
    .eq('id', rowId)
    .maybeSingle();
  // Qayta navbatdagi eski qo'ng'iroq — kunlik limit qo'llanmaydi.
  if (row?.status === REQUEUED_STATUS) return true;
  const ext = String(row?.operator_ext || '').trim();
  if (!row?.company_id || !ext) return true; // operator noma'lum — limit qo'llanmaydi

  const used = await analyzedSecondsToday(row.company_id, ext, row.created_at);
  if (used < OPERATOR_DAILY_LIMIT_SEC) return true;

  const limitMin = Math.round(OPERATOR_DAILY_LIMIT_SEC / 60);
  await supabase.from('calls').update({
    status: 'done',
    error: null,
    dropped_reason: LIMIT_REASON,
    summary: `Operator ${ext} uchun kunlik tahlil limiti (${limitMin} daqiqa) to'lgan.`,
    rop_comment: `(Baholanmadi) ${LIMIT_REASON}. Operator ${ext} bugun ${Math.round(used / 60)} daqiqa audio tahlil qilingan — kunlik limit ${limitMin} daqiqa. Audio saqlangan, eshitish mumkin.`,
  }).eq('id', rowId);
  console.log(`UTel: operator ${ext} kunlik limitdan oshdi (${Math.round(used / 60)}/${limitMin} daq) — row=${rowId} tahlil qilinmadi.`);
  return false;
}

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
const retryAfter = new Map<string, { at: number; delayMs: number; tries: number }>();
const BASE_BACKOFF_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;

// Bir qator ko'pi bilan shuncha marta urinib ko'riladi. NEGA CHEGARA KERAK
// (2026-09-27): STT tugamasa endi xato tashlanadi va qator navbatda qoladi —
// bu to'g'ri, lekin chegarasiz bo'lsa buzuq audio har soatda qaytadan
// yuklanib, qaytadan STT'ga berilardi (pul va token bekorga ketardi).
// Chegaradan oshgach qator aniq sabab bilan yopiladi va "Tahlil holati"
// bo'limida ko'rinadi.
const MAX_TRIES = 4;
const STT_FAILED_REASON = 'Matnga o\'girilmadi';

function isCoolingDown(id: string): boolean {
  const r = retryAfter.get(id);
  return !!r && Date.now() < r.at;
}

// Hozir kutish rejimida turgan id'lar. Bular SO'ROVNING O'ZIDA chiqarib
// tashlanadi — avval so'rov eng eski 40 qatorni olar va ular kutishda
// bo'lsa, filtrdan keyin 0 qator qolib, ORQADAGI qo'ng'iroqlarga umuman
// navbat kelmasdi (navbat "to'xtab qolgandek" ko'rinardi).
function coolingIds(): string[] {
  const now = Date.now();
  const out: string[] = [];
  for (const [id, r] of retryAfter) {
    if (now < r.at) out.push(id);
    else retryAfter.delete(id); // muddati o'tganini tozalab boramiz
  }
  return out;
}

// PostgREST uchun: .not('id', 'in', '(a,b,c)'). Ro'yxat juda uzun bo'lsa
// so'rov URL'i haddan oshmasin uchun cheklaymiz.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function excludeCooling(q: any): any {
  const ids = coolingIds().slice(0, 200);
  return ids.length ? q.not('id', 'in', `(${ids.join(',')})`) : q;
}

// Qaytaradi: bu qator uchun nechanchi urinish bo'lgani.
function markAttempted(id: string): number {
  const prev = retryAfter.get(id);
  const delayMs = prev ? Math.min(prev.delayMs * 2, MAX_BACKOFF_MS) : BASE_BACKOFF_MS;
  const tries = (prev?.tries ?? 0) + 1;
  retryAfter.set(id, { at: Date.now() + delayMs, delayMs, tries });
  return tries;
}

function triesOf(id: string): number {
  return retryAfter.get(id)?.tries ?? 0;
}

// Urinishlar tugadi — qatorni aniq sabab bilan yopamiz (navbat qayta olmaydi).
async function giveUp(id: string, lastError: string): Promise<void> {
  await supabase.from('calls').update({
    status: 'done',
    dropped_reason: STT_FAILED_REASON,
    summary: 'Audio matnga o\'girilmadi.',
    rop_comment: `(Baholanmadi) ${STT_FAILED_REASON}. ${MAX_TRIES} marta urinildi. Oxirgi xato: ${lastError.slice(0, 200)}`,
  }).eq('id', id).then(undefined, () => {});
  console.warn(`UTel: row=${id} ${MAX_TRIES} urinishdan keyin yopildi — ${lastError.slice(0, 120)}`);
}

function markSucceeded(id: string): void {
  retryAfter.delete(id);
}

// ============================================================================
// AYNI VAQTDA ISHLANAYOTGAN QATORLAR (2026-09-27)
//
// NEGA: STT endi bitta uzun audio uchun 18 daqiqagacha ketadi (o'lchandi),
// backoff esa 5 daqiqa. Ya'ni 5-daqiqada qator navbatda yana "bo'sh"
// ko'rinar (status='processing', 'done' emas) va AYNI audio ikkinchi marta
// yuborilardi — ikki barobar STT xarajati va ikki barobar token.
//
// Shu sabab jarayonda turgan id'lar shu to'plamda saqlanadi va navbat
// ularni olmaydi. To'plam faqat xotirada: server qayta ishga tushsa
// bo'shaydi, bu xavfsiz — o'sha qator baribir qaytib navbatga tushadi.
// ============================================================================
const inFlight = new Set<string>();


// Navbatdan bitta to'plam olib ishlaydi. Qaytaradi: nechta ishlandi (0 =
// navbat bo'sh). AVVAL matni bor qo'ng'iroqlar (ular tayyorga yaqin — faqat
// tahlil kerak, bir necha soniya), KEYIN matnsizlari (to'liq STT).
async function runQueueOnce(): Promise<number> {
  const cutoff = new Date(Date.now() - 45_000).toISOString();

  // 1) Matni bor, lekin tahlili tugamagan — eng tez yutuq.
  // ilike '%utel%' — FAQAT UTel qo'ng'iroqlari. Aks holda eski (boshqa
  // manbadagi) o'n minglab qo'ng'iroq ham shu navbatga tushib, Gemini
  // kvotasini bekorga yeb qo'yardi.
  const { data: pending } = await excludeCooling(supabase
    .from('calls')
    .select('id, transcript, transcript_segments, company_id')
    .not('transcript', 'is', null)
    .neq('status', 'done')
    .ilike('audio_url', '%utel%')
    .gte('created_at', QUEUE_SINCE)
    .lt('created_at', cutoff))
    .order('created_at', { ascending: true })
    .limit(BATCH * 5);
  const needAnalysis = ((pending || []) as any[])
    .filter((r: any) => typeof r.transcript === 'string' && r.transcript.trim() !== '')
    .filter((r: any) => !isCoolingDown(r.id) && !inFlight.has(r.id))
    .slice(0, BATCH);
  if (needAnalysis.length > 0) {
    console.log(`UTel navbat: ${needAnalysis.length} ta matn tahlilga (audiosiz).`);
    await Promise.allSettled(needAnalysis.map(async (r: any) => {
      markAttempted(r.id);
      inFlight.add(r.id);
      try {
        await supabase.from('calls').update({ status: 'processing' }).eq('id', r.id);
        await reanalyzeTranscriptOnly(r as any);
      } finally {
        inFlight.delete(r.id);
      }
    }));
  }

  // 2) Matnsizlar — to'liq quvur (audio -> matn -> tahlil).
  //    AUDIO_TOO_LARGE bo'lganlar tashlab ketiladi: qayta urinish befoyda
  //    va navbatni bloklaydi.
  //
  //    USTUVORLIK (2026-09-27): avval JONLI qo'ng'iroqlar, keyin bo'sh
  //    joy qolsa — qayta navbatga qo'yilgan eskilari. Aks holda tartib
  //    created_at bo'yicha bo'lgani uchun 2000 ta eski qo'ng'iroq butun
  //    to'plamni egallab, ertalab kelayotgan jonli qo'ng'iroq soatlab
  //    navbat kutardi.
  const selectQueue = async (requeued: boolean, limit: number) => {
    let q = excludeCooling(supabase
      .from('calls')
      .select('id, audio_url, company_id, client_phone, error')
      .ilike('audio_url', '%utel%')
      .is('transcript', null)
      .neq('status', 'done')
      .gte('created_at', QUEUE_SINCE)
      .lt('created_at', cutoff));
    q = requeued ? q.eq('status', REQUEUED_STATUS) : q.neq('status', REQUEUED_STATUS);
    const { data, error } = await q.order('created_at', { ascending: true }).limit(limit * 5);
    if (error) { console.warn('UTel navbat so\'rovi xatosi:', error.message); return null; }
    return ((data || []) as any[])
      .filter((r: any) => typeof r.audio_url === 'string' && r.audio_url.includes('utel'))
      .filter((r: any) => !String(r.error || '').includes('AUDIO_TOO_LARGE'))
      .filter((r: any) => !isCoolingDown(r.id) && !inFlight.has(r.id))
      .slice(0, limit);
  };

  const live = await selectQueue(false, BATCH);
  if (live === null) return needAnalysis.length;
  let rows = live;
  // Jonli qo'ng'iroqlar to'plamni to'ldirmasa — qolgan joyga eskilarini olamiz.
  if (rows.length < BATCH) {
    const old = await selectQueue(true, BATCH - rows.length);
    if (old?.length) {
      rows = [...rows, ...old];
      console.log(`UTel navbat: ${live.length} jonli + ${old.length} qayta navbatdagi.`);
    }
  }
  if (rows.length === 0) return needAnalysis.length;

  console.log(`UTel navbat: ${rows.length} ta audio tahlilga.`);
  await Promise.allSettled(rows.map(async (r: any) => {
    if (triesOf(r.id) >= MAX_TRIES) {
      await giveUp(r.id, String(r.error || 'STT natija bermadi'));
      return;
    }
    markAttempted(r.id);
    inFlight.add(r.id);
    try {
      await supabase.from('calls').update({ status: 'processing' }).eq('id', r.id);
      await analyzeUtelCall(r.id, r.audio_url as string, r.company_id ?? null, r.client_phone ?? undefined);
    } finally {
      inFlight.delete(r.id);
    }
  }));
  return needAnalysis.length + rows.length;
}

// ============================================================================
// PAUZA REJIMI YORDAMCHILARI (2026-09-27)
//
// Circuit breaker yoqilganda navbat odatdagi to'plamni OLMAYDI — aks holda
// nosoz xizmatga minglab so'rov yuborilardi. Buning o'rniga har
// STT_PROBE_INTERVAL_MS da BITTA kutayotgan qo'ng'iroq sinab ko'riladi.
// Matn kelsa recordOutcome() pauzani o'zi ochadi.
//
// Alohida sinov audiosi saqlanmaydi: sinov sifatida haqiqiy kutayotgan
// qo'ng'iroq ishlatiladi — muvaffaqiyatli bo'lsa u ham tahlil qilinadi.
// ============================================================================

/** Tahlil kutayotgan (matnsiz, 'done' emas) qo'ng'iroqlar soni. */
async function countWaiting(): Promise<number> {
  const { count } = await supabase
    .from('calls')
    .select('id', { count: 'exact', head: true })
    .ilike('audio_url', '%utel%')
    .is('transcript', null)
    .neq('status', 'done')
    .gte('created_at', QUEUE_SINCE);
  return count ?? 0;
}

/** Pauzada: bitta kutayotgan qo'ng'iroqni sinab ko'radi (tiklanish tekshiruvi). */
async function probeOnce(): Promise<void> {
  const { data } = await supabase
    .from('calls')
    .select('id, audio_url, company_id, client_phone')
    .ilike('audio_url', '%utel%')
    .is('transcript', null)
    .neq('status', 'done')
    .gte('created_at', QUEUE_SINCE)
    .gte('duration', 20)
    .order('created_at', { ascending: false })
    .limit(1);
  const row = (data || [])[0] as any;
  if (!row) return;
  console.log(`STT tiklanish sinovi: row=${row.id}`);
  inFlight.add(row.id);
  try {
    await analyzeUtelCall(row.id, row.audio_url, row.company_id ?? null, row.client_phone ?? undefined);
  } catch { /* sinov — xato normal, holat recordOutcome orqali yangilanadi */ } finally {
    inFlight.delete(row.id);
  }
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
        // XIZMAT NOSOZ DEB BELGILANGAN: odatdagi to'plam olinmaydi.
        // Faqat vaqti-vaqti bilan bitta sinov + adminni ogohlantirish.
        if (isSttPaused()) {
          await maybeAlertAdmin(await countWaiting(), isWorkTime());
          if (shouldProbe()) {
            markProbed();
            await probeOnce();
          }
          await new Promise((r) => setTimeout(r, 60_000));
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
