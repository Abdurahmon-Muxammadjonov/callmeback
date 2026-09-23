// ISH VAQTI OYNASI (foydalanuvchi talabi 2026-09-23).
//
// Tahlil faqat ish vaqtida bajariladi: ertalab 09:00 dan kechki 19:00
// gacha (Toshkent vaqti). 19:00 da kun YOPILADI — undan keyin kelgan
// qo'ng'iroqlar saqlanadi (audio yo'qolmaydi), lekin tahlil qilinmaydi;
// ular ertasi kuni 09:00 da ish boshlanganda navbatga tushadi.
//
// Buning ikki sababi bor:
//   1) Kunlik ball 19:00 dan keyin o'zgarmaydi — kun yakunlangan hisoblanadi.
//   2) Ish vaqtidan tashqari bekorga token sarflanmaydi.
//
// Soat WORK_START_HOUR / WORK_END_HOUR o'zgaruvchilari bilan sozlanadi,
// vaqt mintaqasi — WORK_TZ (standart Asia/Tashkent).

const TZ = process.env.WORK_TZ || 'Asia/Tashkent';
const START_HOUR = clampHour(process.env.WORK_START_HOUR, 9);
const END_HOUR = clampHour(process.env.WORK_END_HOUR, 19);

function clampHour(raw: string | undefined, fallback: number): number {
  const n = raw != null ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 && n <= 24 ? n : fallback;
}

// Berilgan vaqtning Toshkentdagi soati va daqiqasi.
export function localHourMinute(at: Date = new Date()): { hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(at);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return { hour, minute };
}

// Hozir ish vaqtimi? (09:00 <= hozir < 19:00, Toshkent)
export function isWorkTime(at: Date = new Date()): boolean {
  const { hour } = localHourMinute(at);
  return hour >= START_HOUR && hour < END_HOUR;
}

export function workWindowLabel(): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(START_HOUR)}:00–${pad(END_HOUR)}:00 (${TZ})`;
}
