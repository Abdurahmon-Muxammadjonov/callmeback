// ============================================================================
// SIFATSIZ LID SABABLARI — TOIFALAR (2026-10-16)
//
// AI bir xil sababni turlicha yozadi ("Mijoz qiziqish bildirmadi",
// "Qiziqish bildirmadi", "mijoz qiziqish bildirmadi va suhbatni tugatdi").
// Lid sifati hisobotida ular BITTA toifaga yig'iladi; toifaga tushmagani
// o'z matni bilan (birinchi harfi katta) qoladi. Tartib muhim — birinchi mos
// kelgan toifa olinadi.
// ============================================================================

const RULES: Array<[RegExp, string]> = [
  [/ko['‘’ʻ`]?tarma|javob berma|javobsiz|olmadi|ulanmadi/i, "Qo'ng'iroqni ko'tarmadi"],
  [/noto['‘’ʻ`]?g['‘’ʻ`]?ri raqam|xato raqam|tasodifiy|boshqa odam|adashib/i, "Noto'g'ri raqam"],
  [/spam|reklama/i, 'Spam / reklama'],
  [/mos (emas|kelma)|to['‘’ʻ`]?g['‘’ʻ`]?ri kelma|yosh|maqsadli emas|hudud|shahar/i, 'Mos kelmaydigan mijoz'],
  [/narx|qimmat|pul|byudjet|to['‘’ʻ`]?lov/i, 'Narx / byudjet'],
  [/vaqt|keyin|band|hozir emas/i, "Vaqti yo'q / keyinroq"],
  [/boshqa (joy|kurs|markaz|o['‘’ʻ`]?quv)|allaqachon (o['‘’ʻ`]?qi|yozil)/i, "Boshqa joyda o'qiydi"],
  [/qiziq/i, 'Qiziqish bildirmadi'],
  [/suhbat (umuman )?bo['‘’ʻ`]?lma|muloqot bo['‘’ʻ`]?lma|ma['‘’ʻ`]?lumot berilma|uzil|davom ettir(il)?ma|tugatdi|qo['‘’ʻ`]?ydi/i, "Suhbat bo'lmadi / uzildi"],
];

export function leadReasonCategory(text: string): string {
  const t = String(text || '').trim();
  if (!t) return 'Sabab yozilmagan';
  for (const [re, cat] of RULES) if (re.test(t)) return cat;
  return t.charAt(0).toUpperCase() + t.slice(1);
}
