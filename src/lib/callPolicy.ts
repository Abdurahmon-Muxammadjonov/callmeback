// ============================================================================
// QISQA QO'NG'IROQLAR SAQLANMAYDI VA AI'GA YUBORILMAYDI (2026-10-16)
//
// Foydalanuvchi talabi: "telefondan kelgan qo'ng'iroqlar 1 minutdan kam
// bo'lsa AI'ga yuborma, saqlama — faqat 1 minutdan ko'p bo'lgan audiolarni
// tahlilga yubor".
//
//   - yangi kelgan qisqa qo'ng'iroq bazaga YOZILMAYDI (utel-webhook);
//   - qoida kiritilishidan oldin navbatga tushgani AI'ga yuborilmaydi —
//     SKIP_REASON bilan yopiladi (bazadan o'chirish — direktor o'zi SQL bilan,
//     supabase/cleanup_01_short_calls.sql).
//
// Chegara: UTEL_MIN_CALL_SEC (standart 60). Davomiylik NOMA'LUM bo'lsa
// (UTel 0 yuborgan va audio uzunligini o'lchab bo'lmagan) qo'ng'iroq
// saqlanadi va tahlil qilinadi — haqiqiy uzun suhbat tasodifan yo'qolmasin.
// ============================================================================

export const SKIP_REASON = 'Qisqa (1 daqiqadan kam)';

export function minCallSec(): number {
  const v = Number(process.env.UTEL_MIN_CALL_SEC);
  return Number.isFinite(v) && v >= 0 ? v : 60;
}

/** true — qo'ng'iroq qisqa: saqlanmaydi, tahlil qilinmaydi. */
export function isTooShort(durationSec: number | null | undefined): boolean {
  const d = Number(durationSec);
  return Number.isFinite(d) && d > 0 && d < minCallSec();
}
