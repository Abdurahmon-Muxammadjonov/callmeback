// TOSHKENT VAQTI bo'yicha kun va soat hisoblari.
//
// Butun hisobot qatlami Asia/Tashkent bo'yicha ishlaydi: kun chegarasi,
// soatlik kesim va "aynan shu vaqtgacha" (until) solishtirishlari shu
// yerdagi yordamchilar orqali. UTC bo'yicha hisoblansa, kechki
// qo'ng'iroqlar ertangi kunga tushib ketardi.

export const TASHKENT_TZ = 'Asia/Tashkent';
/** Toshkent UTC+5 — yil bo'yi o'zgarmaydi (yozgi vaqt yo'q). */
export const TASHKENT_OFFSET = '+05:00';

const dayFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TASHKENT_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
});
const hmFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TASHKENT_TZ, hour: '2-digit', minute: '2-digit', hour12: false,
});

/** ISO vaqtdan Toshkent kunini beradi: "2026-09-24". */
export function tashkentDay(iso: string | Date): string {
  return dayFmt.format(typeof iso === 'string' ? new Date(iso) : iso);
}

/** ISO vaqtdan Toshkent soat:daqiqasini beradi: "19:07". */
export function tashkentHm(iso: string | Date): string {
  return hmFmt.format(typeof iso === 'string' ? new Date(iso) : iso);
}

/** Toshkent soatini (0-23) beradi. */
export function tashkentHour(iso: string | Date): number {
  return Number(tashkentHm(iso).slice(0, 2));
}

/** Toshkent kunining boshlanish/tugash chegaralari (UTC ISO). */
export function dayBounds(day: string): { from: string; to: string } {
  return {
    from: new Date(`${day}T00:00:00${TASHKENT_OFFSET}`).toISOString(),
    to: new Date(`${day}T23:59:59.999${TASHKENT_OFFSET}`).toISOString(),
  };
}

/** "HH:MM" to'g'ri formatdami? */
export function isHhMm(v: unknown): v is string {
  return typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
}

// ============================================================================
// KUN / HAFTA / OY CHEGARALARI — Toshkent bo'yicha (2026-10-12).
//
// NEGA: bir kunning qo'ng'iroqlar soni turli joyda turlicha chiqardi —
// analytics/overview, /pop, dashboard va management UTC kuni bo'yicha,
// daily-summary/hourly esa Toshkent kuni bo'yicha sanardi. Toshkent
// 00:00–05:00 oralig'idagi qo'ng'iroqlar UTC'da KECHAGI kunga tushardi.
// Endi hamma hisobot chegarasini shu yerdagi yordamchilardan oladi.
// ============================================================================

const TASHKENT_OFFSET_MS = 5 * 60 * 60 * 1000;

/** "YYYY-MM-DD" sanaga n kun qo'shadi (kalendar bo'yicha, mintaqadan mustaqil). */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Toshkent kunining boshlanishi (00:00 +05:00) — Date. */
export function tashkentDayStart(day: string): Date {
  return new Date(`${day}T00:00:00${TASHKENT_OFFSET}`);
}

/** Shu sana tushgan haftaning DUSHANBASI (Postgres date_trunc('week') kabi). */
export function mondayOf(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7; // dushanba=0
  return addDays(day, -dow);
}

/** Shu sana tushgan oyning 1-kuni. */
export function monthStartOf(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

/**
 * Toshkent DEVOR SOATI bo'yicha n oy oldingi lahza (manfiy n — keyingi). Kun oy oxiridan oshsa
 * qisqartiriladi (31-mart -> 28/29-fevral) — Postgres'ning
 * `(now() at time zone 'Asia/Tashkent') - interval '1 month'` bilan bir xil.
 * UTC bo'yicha hisoblansa Toshkent tunida oy chegarasidan "sakrab" o'tardi.
 */
export function minusMonthsTashkent(at: Date, n: number): Date {
  const w = new Date(at.getTime() + TASHKENT_OFFSET_MS); // UTC maydonlari = Toshkent devor soati
  const y = w.getUTCFullYear();
  const m = w.getUTCMonth() - n;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const day = Math.min(w.getUTCDate(), lastDay);
  const local = Date.UTC(y, m, day, w.getUTCHours(), w.getUTCMinutes(), w.getUTCSeconds(), w.getUTCMilliseconds());
  return new Date(local - TASHKENT_OFFSET_MS);
}

/**
 * Toshkent mahalliy vaqti satrini ("2026-10-12 20:17:00", zonasiz) lahzaga
 * aylantiradi. Satrda zona bo'lsa (Z yoki +hh:mm) — o'shani hurmat qiladi.
 * Tanib bo'lmasa null.
 */
export function parseTashkentLocal(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:?\d{2})?$/);
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2]}${m[3] ?? TASHKENT_OFFSET}`);
  return Number.isNaN(d.getTime()) ? null : d;
}
