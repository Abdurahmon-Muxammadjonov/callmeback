// XODIM UCHUN "AYB" va "TAVSIYA" matnini tayyorlaydi.
//
// Maqsad (foydalanuvchi talabi 2026-09-24): "bu narsa sotuvchini aybini
// topib sotuvga yordam berish uchun". Ya'ni quruq raqam emas — nima
// noto'g'ri ketayotgani va uni QANDAY tuzatish kerakligi.
//
// Matnni GPT yozadi, LEKIN faqat haqiqiy ma'lumot asosida: o'sha kungi
// ball, skript bandlarining o'rtacha foizi va izohlardagi aniq xato
// qatorlari. GPT ishlamasa (kalit yo'q / xato) — bandlardan avtomatik
// tayyorlanadigan zaxira matn ishlatiladi, ya'ni bo'lim hech qachon
// bo'sh qolmaydi.

const API_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = process.env.OPENAI_ANALYZE_MODEL || 'gpt-4o-mini';

export interface CoachingInput {
  calls: number;
  minutes: number;
  avgScore: number;        // 0-100
  scoredCalls: number;
  stages: Array<{ title: string; pct: number }>;
  mistakes: string[];      // "− 2.0 · Probniyga chaqirish: ..." qatorlari
  reasons: string[];       // "Aloqa sifati yomon (5 ta)" kabi
}

export interface Coaching {
  faults: string[];
  advice: string[];
}

// Band nomi -> uni tuzatish uchun amaliy maslahat (GPT ishlamasa ishlatiladi).
const STAGE_ADVICE: Array<{ match: RegExp; fault: string; advice: string }> = [
  { match: /probniy/i, fault: 'Probniy darsga chaqirmayapti — bu skriptning eng muhim qadami', advice: 'Har suhbat oxirida bepul probniyga taklif qiling va TANLOV bering: "shanba soat 10 mi, 14 mi?"' },
  { match: /salomlash|povod/i, fault: 'Salomlashish to\'liq emas — o\'zini yoki markazni tanishtirmayapti', advice: 'Doim: "Assalomu alaykum, [Ism]! Men [Ism], [Akademiya]danman" deb boshlang va javobni kuting' },
  { match: /ehtiyoj/i, fault: 'Mijozning ehtiyojini yetarlicha so\'ramayapti', advice: 'Kamida 3 savol bering: nega SAT kerak, hozirgi darajasi qanday, qachongacha ulgurishi kerak' },
  { match: /filtr/i, fault: 'Mijoz mosligini aniqlamayapti', advice: 'So\'rang: jiddiy o\'qimoqchimi yoki faqat ma\'lumot olyaptimi, nechanchi sinf, qaysi universitet' },
  { match: /programmalash/i, fault: 'Suhbat tartibini belgilamayapti', advice: 'Boshida ayting: "avval holatingizni ko\'ramiz, keyin kursni tushuntiraman, oxirida birga qaror qilamiz. Bo\'ladimi?"' },
  { match: /orzu|og\'riq|yo\'qotilgan/i, fault: 'Mijozning maqsadini kuchaytirmayapti', advice: 'So\'rang: "kirsangiz nima o\'zgaradi?", "ulgurmasangiz nimani yo\'qotasiz?"' },
  { match: /taqdimot|tarif/i, fault: 'Kurs va narx aniq tushuntirilmayapti', advice: 'Modullarni foyda tilida ayting ("bu sizga ... beradi") va tariflarni aniq nomlang' },
  { match: /e\'tiroz/i, fault: 'E\'tirozlar bilan ishlamayapti', advice: 'Formula: avval qo\'shiling ("tushunaman"), keyin dalil, keyin kichik qadam — probniyga taklif' },
  { match: /yopish|keyingi qadam/i, fault: 'Suhbatni yopmayapti — keyingi qadam belgilanmayapti', advice: 'Aniq kelishing: sana, vaqt, joy band qilish va ertangi eslatma qo\'ng\'irog\'i' },
  { match: /madaniyat|muloqot/i, fault: 'Muloqot ohangi bo\'sh — xushmuomalalik yetishmayapti', advice: 'Mijozning ismini ishlating, gapini bo\'lmang, suhbatni minnatdorchilik bilan yakunlang' },
];

function fallbackCoaching(input: CoachingInput): Coaching {
  const weak = input.stages.filter((s) => s.pct < 70).slice(0, 4);
  const faults: string[] = [];
  const advice: string[] = [];
  for (const s of weak) {
    const hit = STAGE_ADVICE.find((a) => a.match.test(s.title));
    faults.push(hit ? `${hit.fault} (${s.pct}%)` : `${s.title} — ${s.pct}%`);
    if (hit) advice.push(hit.advice);
  }
  if (!faults.length) faults.push('Sezilarli kamchilik topilmadi — skript bandlari yaxshi bajarilgan.');
  if (!advice.length) advice.push('Shu darajani ushlab turing va probniyga chaqirishni har suhbatda takrorlang.');
  return { faults, advice };
}

export async function buildCoaching(name: string, input: CoachingInput): Promise<Coaching> {
  if (!process.env.OPENAI_API_KEY || input.calls === 0) return fallbackCoaching(input);

  const system = [
    'Siz sotuv bo\'limi rahbarisiz (ROP). Operatorning kunlik natijasiga qarab QISQA va AMALIY xulosa yozasiz.',
    'Maqsad — operatorning aybini topib, uni tuzatishga yordam berish. Quruq maqtov yoki umumiy gap YOZMANG.',
    'JSON qaytaring: {"faults": ["..."], "advice": ["..."]}',
    '  faults — 2-4 ta qator: operator nimani NOTO\'G\'RI qilyapti. Har qator qisqa, aniq va raqam bilan.',
    '           Masalan: "Probniyga chaqirmayapti — 12 ta suhbatdan faqat 1 tasida taklif qilgan".',
    '  advice — 2-4 ta qator: buni QANDAY tuzatish. Amaliy, aynan aytiladigan gap bilan.',
    '           Masalan: "Suhbat oxirida: \'Shanba soat 10 mi, 14 mi qulay?\' deb tanlov bering".',
    'O\'zbek tilida, sodda va hurmat bilan yozing. Har qator 15 so\'zdan oshmasin.',
  ].join('\n');

  const user = [
    `Operator: ${name}`,
    `Kunlik natija: ${input.calls} qo'ng'iroq, ${input.minutes} daqiqa gaplashgan, ${input.scoredCalls} tasi baholangan, o'rtacha ball ${(input.avgScore / 10).toFixed(1)}/10`,
    '',
    'Skript bandlari bo\'yicha o\'rtacha bajarish (eng kuchsizdan):',
    ...input.stages.map((s) => `  ${s.pct}% — ${s.title}`),
    '',
    input.mistakes.length ? 'Qo\'ng\'iroqlardagi aniq xatolar:' : '',
    ...input.mistakes,
    '',
    input.reasons.length ? `Baholanmagan qo'ng'iroqlar sabablari: ${input.reasons.join(', ')}` : '',
  ].filter(Boolean).join('\n');

  try {
    const resp = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.3,
        response_format: { type: 'json_object' },
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json: any = await resp.json();
    const parsed = JSON.parse(json?.choices?.[0]?.message?.content || '{}');
    const clean = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').slice(0, 5) : [];
    const faults = clean(parsed.faults);
    const advice = clean(parsed.advice);
    if (!faults.length && !advice.length) return fallbackCoaching(input);
    return { faults: faults.length ? faults : fallbackCoaching(input).faults, advice: advice.length ? advice : fallbackCoaching(input).advice };
  } catch (e: any) {
    console.warn(`Xodim xulosasini yozishda xato (${name}):`, e?.message || e);
    return fallbackCoaching(input);
  }
}
