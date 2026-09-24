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
