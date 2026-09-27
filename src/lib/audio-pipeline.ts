import { GoogleGenAI, Type } from '@google/genai';
import axios from 'axios';
import FormData from 'form-data';
import fs from 'node:fs';
import { copyFile, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { pbxAuthHeaders } from './audioAccess';
import { withGeminiSlot } from './geminiLimiter';
import { analyzeWithOpenAi, isOpenAiAnalyzerConfigured } from './openaiAnalyzer';
import { buildScriptRules, annotateMistakeLines, scoreFromCriteria, rewriteBallText, type ScriptStage } from './evaluationScript';

export interface CriteriaScore {
  title: string;
  category: string | null;
  score: number;
}

export interface LostReason {
  reason_text: string;
}

/* Suhbatning MUHIM joyi — vaqt belgisi bilan. Vaqt sekundda; dashboard
 * uni "02:14" qilib ko'rsatadi va bosilganda audio o'sha joyga o'tadi. */
export interface KeyMoment {
  time: number;
  label: string;
  kind: 'good' | 'bad' | 'neutral';
}

/* Qo'ng'iroq muammoli deb belgilanishi — rahbar darhol ko'rishi uchun. */
export interface CallProblem {
  is_problem: boolean;
  severity: 'low' | 'medium' | 'high';
  reason: string;
}

export interface CallAnalysis {
  sentiment: 'positive' | 'negative' | 'neutral';
  client_mood: string;
  operator_evaluation: string;
  deal_closed: boolean;
  summary: string;
  kpi_score: number;
  client_info: string;
  final_agreement: string;
  next_steps: string[];
  lost_reasons: LostReason[];
  criteria_scores: CriteriaScore[];
  key_moments: KeyMoment[];
  problem: CallProblem;
  // Sessiya-darajasidagi sub-metrikalar — audio yozuv bitta suhbatdan tashkil
  // topgan bo'lsa ham, ba'zan bir nechta qo'ng'iroq/lid ketma-ket ovoz
  // yozuvida bo'lishi mumkin, shu sabab Gemini transkriptdan sanab beradi.
  total_calls: number;
  incoming_count: number;
  outgoing_count: number;
  unanswered_count: number;
  bad_leads_count: number;
  new_leads_count: number;
  sent_to_dealer_count: number;
  closed_deals_count: number;
}

export interface AudioProcessResult {
  transcript: string;
  analysis: CallAnalysis;
  chunks: number;
}

const ANALYZE_MODEL = 'gemini-3.6-flash';
const TMP_ROOT = path.join(os.tmpdir(), 'procell-audio');

// Aisha (aisha.group) — o'zbekcha nutqni matnga aylantirish (STT). v2 endpoint
// uzun audio faylni bitta so'rovda (chunking'siz) qabul qiladi va fon rejimida
// ishlaydi — natija task_id orqali poll qilib olinadi.
const AISHA_BASE_URL = 'https://back.aisha.group';
const AISHA_STT_POST_URL = `${AISHA_BASE_URL}/api/v2/stt/post/`;
const AISHA_STT_GET_URL = (id: number | string) => `${AISHA_BASE_URL}/api/v2/stt/get/${id}/`;
const AISHA_POLL_INTERVAL_MS = 4000;
const AISHA_MAX_WAIT_MS = 15 * 60 * 1000; // 15 daqiqa — juda uzun qo'ng'iroqlar uchun ham yetarli.

const CALL_ANALYSIS_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    sentiment: { type: Type.STRING, format: 'enum', enum: ['positive', 'negative', 'neutral'] },
    client_mood: { type: Type.STRING, description: "Mijozning kayfiyati/holati haqida qisqa izoh" },
    operator_evaluation: { type: Type.STRING, description: "Menejer/operatorning ishi, ohangi, professionalligi haqida tahlil" },
    deal_closed: { type: Type.BOOLEAN },
    summary: { type: Type.STRING, description: "Suhbatning 3-4 jumlalik xulosasi" },
    kpi_score: { type: Type.INTEGER, description: "Menejerning shu qo'ng'iroqdagi umumiy sifat bahosi, 0 dan 100 gacha" },
    client_info: { type: Type.STRING, description: "Mijoz haqida transkriptdan aniqlangan ma'lumot (ism, ehtiyoj, kontekst)" },
    final_agreement: { type: Type.STRING, description: "Suhbat oxiridagi kelishuv yoki natija" },
    next_steps: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "Keyingi qadamlar/harakatlar ro'yxati (bo'lmasa bo'sh massiv)",
    },
    lost_reasons: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: { reason_text: { type: Type.STRING } },
        required: ['reason_text'],
      },
      description: "Agar bitim yopilmagan bo'lsa, sabablari (bo'lsa bo'sh massiv)",
    },
    criteria_scores: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          category: { type: Type.STRING, nullable: true },
          score: { type: Type.INTEGER },
        },
        required: ['title', 'score'],
      },
      description: "Faqat quyida DINAMIK QOIDALAR berilgan bo'lsa to'ldiring — har bir qoida uchun title, category va 0-100 ball. Qoida berilmagan bo'lsa — bo'sh massiv.",
    },
    total_calls: { type: Type.INTEGER, description: "Ushbu audio yozuvda jami nechta alohida qo'ng'iroq/suhbat bor (odatda 1, lekin ketma-ket bir nechta qo'ng'iroq yozib olingan bo'lsa — nechtasi)" },
    incoming_count: { type: Type.INTEGER, description: "Shulardan nechtasi kiruvchi (mijoz tomonidan qilingan) qo'ng'iroq" },
    outgoing_count: { type: Type.INTEGER, description: "Shulardan nechtasi chiquvchi (menejer tomonidan qilingan) qo'ng'iroq" },
    unanswered_count: { type: Type.INTEGER, description: "Shulardan nechtasi javobsiz qoldi (qo'ng'iroq ko'tarilmadi/javob berilmadi)" },
    bad_leads_count: { type: Type.INTEGER, description: "Shulardan nechtasi sifatsiz lid (qiziqishsiz, xato raqam, spam va h.k.)" },
    new_leads_count: { type: Type.INTEGER, description: "Ushbu sessiyada nechta YANGI lid bilan gaplashildi" },
    sent_to_dealer_count: { type: Type.INTEGER, description: "Nechta lid avtosalonga/do'konga yuborildi" },
    closed_deals_count: { type: Type.INTEGER, description: "Nechta bitim ushbu sessiyada yopildi (sotuv)" },
  },
  required: [
    'sentiment', 'client_mood', 'operator_evaluation', 'deal_closed', 'summary',
    'kpi_score', 'client_info', 'final_agreement', 'next_steps', 'lost_reasons', 'criteria_scores',
    'total_calls', 'incoming_count', 'outgoing_count', 'unanswered_count', 'bad_leads_count',
    'new_leads_count', 'sent_to_dealer_count', 'closed_deals_count',
  ],
};

// Axios xatosidan HTTP status + javob tanasini chiqarib, aniq xabar quradi
// (aks holda faqat "Request failed with status code 400" kabi foydasiz matn qoladi).
function describeAxiosError(error: unknown, context: string): Error {
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const data = error.response?.data;
    const bodyText = typeof data === 'string'
      ? data.slice(0, 500)
      : data
        ? JSON.stringify(data).slice(0, 500)
        : error.message;
    return new Error(`${context}: HTTP ${status ?? '?'} — ${bodyText}`);
  }
  return error instanceof Error ? error : new Error(`${context}: ${String(error)}`);
}

async function downloadAudioToTmp(audioUrl: string, targetFilePath: string): Promise<void> {
  // Audio endi Supabase Storage'ga nusxalanmaydi (kvota to'lib loyiha
  // bloklangani uchun) — calls.audio_url PBX'dagi ASL havolaga ishora
  // qiladi, u esa API kalit talab qiladi. Shu sabab yuklab olishda PBX
  // sarlavhalarini qo'shamiz; kalit FAQAT PBX hostiga yuboriladi
  // (audioAccess.pbxAuthHeaders shuni tekshiradi), begona manzilga emas.
  const authHeaders = await pbxAuthHeaders(audioUrl);

  let response;
  try {
    response = await axios.get(audioUrl, {
      responseType: 'stream',
      maxRedirects: 5,
      timeout: 120000,
      headers: {
        'User-Agent': 'Procell-Audio/1.0',
        Accept: 'audio/*,*/*',
        ...authHeaders,
      },
    });
  } catch (error) {
    throw describeAxiosError(error, `Audio yuklab olishda xato (${audioUrl})`);
  }

  if (!response.data) {
    throw new Error('Audio stream bo\'sh qaytdi.');
  }

  await pipeline(response.data, fs.createWriteStream(targetFilePath));
}

function isRetryableAxiosError(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false;
  const status = error.response?.status;
  if (status && [429, 500, 502, 503, 504].includes(status)) return true;
  return !error.response; // tarmoq xatosi (timeout, connection reset va h.k.)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface AishaSttPostResponse {
  id: number;
  task_id: string;
  status: string;
}

interface AishaSttGetResponse {
  id: number;
  status: string; // PENDING | SUCCESS | FAILED (yoki shunga o'xshash)
  transcript?: string;
}

// Audio faylni Aisha'ga yuboradi (async job yaratadi). Tarmoq/5xx xatolarida qayta uriniladi.
async function submitAishaSttJob(filePath: string): Promise<AishaSttPostResponse> {
  const apiKey = process.env.AISHA_API_KEY;
  if (!apiKey) {
    throw new Error('AISHA_API_KEY yo\'q.');
  }

  const maxAttempts = 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const form = new FormData();
    form.append('audio', fs.createReadStream(filePath));
    form.append('language', 'uz');
    form.append('has_diarization', 'false');
    form.append('is_summary', 'false');

    try {
      const response = await axios.request<AishaSttPostResponse>({
        method: 'POST',
        maxBodyLength: Infinity,
        url: AISHA_STT_POST_URL,
        headers: { 'X-Api-Key': apiKey, ...form.getHeaders() },
        data: form,
        timeout: 120000,
      });

      if (typeof response.data?.id !== 'number') {
        throw new Error(`Aisha kutilmagan javob formati qaytardi: ${JSON.stringify(response.data).slice(0, 300)}`);
      }

      return response.data;
    } catch (error) {
      lastError = error;
      if (isRetryableAxiosError(error) && attempt < maxAttempts) {
        console.warn(`Aisha STT topshirish qayta urinish ${attempt}/${maxAttempts}:`, (error as any)?.message);
        await sleep(1500 * attempt);
        continue;
      }
      throw describeAxiosError(error, 'Aisha STT so\'rovi xato qaytardi');
    }
  }

  throw describeAxiosError(lastError, 'Aisha STT so\'rovi xato qaytardi');
}

// Job tugaguncha poll qiladi (X-Api-Key bilan — task-status/JWT endpoint'i emas,
// hujjatlashtirilgan /api/v2/stt/get/{id}/ ishlatiladi, chunki u ham API key bilan ishlaydi).
async function pollAishaSttResult(id: number): Promise<string> {
  const apiKey = process.env.AISHA_API_KEY as string;
  const deadline = Date.now() + AISHA_MAX_WAIT_MS;

  while (Date.now() < deadline) {
    await sleep(AISHA_POLL_INTERVAL_MS);

    let response;
    try {
      response = await axios.get<AishaSttGetResponse>(AISHA_STT_GET_URL(id), {
        headers: { 'X-Api-Key': apiKey },
        timeout: 30000,
      });
    } catch (error) {
      // Poll paytidagi vaqtinchalik tarmoq xatosi — job'ni bekor qilmasdan keyingi
      // urinishda davom etamiz (retryable bo'lmasa ham, chunki bu faqat status so'rovi).
      console.warn('Aisha STT holatini so\'rashda vaqtinchalik xato:', (error as any)?.message);
      continue;
    }

    const status = (response.data?.status || '').toUpperCase();
    if (status === 'SUCCESS') {
      const transcript = response.data?.transcript;
      if (typeof transcript !== 'string') {
        throw new Error('Aisha SUCCESS qaytardi, lekin transcript yo\'q.');
      }
      return transcript.trim();
    }
    if (status && status !== 'PENDING') {
      throw new Error(`Aisha STT job muvaffaqiyatsiz tugadi (status: ${status}).`);
    }
    // PENDING — davom etamiz.
  }

  throw new Error(`Aisha STT javobi ${Math.round(AISHA_MAX_WAIT_MS / 60000)} daqiqada kelmadi (timeout).`);
}

async function transcribeWithAisha(filePath: string): Promise<string> {
  const job = await submitAishaSttJob(filePath);
  return pollAishaSttResult(job.id);
}

// Gemini bepul tarifida daqiqalik so'rov limiti bor (masalan 20 RPM) — ko'p qo'ng'iroq
// bir vaqtda tahlilga tushsa, "429 RESOURCE_EXHAUSTED" bilan vaqtincha rad etilishi mumkin.
// Xabarda odatda "Please retry in Ns" ko'rsatiladi — shuni o'qib, aynan shuncha kutamiz.
function isRetryableGeminiError(error: unknown): boolean {
  const anyErr = error as any;
  const status = anyErr?.status ?? anyErr?.code ?? anyErr?.response?.status;
  if (status === 429 || status === 'RESOURCE_EXHAUSTED') return true;
  if (typeof status === 'number' && status >= 500) return true;
  const msg = String(anyErr?.message ?? anyErr ?? '');
  return /RESOURCE_EXHAUSTED|"code"\s*:\s*429|"code"\s*:\s*5\d\d|rate limit/i.test(msg);
}

function extractGeminiRetryDelayMs(error: unknown, fallbackMs: number): number {
  const msg = String((error as any)?.message ?? error ?? '');
  const match = msg.match(/retry in ([\d.]+)s/i);
  if (match) {
    const seconds = parseFloat(match[1]);
    if (Number.isFinite(seconds) && seconds > 0) return Math.ceil(seconds * 1000) + 1000;
  }
  return fallbackMs;
}

// Gemini — Aisha bergan transkriptni qo'ng'iroq tahlil skripti (mezonlari) bo'yicha baholaydi.
/** Segmentlardan "[MM:SS] Kim: gap" ko'rinishidagi matn yasaydi.
 *
 * GPT key_moments uchun HAQIQIY vaqtlarni ko'rsatishi kerak — shu sabab
 * unga oddiy matn emas, vaqt belgilari qo'yilgan transkript beriladi.
 * Segmentlar bo'lmasa oddiy matn qaytadi. */
export function withTimeCodes(transcript: string, segments: unknown[]): string {
  if (!Array.isArray(segments) || segments.length === 0) return transcript;
  const clock = (sec: number) => {
    const s = Math.max(0, Math.round(sec));
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };
  const speakers = new Map<string, string>();
  const lines: string[] = [];
  for (const raw of segments as any[]) {
    const text = String(raw?.text || '').trim();
    if (!text) continue;
    const key = String(raw?.speaker || '');
    if (key && !speakers.has(key)) speakers.set(key, speakers.size === 0 ? 'Sotuvchi' : 'Mijoz');
    const who = speakers.get(key) || 'Suhbat';
    lines.push(`[${clock(Number(raw?.start) || 0)}] ${who}: ${text}`);
  }
  return lines.length ? lines.join('\n') : transcript;
}

export async function analyzeTranscript(
  transcript: string,
  extraRules = '',
  // Kompaniya skripti (dashboarddagi "Mezonlar"dan). Berilmasa — tizimning
  // o'z skripti ishlatiladi (lib/evaluationScript.ts).
  script?: { fresh: ScriptStage[]; reactivation: ScriptStage[] },
): Promise<CallAnalysis> {
  // Tahlil modeli: OPENAI_API_KEY berilgan bo'lsa GPT-4o-mini (Gemini free
  // tier daqiqalik limitiga urilib navbatni to'xtatib qo'ygani uchun —
  // 2026-09-23), aks holda eski Gemini yo'li.
  const useOpenAi = isOpenAiAnalyzerConfigured();
  if (!useOpenAi && !process.env.GEMINI_API_KEY) {
    throw new Error('Tahlil kaliti yo\'q: OPENAI_API_KEY yoki GEMINI_API_KEY kerak.');
  }

  const systemPrompt = [
    'Siz tajribali call-center QA analitikisiz. Berilgan qo\'ng\'iroq transkriptini chuqur va diqqat bilan tahlil qiling.',
    'Barcha matn maydonlarini (client_mood, operator_evaluation, summary, client_info, final_agreement, next_steps, lost_reasons) o\'zbek tilida yozing.',
    // KPI SHAFFOF BO'LSIN (foydalanuvchi savoli 2026-09-23: "nimaga qarab
    // KPI beryapti?"). Avval faqat "umumiy sifatni 0-100 baholang" deyilardi —
    // ball qaysi asosda chiqqani na modelga, na foydalanuvchiga ayon edi.
    // Endi aniq bandlar va ularning ulushi beriladi, va ball SABABI
    // operator_evaluation'da (dashboard'dagi "ROP izohi") yoziladi.
    buildScriptRules(script?.fresh, script?.reactivation),
    // Platformada ball 10 BALLIK tizimda ko'rsatiladi (foydalanuvchi talabi
    // 2026-09-23). kpi_score maydoni texnik sabablarga ko'ra 0-100 bo'lib
    // qoladi (baza ustuni), lekin izohda ball 10 ballik ko'rinishda yoziladi:
    // 65 -> "6.5/10". Shunda xodim ko'rgan raqam bilan izoh mos keladi.
    // Izoh IKKI TOMONLAMA bo'lishi shart (foydalanuvchi talabi 2026-09-23):
    // avval NEGA shuncha ball OLGANI — ya'ni operator nimani yaxshi qilgani
    // ("qiziqtirdi", "probniyga yozdirdi"), keyin nimani yaxshilash kerakligi.
    // Avval model asosan kamchilikni yozar, xodim esa nima uchun maqtalganini
    // bilmasdi.
    [
      'operator_evaluation — ball NEGA aynan shunday chiqqanini yozing. Format QAT\'IY, uch qismdan iborat:',
      '   1) Qaysi skript ishlatilgani va ball: "(Yangi lid) Ball 8.2/10." yoki "(Eski baza) Ball 6.5/10."',
      '   2) "Natija:" — suhbatda AYNAN NIMA bo\'lgani, bir-ikki gapda, sodda tilda. Mijoz nima dedi va nimaga kelishildi. Masalan: "Operator xushmuomala gaplashdi, mijoz o\'quv markazga kelishga rozi bo\'ldi, shanba 14:00 ga kelishildi." yoki "Mijoz narxni so\'radi, hozir vaqti yo\'qligini aytib, keyinroq o\'zi xabar berishini so\'radi." Bu qator izohni o\'qigan odam qo\'ng\'iroqni ochmasdan nima bo\'lganini tushunishi uchun.',
      '   3) "Kuchli tomoni:" — operator nimani YAXSHI qilgani, aniq dalil bilan. Masalan: "mijozni qiziqtirdi va maqsadini aniqladi, probniyga shanba 14:00 ga yozdirdi", "narxni aniq aytdi va e\'tirozga dalil bilan javob berdi". Ball baland bo\'lsa — aynan NIMA uchun balandligi shu yerda ko\'rinsin.',
      '   4) "Yaxshilash kerak:" — nima qilinmagani. Hammasi bajarilgan bo\'lsa: "Yaxshilash kerak: sezilarli kamchilik yo\'q."',
      '   5) Oxirida ALOHIDA QATORDAN boshlab "XATOLAR:" bo\'limi. 100 dan past ball olgan HAR BIR band uchun bitta qator yozing, AYNAN shu formatda:',
      '      XATOLAR:',
      '      - <Band nomi>: <operator aynan nimani qilmadi yoki so\'ramadi>',
      '      Masalan:',
      '      - Probniyga chaqirish: bepul probniy darsga umuman taklif qilmadi, vaqt varianti berilmadi',
      '      - Ehtiyojni aniqlash: muddatni (qachongacha topshirishi kerakligini) so\'ramadi',
      '      AGAR operator NOTO\'G\'RI GAPIRGAN bo\'lsa (skriptga zid gap aytgan, qo\'pol javob bergan, narxni erta aytgan, mijozni bo\'lgan) — o\'sha gapni QO\'SHTIRNOQ ichida qisqa keltiring va nimasi xato ekanini ayting. Masalan: "- Taqdimot: narxni darrov aytdi (\'narxi 3 million\') — avval ehtiyojni so\'rash kerak edi" yoki "- Muloqot: mijozning gapini bo\'ldi (\'shoshilyapman, qisqa qilaylik\')".',
      '      Bu MIJOZNING emas, SOTUVCHINING xatosi bo\'lsin — skriptda bor-u, operator bajarmagan yoki noto\'g\'ri aytgan narsa. Hech qanday kamchilik bo\'lmasa: "XATOLAR: yo\'q".',
      'Har ikkala qism ham HAR DOIM bo\'lsin — past ballda ham kuchli tomonini toping, baland ballda ham nima yaxshilash mumkinligini yozing. Umumiy gap ("yaxshi ishladi") yozmang, faqat transkriptdagi aniq dalil.',
      'Namuna: "(Yangi lid) Ball 8.2/10. Natija: Mijoz qizi uchun SAT kursini so\'radi, operator narx va jadvalni tushuntirdi, mijoz shanba probniyga kelishga rozi bo\'ldi. Kuchli tomoni: mijozning maqsadini va muddatini aniqladi, kursni foyda tilida tushuntirdi va probniyga shanba 14:00 ga yozdirib, joyini band qildi. Yaxshilash kerak: tariflar orasidagi farq aytilmadi va yopiq kanalga qo\'shish taklif qilinmadi."',
    ].join('\n'),
    // criteria_scores endi skript bandlari bilan to'ldiriladi (avval
    // "faqat dinamik qoidalar bo'lsa" deyilardi va mezonsiz kompaniyada
    // bo'sh qolardi — shu sabab ball tafsiloti ko'rinmasdi).
    'criteria_scores — YUQORIDAGI SKRIPT bandlarining har biri uchun bitta element qo\'shing: {title: band nomi, category: "Skript", score: shu band necha foiz bajarilgani (0-100)}. Agar quyida "QO\'SHIMCHA DINAMIK QOIDALAR" ham berilgan bo\'lsa, ularni HAM shu massivga qo\'shing (category: "Mezon").',
    // ========================================================================
    // MUHIM LAHZALAR (key_moments) — TANLASH QOIDASI (2026-09-27)
    //
    // NEGA: avval promptda faqat JSON shakli berilardi, tanlash mezoni yo'q
    // edi. Natijada model har suhbatda bo'ladigan arzimas lahzalarni
    // yozardi — "Suhbat boshlandi", "Salomlashish", "Mijoz o'z fikrlarini
    // bildirdi". Bunday lahza hech narsa bermaydi: ROP audioni qaysi
    // daqiqadan eshitishini bilmaydi.
    //
    // Endi faqat QARORGA TA'SIR QILGAN lahzalar so'raladi.
    // ========================================================================
    [
      'key_moments — suhbatning FAQAT MUHIM lahzalari, 3 tadan 6 tagacha. Vaqtni transkriptdagi [MM:SS] belgisidan aynan oling, o\'zingizdan o\'ylab topmang va yaxlitlamang.',
      'FAQAT shu turdagi lahzalarni yozing:',
      '  • mijozning E\'TIROZI ("qimmat", "o\'ylab ko\'ramiz", "vaqtim yo\'q", "boshqa joyda arzon") va operator unga qanday javob bergani;',
      '  • mijozning QIZIQISHI yoki ROZILIGI ("qachon boshlanadi?", "kelaman", "joyimni band qiling", raqam/ism berishi);',
      '  • OPERATOR XATOSI — skriptga zid gap, narxni erta aytish, mijozning gapini bo\'lish, savolga javob bermaslik, qo\'pol ohang;',
      '  • NARX yoki TARIF muhokamasi boshlangan joy;',
      '  • KEYINGI QADAM kelishuvi (probniy dars, uchrashuv, qayta qo\'ng\'iroq) — sana/vaqt aytilgan joy.',
      'QUYIDAGILARNI YOZMANG (ular har suhbatda bor va foydasiz): "Suhbat boshlandi", "Salomlashish", "Tanishtirish", "Suhbat tugadi", "Mijoz javob berdi", "Mijoz o\'z fikrlarini bildirdi", "Operator ma\'lumot berdi" kabi umumiy lahzalar.',
      'label — 5-10 so\'z, AYNAN nima bo\'lganini ayting: "Mijoz narxni qimmat dedi" emas "E\'tiroz". Kim nima dedi ko\'rinsin.',
      'kind — faqat uchtasidan biri: "good" (sotuvga yaqinlashtirgan), "bad" (sotuvni yo\'qotgan yoki operator xatosi), "neutral" (muhim, lekin ikki tomonga ham emas).',
      'AGAR problem.is_problem = true bo\'lsa, key_moments ichida KAMIDA BITTA lahza kind="bad" bo\'lishi SHART va u aynan o\'sha muammoning o\'zi bo\'lsin — problem.reason da yozgan narsa qaysi daqiqada yuz berganini ko\'rsating.',
      'Agar suhbatda haqiqatan 3 ta muhim lahza ham bo\'lmasa (juda qisqa yoki mazmunsiz suhbat), bor bo\'lganini yozing — arzimas lahza bilan to\'ldirmang.',
    ].join('\n'),
    'Agar bitim yopilmagan bo\'lsa, lost_reasons massivida sababini yozing; yopilgan bo\'lsa — bo\'sh massiv.',
    'total_calls, incoming_count, outgoing_count, unanswered_count, bad_leads_count, new_leads_count, sent_to_dealer_count, closed_deals_count — transkriptni diqqat bilan o\'qib, ULARNI HAQIQIY sanoqqa asoslab to\'ldiring (taxmin qilib to\'ldirmang). Odatda bitta audio = bitta qo\'ng\'iroq (total_calls=1), lekin transkriptda bir nechta alohida suhbat/qo\'ng\'iroq ketma-ket ketgan bo\'lsa, shularning barchasini sanang. incoming_count + outgoing_count yig\'indisi total_calls\'ga teng bo\'lishi kerak.',

    // Hisoblash qoidalari ANIQ bo'lsin (foydalanuvchi talabi 2026-09-23).
    // Avval bu ko'rsatkichlar ta'rifsiz edi va model ularni o'zicha
    // talqin qilardi. Bu — O'QUV MARKAZI (avtosalon emas).
    [
      'Quyidagi ko\'rsatkichlarni SHU ta\'riflar bo\'yicha aniq hisoblang:',
      '  • unanswered_count — qo\'ng\'iroq ko\'tarilmagan yoki suhbat boshlanmagan (javob yo\'q, darhol uzilgan, avtojavob). Suhbat bo\'lmasa bu 1.',
      '  • bad_leads_count — SIFATSIZ lid. Faqat shu hollarda 1 qiling: (a) qo\'ng\'iroqni ko\'tarmadi/javob bermadi, (b) noto\'g\'ri yoki tasodifiy raqam, (c) mijoz umuman qiziqmadi va suhbatni darhol tugatdi, (d) spam/reklama qo\'ng\'irog\'i, (e) mijoz mos emas (masalan xizmat ko\'rsatilmaydigan joy yoki yosh). Oddiy "hozir vaqtim yo\'q, keyin gaplashamiz" — sifatsiz lid EMAS.',
      '  • bad_leads_count > 0 bo\'lsa, lost_reasons massiviga SABABINI qisqa yozing (masalan: "Qo\'ng\'iroqni ko\'tarmadi", "Noto\'g\'ri raqam", "Qiziqish bildirmadi", "Spam qo\'ng\'iroq", "Mos kelmaydigan mijoz"). Sababsiz qoldirmang.',
      '  • new_leads_count — birinchi marta gaplashilayotgan, xizmatga qiziqish bildirgan yangi mijoz bo\'lsa 1.',
      '  • sent_to_dealer_count — mijoz PROBNIY (bepul sinov) darsga yoki markazga kelishga taklif qilingan VA mijoz rozilik bildirgan bo\'lsa 1 qiling ("shanba kelaman", "joyimni band qiling"). Faqat taklif aytilib, mijoz rozi bo\'lmagan bo\'lsa — 0. (Maydon nomi eski — avtosalon bilan aloqasi yo\'q.)',
      '  • closed_deals_count — mijoz joyni band qilgan, oldindan to\'lov qilgan yoki tarifni tanlab kursga yozilishga aniq rozi bo\'lgan bo\'lsa 1.',
    ].join('\n'),
    extraRules,
  ]
    .filter(Boolean)
    .join('\n\n');

  const allStages = script ? [...script.fresh, ...script.reactivation] : undefined;

  if (useOpenAi) {
    const raw = await analyzeWithOpenAi(systemPrompt, transcript);
    return normalizeAnalysisJson(raw, 'OpenAI', allStages);
  }

  const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

  // maxAttempts 4 -> 6: 429 (daqiqalik limit) bo'lsa kutib qayta urinamiz,
  // "failed" qilmaymiz. Har bir so'rov withGeminiSlot darvozasidan o'tadi —
  // shu sababli 429 kamdan-kam uchraydi (qarang: lib/geminiLimiter.ts).
  const maxAttempts = 6;
  let response: Awaited<ReturnType<typeof client.models.generateContent>> | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      response = await withGeminiSlot(() => client.models.generateContent({
        model: ANALYZE_MODEL,
        contents: `Quyidagi qo'ng'iroq transkriptini tahlil qil:\n\n${transcript}`,
        config: {
          systemInstruction: systemPrompt,
          responseMimeType: 'application/json',
          responseSchema: CALL_ANALYSIS_SCHEMA,
        },
      }));
      break;
    } catch (error) {
      if (isRetryableGeminiError(error) && attempt < maxAttempts) {
        const delay = extractGeminiRetryDelayMs(error, 15000 * attempt);
        console.warn(`Gemini tahlil qayta urinish ${attempt}/${maxAttempts}, ${Math.round(delay / 1000)}s kutilmoqda:`, (error as any)?.message);
        await sleep(delay);
        continue;
      }
      throw error;
    }
  }
  if (!response) {
    throw new Error('Gemini javobi olinmadi (barcha urinishlar tugadi).');
  }

  const text = response.text;
  if (!text) {
    throw new Error('Gemini javobi bo\'sh qaytdi.');
  }
  return normalizeAnalysisJson(text, 'Gemini', allStages);
}

// Model qaytargan JSON'ni tekshiradi va CallAnalysis'ga keltiradi.
// Gemini ham, OpenAI ham shu yerdan o'tadi — maydon nomlari/chegaralari
// bir xil bo'lsin (dashboard ikkala holatda ham bir xil ishlaydi).
// ARZIMAS LAHZALARNI KODDA FILTRLAYMIZ (2026-09-27)
//
// Promptda taqiq bor, lekin model ba'zan baribir yozadi — jonli sinovda
// "Operator o'zini tanishtirdi" o'tib ketdi. Prompt — maslahat, filtr —
// kafolat. Shuning uchun har suhbatda bo'ladigan va qarorga ta'sir
// qilmaydigan lahzalar shu yerda tashlab yuboriladi.
//
// DIQQAT: ro'yxat TOR bo'lishi kerak. "Operator narxlar haqida ma'lumot
// berdi" — narx muhokamasi, u KERAKLI lahza va bu yerga tushmasligi shart.
const TRIVIAL_MOMENT_RE = [
  /salomlash/i,
  /o['’]?zini\s+tanishtir/i,
  /tanishtirish/i,
  /suhbat\s+(boshlandi|tugadi|yakunlandi)/i,
  /qo['’]?ng['’]?iroq\s+(boshlandi|tugadi)/i,
  /mijoz\s+javob\s+berdi/i,
  /mijoz\s+o['’]?z\s+fikr/i,
  /xayrlash/i,
];

export function isTrivialMoment(label: string): boolean {
  return TRIVIAL_MOMENT_RE.some((re) => re.test(label));
}

function normalizeAnalysisJson(text: string, source: string, stages?: ScriptStage[]): CallAnalysis {
  let parsed: Partial<CallAnalysis>;
  try {
    parsed = JSON.parse(text) as Partial<CallAnalysis>;
  } catch {
    throw new Error(`${source} JSON javobini o'qib bo'lmadi.`);
  }

  // sentiment noto'g'ri bo'lsa butun tahlilni tashlab yubormaymiz —
  // qolgan maydonlar foydali; neytral deb olamiz.
  const s = parsed.sentiment;
  const sentiment: CallAnalysis['sentiment'] =
    s === 'positive' || s === 'negative' || s === 'neutral' ? s : 'neutral';

  const clampScore = (v: unknown): number => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
  const intMin0 = (v: unknown): number => Math.max(0, Math.round(Number(v) || 0));

  const criteria: CriteriaScore[] = Array.isArray(parsed.criteria_scores)
    ? parsed.criteria_scores
        .filter((c): c is CriteriaScore => !!c && typeof c.title === 'string' && c.title.trim() !== '')
        .map((c) => ({
          title: c.title,
          category: typeof c.category === 'string' ? c.category : null,
          score: clampScore(c.score),
        }))
    : [];

  // BALL BANDLARDAN hisoblanadi (model arifmetikasiga tayanmaymiz) — shunda
  // "ball 7.5" va xatolardagi minuslar bir-biriga mos keladi.
  const computed = scoreFromCriteria(criteria, stages);
  const kpi = computed ?? clampScore(parsed.kpi_score);
  const evaluation = typeof parsed.operator_evaluation === 'string'
    ? rewriteBallText(annotateMistakeLines(parsed.operator_evaluation, criteria, stages), kpi)
    : '';

  return {
    sentiment,
    client_mood: typeof parsed.client_mood === 'string' ? parsed.client_mood : '',
    operator_evaluation: evaluation,
    deal_closed: Boolean(parsed.deal_closed),
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    kpi_score: kpi,
    client_info: typeof parsed.client_info === 'string' ? parsed.client_info : '',
    final_agreement: typeof parsed.final_agreement === 'string' ? parsed.final_agreement : '',
    next_steps: Array.isArray(parsed.next_steps)
      ? parsed.next_steps.filter((s): s is string => typeof s === 'string' && s.trim() !== '')
      : [],
    lost_reasons: Array.isArray(parsed.lost_reasons)
      ? parsed.lost_reasons
          .filter((r): r is LostReason => !!r && typeof r.reason_text === 'string' && r.reason_text.trim() !== '')
          .map((r) => ({ reason_text: r.reason_text }))
      : [],
    criteria_scores: criteria,
    key_moments: Array.isArray((parsed as any).key_moments)
      ? ((parsed as any).key_moments as any[])
          .filter((k) => k && typeof k.label === 'string' && k.label.trim() !== '' && Number.isFinite(Number(k.time)))
          // Har suhbatda bo'ladigan arzimas lahzalar tashlab yuboriladi.
          .filter((k) => !isTrivialMoment(String(k.label)))
          // Prompt 3-6 ta so'raydi; model ko'proq bersa eng boshidagi
          // 6 tasi olinadi (ular vaqt bo'yicha tartiblangan bo'ladi).
          .slice(0, 6)
          .map((k) => ({
            time: Math.max(0, Math.round(Number(k.time))),
            label: String(k.label).trim().slice(0, 120),
            kind: k.kind === 'good' || k.kind === 'bad' ? k.kind : 'neutral',
          }))
      : [],
    problem: (() => {
      const p = (parsed as any).problem;
      const isProblem = !!p?.is_problem;
      const sev = p?.severity === 'high' || p?.severity === 'medium' ? p.severity : 'low';
      return {
        is_problem: isProblem,
        severity: sev as CallProblem['severity'],
        reason: isProblem && typeof p?.reason === 'string' ? String(p.reason).trim().slice(0, 300) : '',
      };
    })(),
    // Har doim kamida 1 ta qo'ng'iroq deb hisoblanadi — audit qilinayotgan
    // audioning o'zi allaqachon bitta suhbatning dalili.
    total_calls: Math.max(1, intMin0(parsed.total_calls)),
    incoming_count: intMin0(parsed.incoming_count),
    outgoing_count: intMin0(parsed.outgoing_count),
    unanswered_count: intMin0(parsed.unanswered_count),
    bad_leads_count: intMin0(parsed.bad_leads_count),
    new_leads_count: intMin0(parsed.new_leads_count),
    sent_to_dealer_count: intMin0(parsed.sent_to_dealer_count),
    closed_deals_count: intMin0(parsed.closed_deals_count),
  };
}

async function removePathSafe(targetPath: string): Promise<void> {
  try {
    await rm(targetPath, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
}

async function transcribeAndAnalyze(filePath: string, extraRules: string): Promise<{ transcript: string; analysis: CallAnalysis }> {
  const transcript = await transcribeWithAisha(filePath);

  if (!transcript) {
    throw new Error('Transcription bo\'sh chiqdi.');
  }

  const analysis = await analyzeTranscript(transcript, extraRules);

  return { transcript, analysis };
}

export async function processLongAudio(audioUrl: string, extraRules = ''): Promise<AudioProcessResult> {
  if (!process.env.AISHA_API_KEY) {
    throw new Error('AISHA_API_KEY yo\'q.');
  }
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY yo\'q.');
  }

  const workspaceDir = path.join(TMP_ROOT, `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const sourcePath = path.join(workspaceDir, 'source-audio.mp3');

  console.time('audio-pipeline');

  try {
    await mkdir(workspaceDir, { recursive: true });

    await downloadAudioToTmp(audioUrl, sourcePath);

    const { transcript, analysis } = await transcribeAndAnalyze(sourcePath, extraRules);

    return { transcript, analysis, chunks: 1 };
  } catch (error: any) {
    throw new Error(`Audio pipeline xatosi: ${error?.message || 'unknown'}`);
  } finally {
    await removePathSafe(workspaceDir);
    console.timeEnd('audio-pipeline');
  }
}

export async function processLocalAudio(localAudioPath: string, extraRules = ''): Promise<AudioProcessResult> {
  if (!process.env.AISHA_API_KEY) {
    throw new Error('AISHA_API_KEY yo\'q.');
  }
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY yo\'q.');
  }

  const workspaceDir = path.join(TMP_ROOT, `${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const sourcePath = path.join(workspaceDir, `source-audio${path.extname(localAudioPath) || '.mp3'}`);

  console.time('audio-pipeline');

  try {
    await mkdir(workspaceDir, { recursive: true });

    await copyFile(localAudioPath, sourcePath);

    const { transcript, analysis } = await transcribeAndAnalyze(sourcePath, extraRules);

    return { transcript, analysis, chunks: 1 };
  } catch (error: any) {
    throw new Error(`Audio pipeline xatosi: ${error?.message || 'unknown'}`);
  } finally {
    await removePathSafe(workspaceDir);
    console.timeEnd('audio-pipeline');
  }
}