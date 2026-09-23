// Gemini free tier LIMITI: generate_content_free_tier_requests = daqiqasiga 20
// so'rov (2026-09-23 xatosidan aniqlandi: "limit: 20, model: gemini-3.6-flash,
// Please retry in 58.8s"). Kvota TUGAMAGAN — bu daqiqalik tezlik chegarasi.
//
// Avval bir nechta qo'ng'iroq parallel tahlilga ketar, hammasi bir vaqtda
// limitga urilar va 429 olib "failed" bo'lardi (400+ qo'ng'iroq shunday
// yiqilgan). Endi barcha Gemini so'rovlari SHU darvozadan o'tadi: daqiqasiga
// ko'pi bilan GEMINI_MAX_RPM (standart 16 — 20 dan zaxira bilan past) ta
// so'rov. Limitga yetsa — navbat kutadi (xato emas). Shu sababli tahlil
// to'xtovsiz, lekin 429'siz ishlaydi.
const MAX_PER_MIN = Math.max(1, Number(process.env.GEMINI_MAX_RPM || 16));
const WINDOW_MS = 60_000;

// Oxirgi daqiqada band qilingan slotlar vaqti (siljuvchi oyna).
let slots: number[] = [];
// Slot band qilishni KETMA-KET qilamiz: aks holda bir vaqtda kelgan
// chaqiruvlar birgalikda chegaradan oshib ketadi (race).
let acquireChain: Promise<void> = Promise.resolve();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function acquire(): Promise<void> {
  for (;;) {
    const now = Date.now();
    slots = slots.filter((t) => now - t < WINDOW_MS);
    if (slots.length < MAX_PER_MIN) {
      slots.push(now);
      return;
    }
    // Eng eski slot oynadan chiqquncha kutamiz (+ kichik zaxira).
    const waitMs = WINDOW_MS - (now - slots[0]) + 300;
    await sleep(waitMs);
  }
}

// Har bir Gemini so'rovini shu funksiya ichida bajaring.
export async function withGeminiSlot<T>(fn: () => Promise<T>): Promise<T> {
  const gate = acquireChain.then(acquire);
  acquireChain = gate.then(
    () => {},
    () => {},
  );
  await gate;
  return fn();
}

export function geminiLimiterStats(): { usedLastMinute: number; maxPerMinute: number } {
  const now = Date.now();
  return { usedLastMinute: slots.filter((t) => now - t < WINDOW_MS).length, maxPerMinute: MAX_PER_MIN };
}
