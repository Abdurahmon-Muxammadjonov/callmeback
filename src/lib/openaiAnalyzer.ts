// Transkript tahlili uchun OpenAI (GPT-4o-mini) — Gemini o'rniga.
//
// NEGA (2026-09-23): Gemini free tier daqiqasiga ~20 so'rov beradi va
// navbatdagi qo'ng'iroqlar doimiy 429 ("RESOURCE_EXHAUSTED") olib yiqilar
// edi — 400+ audio shu sababdan tahlilsiz qolgan. OPENAI_API_KEY berilgan
// bo'lsa tahlil shu yerdan ketadi, aks holda eski Gemini yo'li ishlaydi
// (audio-pipeline.ts -> analyzeTranscript).
//
// Javob JSON obyekt rejimida so'raladi; maydonlarni tekshirish/normallash
// ikkala yo'l uchun bitta joyda (audio-pipeline.ts).

const API_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = process.env.OPENAI_ANALYZE_MODEL || 'gpt-4o-mini';

export function isOpenAiAnalyzerConfigured(): boolean {
  return !!process.env.OPENAI_API_KEY;
}

// Model qaytarishi kerak bo'lgan JSON shakli. (Gemini'da bu responseSchema
// orqali majburlanardi; bu yerda aniq ko'rsatma sifatida beriladi.)
const JSON_SHAPE = `Javobni FAQAT quyidagi JSON obyekt sifatida qaytar (boshqa matnsiz):
{
  "sentiment": "positive" | "negative" | "neutral",
  "client_mood": "mijoz kayfiyati haqida qisqa izoh",
  "operator_evaluation": "MAJBURIY format, ichida \\n bilan qatorlar: \"(Yangi lid) Ball 7.5/10. Natija: <suhbatda nima bo'ldi, mijoz nima dedi, nimaga kelishildi — 1-2 gap>. Kuchli tomoni: <aniq dalil>. Yaxshilash kerak: <aniq dalil>.\\nXATOLAR:\\n- <Band nomi>: <sotuvchi nimani qilmadi/so'ramadi>\\n- <Band nomi>: <...>\" — XATOLAR bo'limi 100 dan past ball olgan HAR BIR band uchun bitta qator bo'lishi SHART; kamchilik bo'lmasa \"XATOLAR: yo'q\"",
  "deal_closed": true | false,
  "summary": "suhbatning QISQA xulosasi — 1-2 gap, sodda tilda",
  "kpi_score": 0-100 butun son,
  "client_info": "mijoz haqida aniqlangan ma'lumot (ism, ehtiyoj, kontekst)",
  "final_agreement": "suhbat oxiridagi kelishuv yoki natija",
  "next_steps": ["keyingi qadamlar"],
  "lost_reasons": [{"reason_text": "bitim yopilmagan bo'lsa sababi"}],
  "criteria_scores": [{"title": "qoida nomi", "category": "toifa yoki null", "score": 0-100}],
  "key_moments": [{"time": <sekund, butun son — transkriptdagi [MM:SS] dan>, "label": "<5-10 so'z>", "kind": "good"|"bad"|"neutral"}],
  "problem": {"is_problem": true|false, "severity": "low"|"medium"|"high", "reason": "<bir gapda sabab, muammo bo'lmasa bo'sh>"},
  "total_calls": butun son,
  "incoming_count": butun son,
  "outgoing_count": butun son,
  "unanswered_count": butun son,
  "bad_leads_count": butun son,
  "new_leads_count": butun son,
  "sent_to_dealer_count": butun son,
  "closed_deals_count": butun son
}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// QISQA QO'NG'IROQLAR uchun yengil tasniflagich.
//
// NEGA (2026-09-24): "Alo? Alo, eshitilmayapti" kabi qo'ng'iroqlarda sotuv
// skriptini baholashdan ma'no yo'q — ball 0 bo'lib qolar va foydalanuvchi
// "nega tahlil qilinmagan?" deb o'ylardi. Endi ular ham baholanadi, lekin
// boshqacha: SABABI aniqlanadi ("Aloqa sifati yomon", "Javobsiz" va h.k.)
// va qo'ng'iroq izohiga yoziladi. Prompt kichkina — skript yuborilmaydi,
// shu sabab arzon va tez.
export const SHORT_CALL_CATEGORIES = [
  'Javobsiz',
  'Aloqa sifati yomon',
  'Mijoz go\'shakni qo\'ydi',
  'Noto\'g\'ri raqam',
  'Keyinroq qayta qo\'ng\'iroq',
  'Qisqa suhbat',
] as const;

export async function classifyShortCall(
  transcript: string,
  durationSec: number,
): Promise<{ category: string; note: string }> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return { category: 'Qisqa suhbat', note: 'Suhbat juda qisqa.' };

  const system = [
    'Siz call-center qo\'ng\'iroqlarini tasniflaysiz. Qo\'ng\'iroq juda qisqa yoki suhbat bo\'lmagan.',
    `Quyidagi toifalardan AYNAN bittasini tanlang: ${SHORT_CALL_CATEGORIES.join(' | ')}`,
    'Izohlar:',
    '  - "Aloqa sifati yomon" — "alo, alo", "eshitilmayapti", "ovoz kelmayapti", uzuq-yuluq gaplar.',
    '  - "Javobsiz" — hech kim gapirmagan yoki faqat jiringlagan.',
    '  - "Mijoz go\'shakni qo\'ydi" — mijoz javob berib, darhol uzgan.',
    '  - "Noto\'g\'ri raqam" — mijoz "adashdingiz", "bunday odam yo\'q" degan.',
    '  - "Keyinroq qayta qo\'ng\'iroq" — mijoz "bandman, keyin gaplashamiz" degan.',
    '  - "Qisqa suhbat" — yuqoridagilarga to\'g\'ri kelmasa.',
    'JSON qaytaring: {"category": "<toifa>", "note": "<bir gapda o\'zbekcha izoh, nima bo\'lganini ayting>"}',
  ].join('\n');

  try {
    const resp = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: `Qo'ng'iroq davomiyligi: ${durationSec} soniya.\nTranskript:\n${transcript || '(matn yo\'q — nutq aniqlanmadi)'}` },
        ],
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json: any = await resp.json();
    const parsed = JSON.parse(json?.choices?.[0]?.message?.content || '{}');
    const category = SHORT_CALL_CATEGORIES.includes(parsed.category) ? parsed.category : 'Qisqa suhbat';
    const note = typeof parsed.note === 'string' && parsed.note.trim() ? parsed.note.trim() : 'Suhbat juda qisqa.';
    return { category, note };
  } catch (e: any) {
    console.warn('Qisqa qo\'ng\'iroqni tasniflashda xato:', e?.message || e);
    return { category: 'Qisqa suhbat', note: 'Suhbat juda qisqa.' };
  }
}

// Tahlilni bajaradi va modelning XOM JSON matnini qaytaradi.
export async function analyzeWithOpenAi(systemPrompt: string, transcript: string): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY sozlanmagan.');

  const body = {
    model: MODEL,
    temperature: 0.2,
    response_format: { type: 'json_object' as const },
    messages: [
      { role: 'system' as const, content: `${systemPrompt}\n\n${JSON_SHAPE}` },
      { role: 'user' as const, content: `Quyidagi qo'ng'iroq transkriptini tahlil qil:\n\n${transcript}` },
    ],
  };

  const maxAttempts = 4;
  let lastErr = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const resp = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    });

    if (resp.ok) {
      const json: any = await resp.json();
      const text = json?.choices?.[0]?.message?.content;
      if (typeof text === 'string' && text.trim()) return text;
      lastErr = 'javob bo\'sh qaytdi';
    } else {
      const errText = (await resp.text().catch(() => '')).slice(0, 300);
      lastErr = `HTTP ${resp.status} ${errText}`;
      // 429 (tezlik) va 5xx — qayta urinamiz; qolgani (401/400) — darhol xato.
      if (resp.status !== 429 && resp.status < 500) {
        throw new Error(`OpenAI tahlil xatosi: ${lastErr}`);
      }
      // Retry-After sarlavhasi bo'lsa — o'shanga amal qilamiz.
      const ra = Number(resp.headers.get('retry-after'));
      const waitMs = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(30_000, 2000 * 2 ** (attempt - 1));
      if (attempt < maxAttempts) {
        console.warn(`OpenAI tahlil qayta urinish ${attempt}/${maxAttempts}, ${Math.round(waitMs / 1000)}s: ${lastErr}`);
        await sleep(waitMs);
        continue;
      }
    }
    if (attempt >= maxAttempts) break;
  }
  throw new Error(`OpenAI tahlil xatosi (${maxAttempts} urinish): ${lastErr}`);
}
