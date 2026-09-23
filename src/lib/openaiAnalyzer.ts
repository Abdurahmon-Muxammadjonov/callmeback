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
  "operator_evaluation": "MAJBURIY format, ichida \\n bilan qatorlar: \"(Yangi lid) Ball 7.5/10. Kuchli tomoni: <aniq dalil>. Yaxshilash kerak: <aniq dalil>.\\nXATOLAR:\\n- <Band nomi>: <sotuvchi nimani qilmadi/so'ramadi>\\n- <Band nomi>: <...>\" — XATOLAR bo'limi 100 dan past ball olgan HAR BIR band uchun bitta qator bo'lishi SHART; kamchilik bo'lmasa \"XATOLAR: yo'q\"",
  "deal_closed": true | false,
  "summary": "suhbatning 3-4 jumlalik xulosasi",
  "kpi_score": 0-100 butun son,
  "client_info": "mijoz haqida aniqlangan ma'lumot (ism, ehtiyoj, kontekst)",
  "final_agreement": "suhbat oxiridagi kelishuv yoki natija",
  "next_steps": ["keyingi qadamlar"],
  "lost_reasons": [{"reason_text": "bitim yopilmagan bo'lsa sababi"}],
  "criteria_scores": [{"title": "qoida nomi", "category": "toifa yoki null", "score": 0-100}],
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
