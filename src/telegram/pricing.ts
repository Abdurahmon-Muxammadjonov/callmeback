// Marketing tariflari (narx hisob-kitobi) — telegram-bot/pricing.js'dan
// TypeScript'ga portlangan, mantiq o'zgarmagan. DIQQAT: bu `tariffs` DB
// jadvalidan (bo'lim-ochish tizimi, supabase/tariff_unlock_bots.sql) FARQLI
// narsa — bu yerda faqat narx/marketing matni, u yerda esa qaysi bo'lim
// ochilishi va nechta kod berilishi belgilanadi.

export interface MarketingTariff {
  key: string;
  name: string;
  pricePerEmployee: number;
  popular: boolean;
  headline: string[];
}

export const TARIFFS: Record<string, MarketingTariff> = {
  start: {
    key: 'start',
    name: 'START',
    pricePerEmployee: 300000,
    popular: false,
    headline: ['Audio tahlil', "Menejer/xodim baholash", 'Qisqa xulosa'],
  },
  standart: {
    key: 'standart',
    name: 'STANDART',
    pricePerEmployee: 550000,
    popular: false,
    headline: ["To'liq audio tahlil", 'Skript tekshiruvi', "CRM'ga avtomatik izoh", 'Lid sifatini aniqlash'],
  },
  pro: {
    key: 'pro',
    name: 'PRO',
    pricePerEmployee: 799000,
    popular: true,
    headline: ['Transkriptsiya', "To'liq sotuv jarayoni", 'Vazifalar nazorati', "Qo'ng'iroqni tarjima qilish"],
  },
  max_plus: {
    key: 'max_plus',
    name: 'MAX+',
    pricePerEmployee: 1099000,
    popular: false,
    headline: ['AI chat yordamchi', 'Cheksiz AI Treyner', 'Avtomatik reyting', 'Trend tahlili'],
  },
};

export const TARIFF_ORDER = ['start', 'standart', 'pro', 'max_plus'];
export const DURATIONS = [1, 3, 6, 12];
export const DURATION_MULTIPLIERS: Record<number, number> = { 1: 1.0, 3: 0.93, 6: 0.88, 12: 0.78 };
export const DURATION_DISCOUNT_LABELS: Record<number, string | null> = { 1: null, 3: '-7%', 6: '-12%', 12: '-22%' };

export const FULL_FEATURE_CATEGORIES: Record<string, string[]> = {
  'Audio tahlil': [
    "Har bir qo'ng'iroqni to'liq transkripsiya qilish",
    'Ovoz ohangi, his-tuyg\'u va mijoz kayfiyatini aniqlash',
    "Menejer va xodimlarning suhbat sifatini baholash",
  ],
  'Sotuv jarayoni': [
    'Savdo bosqichlarini (tanishuv, ehtiyoj, taklif, yopish) kuzatish',
    'Skript/qoidalarga rioya qilinganini tekshirish',
    "Yo'qotilgan lidlar sabablarini aniqlash",
  ],
  'Vazifa va jarayon nazorati': [
    "Xodimlarning kunlik/haftalik ish faoliyatini kuzatish",
    'Bajarilmagan vazifalar bo\'yicha ogohlantirish',
  ],
  'Konversiya va vaqt metrikalari': [
    'Trafik va sotuv konversiyasi',
    "Qo'ng'iroq davomiyligi va javob berish vaqti",
    "KPI ball, jarima/bonus hisob-kitobi",
  ],
  "Qo'shimcha": [
    'CRM tizimlariga avtomatik integratsiya',
    "Qo'ng'iroqni boshqa tillarga tarjima qilish",
  ],
  'AI yordamchi (yuqori tarif)': [
    'AI chat orqali jamoa bilan interaktiv muloqot',
    "Cheksiz AI Treyner — xodimlarni mashq qildirish",
    'Avtomatik reyting va trend tahlili',
  ],
};

export function formatSum(n: number): string {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

export function pricePerEmployee(tariffKey: string, durationMonths: number): number {
  const tariff = TARIFFS[tariffKey];
  const multiplier = DURATION_MULTIPLIERS[durationMonths];
  return Math.round(tariff.pricePerEmployee * multiplier);
}

export function monthlyTotal(tariffKey: string, durationMonths: number, employeeCount: number): number {
  return Math.round(pricePerEmployee(tariffKey, durationMonths) * employeeCount);
}

export function periodTotal(tariffKey: string, durationMonths: number, employeeCount: number): number {
  return Math.round(monthlyTotal(tariffKey, durationMonths, employeeCount) * durationMonths);
}

export function baseMonthlyTotal(tariffKey: string, employeeCount: number): number {
  return Math.round(TARIFFS[tariffKey].pricePerEmployee * employeeCount);
}
