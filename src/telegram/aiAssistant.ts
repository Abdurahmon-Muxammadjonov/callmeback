import { GoogleGenAI } from '@google/genai';
import { TARIFFS, TARIFF_ORDER, DURATION_DISCOUNT_LABELS, FULL_FEATURE_CATEGORIES, formatSum } from './pricing';

let client: GoogleGenAI | null = null;
function getClient(): GoogleGenAI {
  if (!client) {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY sozlanmagan.');
    }
    client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }
  return client;
}

function buildKnowledgeBase(): string {
  const tariffLines = TARIFF_ORDER.map((key) => {
    const t = TARIFFS[key];
    return `- ${t.name}${t.popular ? " (eng mashhur)" : ''}: ${formatSum(t.pricePerEmployee)} so'm/xodim/oy (1 oylik stavka). Kiritilgan: ${t.headline.join(', ')}. Xodimlar soni: 1 dan cheksizgacha.`;
  }).join('\n');

  const discountLines = Object.entries(DURATION_DISCOUNT_LABELS)
    .filter(([, label]) => label)
    .map(([months, label]) => `${months} oy: ${label} chegirma (1 oylik stavkaga nisbatan)`)
    .join('\n');

  const featureLines = Object.entries(FULL_FEATURE_CATEGORIES)
    .map(([category, items]) => `${category}: ${items.join('; ')}`)
    .join('\n');

  return [
    'TARIFLAR:', tariffLines, '',
    "MUDDAT BO'YICHA CHEGIRMALAR:", discountLines, '',
    "TO'LIQ FUNKSIYALAR RO'YXATI (kategoriya bo'yicha):", featureLines,
  ].join('\n');
}

const SYSTEM_PROMPT = `Sen SalesPulse platformasi bo'yicha sotuv/qo'llab-quvvatlash yordamchisisan. SalesPulse — sotuv/call-markaz jamoalari uchun AI asosidagi qo'ng'iroqlarni audit qilish platformasi.

Quyidagi bilim bazasi asosida javob ber:

${buildKnowledgeBase()}

Qoidalar:
- Faqat SalesPulse platformasi (mahsulot, narxlar, funksiyalar, ishlash tartibi) haqidagi savollarga javob ber.
- Foydalanuvchi qaysi tilda yozgan bo'lsa, o'sha tilda javob ber (standart: o'zbekcha).
- Javoblar qisqa bo'lsin (bir necha jumla), oxirida odam bilan bog'lanish taklifini qo'sh: "Agar batafsil gaplashmoqchi bo'lsangiz, 👨‍💼 Admin bilan bog'lanish tugmasini bosing."
- Agar savol platformaga aloqador bo'lmasa yoki ishonchli javob berolmasang, shuni ochiq ayt va taxmin qilish o'rniga "Admin bilan bog'lanish" tugmasini taklif qil.`;

export async function askQuestion(question: string): Promise<string> {
  const response = await getClient().models.generateContent({
    model: 'gemini-3.6-flash',
    contents: question,
    config: { systemInstruction: SYSTEM_PROMPT },
  });

  const text = response.text;
  return text && text.trim() ? text.trim() : "Kechirasiz, javob topilmadi. 👨‍💼 Admin bilan bog'laning.";
}
