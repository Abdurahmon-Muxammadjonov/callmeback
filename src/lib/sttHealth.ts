// ============================================================================
// STT SOG'LIG'I — "BO'SH MATN" UZILISHIGA QARSHI HIMOYA (2026-09-27)
//
// NIMA BO'LGANI: 24-sentabr 19:01:49 dan sales-ai-front har bir audioga
// HTTP 200 va status='done' qaytardi, lekin transkript BO'SH edi. Bo'sh
// matn esa "Javobsiz" deb yozilib, status='done' qo'yilardi — navbat
// bunday qatorni boshqa olmaydi. Natijada 2949 qo'ng'iroq yo'qoldi va
// nosozlik 3 KUN sezilmadi.
//
// NEGA BITTA QO'NG'IROQ YETARLI EMAS: bitta qo'ng'iroq darajasida bo'sh
// matnni haqiqiy javobsizdan ajratib bo'lmaydi — ikkalasi ham bo'sh.
// Shuning uchun himoya GLOBAL: oxirgi N ta YETARLICHA UZUN qo'ng'iroqning
// ko'pchiligi bo'sh chiqsa, bu endi tasodif emas — xizmat nosoz.
//
// CHEGARA QAYERDAN OLINGAN (haqiqiy ma'lumotdan kalibrlangan):
//   23-sentabr (normal kun)    : ≥20s qo'ng'iroqlarning 19.7% i bo'sh
//   24-sentabr ertalab (normal): 14.7% i bo'sh
//   nosozlik davri             : 100% i bo'sh
// Standart chegara 70% — normal shovqindan ancha yuqori, uzilishdan
// ancha past. p=0.20 bo'lganda 20 tadan 14 tasi bo'sh chiqish ehtimoli
// ~2e-6, ya'ni yolg'on ishga tushish amalda bo'lmaydi.
//
// PAUZA HOLATIDA qo'ng'iroq "Javobsiz" deb YOZILMAYDI — u 'stt_suspect'
// holatida qoladi. Bu holat 'done' emas, demak xizmat tiklangach navbat
// uni o'zi qayta oladi va hech narsa yo'qolmaydi.
//
// TIKLANISH: pauza paytida navbat har PROBE_INTERVAL_MS da BITTA kutayotgan
// qo'ng'iroqni sinab ko'radi. Matn kelsa — pauza o'zi ochiladi. Alohida
// sinov audiosi kerak emas: sinov ham foydali ish bajaradi.
//
// Sozlamalar (env):
//   STT_HEALTH_WINDOW            oyna hajmi (standart 20)
//   STT_EMPTY_THRESHOLD          bo'sh ulushi chegarasi (standart 0.7)
//   STT_HEALTH_MIN_DURATION_SEC  qaysi qo'ng'iroq hisobga olinadi (20)
//   STT_PROBE_INTERVAL_MS        tiklanishni tekshirish oralig'i (10 daq)
//   STT_ALERT_AFTER_MS           ogohlantirishgacha jimlik (30 daq)
// ============================================================================

const num = (raw: string | undefined, fallback: number): number => {
  const n = raw != null ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const WINDOW = Math.max(3, Math.round(num(process.env.STT_HEALTH_WINDOW, 20)));
const THRESHOLD = Math.min(1, num(process.env.STT_EMPTY_THRESHOLD, 0.7));
const MIN_DURATION_SEC = num(process.env.STT_HEALTH_MIN_DURATION_SEC, 20);
const PROBE_INTERVAL_MS = num(process.env.STT_PROBE_INTERVAL_MS, 10 * 60_000);
const ALERT_AFTER_MS = num(process.env.STT_ALERT_AFTER_MS, 30 * 60_000);

/** Pauza paytida qo'ng'iroq shu holatda qoladi ('done' EMAS — qayta olinadi). */
export const SUSPECT_STATUS = 'stt_suspect';

interface State {
  /** Oxirgi natijalar: true = bo'sh matn. */
  recent: boolean[];
  paused: boolean;
  pausedAt: number;
  lastSuccessAt: number;
  lastProbeAt: number;
  lastAlertAt: number;
}

const state: State = {
  recent: [],
  paused: false,
  pausedAt: 0,
  lastSuccessAt: Date.now(),
  lastProbeAt: 0,
  lastAlertAt: 0,
};

/** Shu davomiylikdagi qo'ng'iroq sog'liq o'lchoviga kiradimi? */
export function countsTowardHealth(durationSec: number): boolean {
  return Number(durationSec) >= MIN_DURATION_SEC;
}

function emptyRatio(): number {
  if (!state.recent.length) return 0;
  return state.recent.filter(Boolean).length / state.recent.length;
}

/**
 * Bitta tahlil natijasini qayd etadi.
 * @returns pauza AYNI SHU chaqiruvda yoqilgan bo'lsa true.
 */
export function recordOutcome(empty: boolean, durationSec: number): boolean {
  if (!countsTowardHealth(durationSec)) return false;

  state.recent.push(empty);
  if (state.recent.length > WINDOW) state.recent.shift();

  if (!empty) {
    state.lastSuccessAt = Date.now();
    // Matn keldi — xizmat tirik. Pauzani darhol ochamiz.
    if (state.paused) {
      state.paused = false;
      state.recent = [];
      console.log('STT sog\'lig\'i: matn qaytdi — pauza OCHILDI.');
    }
    return false;
  }

  // Oyna to'lmaguncha qaror qabul qilmaymiz (kichik namunada tasodif ko'p).
  if (state.paused || state.recent.length < WINDOW) return false;

  if (emptyRatio() >= THRESHOLD) {
    state.paused = true;
    state.pausedAt = Date.now();
    console.error(
      `STT sog'lig'i: oxirgi ${state.recent.length} ta (≥${MIN_DURATION_SEC}s) qo'ng'iroqning `
      + `${Math.round(emptyRatio() * 100)}% i BO'SH matn qaytardi — navbat PAUZA qilindi.`,
    );
    return true;
  }
  return false;
}

export function isPaused(): boolean {
  return state.paused;
}

/** Pauza paytida tiklanishni tekshirish vaqti keldimi? */
export function shouldProbe(): boolean {
  return state.paused && Date.now() - state.lastProbeAt >= PROBE_INTERVAL_MS;
}

export function markProbed(): void {
  state.lastProbeAt = Date.now();
}

/** Ishga tushishda sozlamalarni logga yozadi — himoya yuklanganini ko'rish uchun. */
export function logHealthConfig(): void {
  console.log(
    `STT circuit breaker yoqilgan: oxirgi ${WINDOW} ta (≥${MIN_DURATION_SEC}s) `
    + `qo'ng'iroqning ≥${Math.round(THRESHOLD * 100)}% i bo'sh chiqsa navbat pauza qilinadi; `
    + `tiklanish sinovi har ${Math.round(PROBE_INTERVAL_MS / 60000)} daq, `
    + `ogohlantirish ${Math.round(ALERT_AFTER_MS / 60000)} daq jimlikdan keyin.`,
  );
}

export function healthSnapshot(): {
  paused: boolean; emptyRatio: number; window: number; samples: number;
  lastSuccessAt: string; pausedAt: string | null; minDurationSec: number; threshold: number;
} {
  return {
    paused: state.paused,
    emptyRatio: Number(emptyRatio().toFixed(3)),
    window: WINDOW,
    samples: state.recent.length,
    lastSuccessAt: new Date(state.lastSuccessAt).toISOString(),
    pausedAt: state.pausedAt ? new Date(state.pausedAt).toISOString() : null,
    minDurationSec: MIN_DURATION_SEC,
    threshold: THRESHOLD,
  };
}

/** Faqat testlar uchun — holatni tozalaydi. */
export function resetHealthForTest(): void {
  state.recent = [];
  state.paused = false;
  state.pausedAt = 0;
  state.lastSuccessAt = Date.now();
  state.lastProbeAt = 0;
  state.lastAlertAt = 0;
}

// ---------------------------------------------------------------------------
// OGOHLANTIRISH (admin Telegram)
//
// Telegraf bot obyektini import qilmaymiz — quvurga bot'ning yon
// ta'sirlari (polling, webhook) kirmasligi kerak. Bot API'ga oddiy
// HTTP so'rov yetarli.
// ---------------------------------------------------------------------------

async function sendAdminTelegram(text: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT1_TOKEN || process.env.TELEGRAM_BOT;
  const chatId = process.env.ADMIN_CHAT_ID || (process.env.ADMIN_TELEGRAM_IDS || '').split(',')[0]?.trim();
  if (!token || !chatId) {
    console.warn('STT ogohlantirishi yuborilmadi: TELEGRAM_BOT1_TOKEN yoki ADMIN_CHAT_ID yo\'q.');
    return;
  }
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) console.warn(`STT ogohlantirishi yuborilmadi: HTTP ${resp.status}`);
  } catch (e: any) {
    console.warn('STT ogohlantirishi yuborilmadi:', e?.message || e);
  }
}

/**
 * Ish vaqtida uzoq jimlik bo'lsa adminni ogohlantiradi.
 * Takroriy xabar yubormaslik uchun ALERT_AFTER_MS oralig'ida bir marta.
 */
export async function maybeAlertAdmin(waitingCount: number, isWorkTime: boolean): Promise<void> {
  if (!isWorkTime) return;
  const silentMs = Date.now() - state.lastSuccessAt;
  if (silentMs < ALERT_AFTER_MS) return;
  if (Date.now() - state.lastAlertAt < ALERT_AFTER_MS) return;

  state.lastAlertAt = Date.now();
  const minutes = Math.round(silentMs / 60_000);
  const since = new Date(state.lastSuccessAt).toLocaleString('en-GB', { timeZone: 'Asia/Tashkent' });
  await sendAdminTelegram(
    '⚠️ <b>STT ishlamayapti</b>\n\n'
    + `Oxirgi ${minutes} daqiqada birorta qo'ng'iroq matnga o'girilmadi.\n`
    + `Oxirgi muvaffaqiyat: ${since} (Toshkent)\n`
    + `Navbatda kutayotgan: ${waitingCount} ta qo'ng'iroq\n`
    + `Navbat holati: ${state.paused ? 'PAUZA (avtomatik)' : 'ishlayapti'}\n\n`
    + 'Qo\'ng\'iroqlar YO\'QOLMAYDI — xizmat tiklangach o\'zi qayta ishlanadi.',
  );
}
