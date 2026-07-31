import Anthropic from '@anthropic-ai/sdk';
import { TARIFFS, TARIFF_ORDER, DURATION_DISCOUNT_LABELS, FULL_FEATURE_CATEGORIES, formatSum } from './pricing.js';

const client = new Anthropic(); // ANTHROPIC_API_KEY env orqali o'qiladi

function buildKnowledgeBase() {
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
    'TARIFLAR:',
    tariffLines,
    '',
    "MUDDAT BO'YICHA CHEGIRMALAR:",
    discountLines,
    '',
    'TO\'LIQ FUNKSIYALAR RO\'YXATI (kategoriya bo\'yicha):',
    featureLines,
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

export async function askQuestion(question) {
  const response = await client.messages.create({
    model: 'claude-opus-5',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    output_config: { effort: 'low' },
    messages: [{ role: 'user', content: question }],
  });

  if (response.stop_reason === 'refusal') {
    return "Kechirasiz, bu savolga javob berolmayman. 👨‍💼 Admin bilan bog'lanish tugmasini bosing.";
  }

  const textBlock = response.content.find((b) => b.type === 'text');
  return textBlock ? textBlock.text : "Kechirasiz, javob topilmadi. 👨‍💼 Admin bilan bog'laning.";
}
