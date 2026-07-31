// Tariflar va narx hisob-kitobi. Bot ham, keyinchalik sayt ham shu faylni
// qayta ishlatishi mumkin (bitta manba — narxlar hech qayerda takrorlanmaydi).

export const TARIFFS = {
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

export const DURATION_MULTIPLIERS = { 1: 1.0, 3: 0.93, 6: 0.88, 12: 0.78 };
export const DURATION_DISCOUNT_LABELS = { 1: null, 3: '-7%', 6: '-12%', 12: '-22%' };

// To'liq funksiyalar ro'yxati — kategoriya bo'yicha. AI yordamchi bilim bazasi
// va sayt uchun ham qayta ishlatiladi.
export const FULL_FEATURE_CATEGORIES = {
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
  'Qo\'shimcha': [
    'CRM tizimlariga avtomatik integratsiya',
    "Qo'ng'iroqni boshqa tillarga tarjima qilish",
  ],
  'AI yordamchi (yuqori tarif)': [
    'AI chat orqali jamoa bilan interaktiv muloqot',
    "Cheksiz AI Treyner — xodimlarni mashq qildirish",
    'Avtomatik reyting va trend tahlili',
  ],
};

export function formatSum(n) {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

export function pricePerEmployee(tariffKey, durationMonths) {
  const tariff = TARIFFS[tariffKey];
  const multiplier = DURATION_MULTIPLIERS[durationMonths];
  return Math.round(tariff.pricePerEmployee * multiplier);
}

export function monthlyTotal(tariffKey, durationMonths, employeeCount) {
  return Math.round(pricePerEmployee(tariffKey, durationMonths) * employeeCount);
}

export function periodTotal(tariffKey, durationMonths, employeeCount) {
  return Math.round(monthlyTotal(tariffKey, durationMonths, employeeCount) * durationMonths);
}

// 1 oylik stavka bo'yicha jami (chegirmasiz) — 3/6/12 oy uchun "chizib
// tashlangan" taqqoslash narxi sifatida ko'rsatiladi.
export function baseMonthlyTotal(tariffKey, employeeCount) {
  return Math.round(TARIFFS[tariffKey].pricePerEmployee * employeeCount);
}
