// ============================================================================
// OPERATOR TAVSIYALARI ("TUZATISH YO'LI") — FON JOBI (API v2 §10)
//
// NEGA BU JOB BOR: ilgari bu matn /api/analytics/staff-stats GET so'rovi
// ICHIDA GPT chaqirib yozilardi va so'rov 7.4 soniya ketardi. §0.4 qoidasi:
// hech bir GET LLM chaqirmaydi. Endi matn shu jobda tayyorlanadi,
// operator_insights jadvaliga yoziladi, GET esa faqat O'QIYDI.
//
// Jadval: supabase/api_v2_stage1_operator_insights.sql
//
// JOYLASHUV (§3): worker servis hali yo'q, shuning uchun job API jarayonida
// ishlaydi. Railway'da bitta instansiya bo'lgani uchun xotiradagi qo'riqchi
// yetarli. Worker paydo bo'lganda bu Postgres advisory-lock leader'ga
// ko'chiriladi — shu sababli reja va bajarish ataylab ajratilgan
// (runOperatorInsights() ni har qanday joydan chaqirish mumkin).
// ============================================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { supabase } from '../lib/supabase';
import { tashkentDayKey } from '../lib/workHours';

const API_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = process.env.OPENAI_ANALYZE_MODEL || 'gpt-4o-mini';

// Qancha kunni qaraymiz va operator kamida nechta baholangan qo'ng'iroqqa
// ega bo'lishi kerak (§10: rules.insightMinRated = 5).
//
// DIQQAT: bu qiymatlar KEYINGI QADAMDA company_settings.rules ga ko'chadi
// (§0.3 — kodda biznes qiymati qolmasligi kerak). Hozir company_settings
// jadvalida `rules` ustuni yo'q, shuning uchun vaqtincha env + standart.
const LOOKBACK_DAYS = Math.max(1, Number(process.env.INSIGHT_LOOKBACK_DAYS || 7));
const MIN_RATED = Math.max(1, Number(process.env.INSIGHT_MIN_RATED || 5));
const MAX_TIP_CHARS = 90;

/** GPT javobi shakli — §10 qat'iy belgilagan. */
const TipsSchema = z.object({
  uz: z.array(z.string().trim().min(1).max(MAX_TIP_CHARS)).length(3),
  ru: z.array(z.string().trim().min(1).max(MAX_TIP_CHARS)).length(3),
});
export type Tips = z.infer<typeof TipsSchema>;

interface OperatorInput {
  ext: string;
  ratedCalls: number;
  /** Eng ko'p ball yeb ketgan 3 ta xato. */
  topErrors: Array<{ label: string; lostPoints: number; failRate: number }>;
  /** Eng past ballli 5 qo'ng'iroqning qisqa xulosasi. */
  lowSummaries: string[];
}

// ---------------------------------------------------------------------------
// 1) Ma'lumot yig'ish — faqat SQL/o'qish, model yo'q.
// ---------------------------------------------------------------------------

/** "− 2.0 · Probniyga chaqirish: ..." qatoridan xato nomi va ballni ajratadi. */
function parseMistake(line: string): { label: string; minus: number } | null {
  const m = line.match(/^[−-]\s*([\d.]+)\s*·\s*([^:]+):/);
  if (!m) return null;
  const minus = Number(m[1]);
  const label = m[2].trim();
  if (!Number.isFinite(minus) || !label) return null;
  return { label, minus };
}

export async function collectInsightInputs(
  db: SupabaseClient,
  companyId: string,
): Promise<OperatorInput[]> {
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86_400_000).toISOString();
  const { data, error } = await db
    .from('calls')
    .select('operator_ext, kpi_score, rop_comment, summary')
    .eq('company_id', companyId)
    .gte('created_at', since)
    .gt('kpi_score', 0)
    .not('operator_ext', 'is', null)
    .order('kpi_score', { ascending: true })
    .limit(5000);
  if (error) throw new Error(`calls o'qilmadi: ${error.message}`);

  interface Agg {
    ext: string; rated: number;
    mistakes: Map<string, { count: number; minus: number }>;
    lowSummaries: string[];
  }
  const byExt = new Map<string, Agg>();
  for (const r of (data || []) as any[]) {
    const ext = String(r.operator_ext);
    const a: Agg = byExt.get(ext)
      || { ext, rated: 0, mistakes: new Map<string, { count: number; minus: number }>(), lowSummaries: [] };
    a.rated += 1;
    // Qatorlar kpi_score bo'yicha o'sish tartibida keladi, ya'ni eng
    // pastlari birinchi — shuning uchun birinchi 5 tasi kerakli 5 ta.
    if (a.lowSummaries.length < 5 && typeof r.summary === 'string' && r.summary.trim()) {
      a.lowSummaries.push(r.summary.trim().slice(0, 220));
    }
    for (const line of String(r.rop_comment || '').split('\n')) {
      const p = parseMistake(line.trim());
      if (!p) continue;
      const cur = a.mistakes.get(p.label) || { count: 0, minus: 0 };
      cur.count += 1;
      cur.minus += p.minus;
      a.mistakes.set(p.label, cur);
    }
    byExt.set(ext, a);
  }

  return [...byExt.values()]
    .filter((a) => a.rated >= MIN_RATED)
    .map((a) => ({
      ext: a.ext,
      ratedCalls: a.rated,
      topErrors: [...a.mistakes.entries()]
        .map(([label, v]) => ({
          label,
          lostPoints: Math.round(v.minus * 10) / 10,
          failRate: Math.round((100 * v.count) / a.rated),
        }))
        .sort((x, y) => y.lostPoints - x.lostPoints)
        .slice(0, 3),
      lowSummaries: a.lowSummaries,
    }));
}

// ---------------------------------------------------------------------------
// 2) GPT — operatorga bitta chaqiruv (§10 xarajat qoidasi).
// ---------------------------------------------------------------------------

const SYSTEM = [
  'Siz sotuv bo\'limi rahbarisiz (ROP). Operatorga UCH TA amaliy tavsiya yozasiz.',
  'Maqsad — KONVERSIYA: har tavsiya "shu operator ko\'proq mijoz yopishi" uchun bo\'lsin.',
  'Qoidalar:',
  `  - har tavsiya BUYRUQ shaklida, aniq va ${MAX_TIP_CHARS} belgidan qisqa;`,
  '  - aynan aytiladigan gapni bering ("Shanba 10 mi, 14 mi?" kabi), umumiy gap yozmang;',
  '  - eng ko\'p ball yeb ketgan xatodan boshlang — ular berilgan;',
  '  - "yaxshi ishlang", "e\'tiborli bo\'ling" kabi bo\'sh maslahat YOZMANG.',
  'JSON qaytaring: {"uz": ["...","...","..."], "ru": ["...","...","..."]}',
  'ru — o\'sha uch tavsiyaning rus tilidagi tarjimasi, xuddi shu tartibda.',
].join('\n');

function buildUserPrompt(input: OperatorInput): string {
  return [
    `Operator: ${input.ext}`,
    `Oxirgi ${LOOKBACK_DAYS} kunda baholangan qo'ng'iroqlar: ${input.ratedCalls}`,
    '',
    'Eng ko\'p ball yeb ketgan xatolar (band · yo\'qotilgan ball · necha % qo\'ng\'iroqda):',
    ...input.topErrors.map((e) => `  ${e.label} · −${e.lostPoints} ball · ${e.failRate}%`),
    '',
    input.lowSummaries.length ? 'Eng past ballli qo\'ng\'iroqlar xulosasi:' : '',
    ...input.lowSummaries.map((s, i) => `  ${i + 1}) ${s}`),
  ].filter(Boolean).join('\n');
}

/** Bitta operator uchun tavsiya oladi. Xato bo'lsa null (job to'xtamaydi). */
export async function generateTips(input: OperatorInput): Promise<{ tips: Tips; tokens: number } | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    console.warn('operator_insights: OPENAI_API_KEY yo\'q — tavsiya yozilmadi.');
    return null;
  }
  try {
    const resp = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.3,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: buildUserPrompt(input) },
        ],
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const json: any = await resp.json();
    const parsed = TipsSchema.safeParse(JSON.parse(json?.choices?.[0]?.message?.content || '{}'));
    if (!parsed.success) {
      console.warn(`operator_insights: ${input.ext} javobi shaklga mos kelmadi — ${parsed.error.issues[0]?.message}`);
      return null;
    }
    return { tips: parsed.data, tokens: Number(json?.usage?.total_tokens) || 0 };
  } catch (e: any) {
    console.warn(`operator_insights: ${input.ext} uchun xato — ${e?.message || e}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// 3) Job
// ---------------------------------------------------------------------------

export interface InsightRunResult {
  operators: number; written: number; skipped: number; tokens: number;
}

export async function runOperatorInsights(
  companyId: string,
  db: SupabaseClient = supabase,
): Promise<InsightRunResult> {
  const inputs = await collectInsightInputs(db, companyId);
  const out: InsightRunResult = { operators: inputs.length, written: 0, skipped: 0, tokens: 0 };

  for (const input of inputs) {
    const res = await generateTips(input);          // operatorga BITTA chaqiruv
    if (!res) { out.skipped += 1; continue; }
    out.tokens += res.tokens;
    const { error } = await db.from('operator_insights').upsert({
      company_id: companyId,
      operator_ext: input.ext,
      items_uz: res.tips.uz,
      items_ru: res.tips.ru,
      generated_at: new Date().toISOString(),
      based_on_calls: input.ratedCalls,
      based_on_days: LOOKBACK_DAYS,
      model: MODEL,
    }, { onConflict: 'company_id,operator_ext' });
    if (error) {
      console.warn(`operator_insights yozilmadi (${input.ext}): ${error.message}`);
      out.skipped += 1;
    } else {
      out.written += 1;
    }
  }

  console.log(
    `operator_insights: ${out.written}/${out.operators} operator yangilandi`
    + ` (o'tkazib yuborilgan ${out.skipped}, ${out.tokens} token) — kompaniya ${companyId.slice(0, 8)}`,
  );
  return out;
}

// ---------------------------------------------------------------------------
// 4) Reja (§10: 13:00, 20:00 ish kunlari + 02:30 har kecha)
// ---------------------------------------------------------------------------

const SLOTS = ['13:00', '20:00', '02:30'] as const;

/** Bitta kunda bir slot faqat bir marta ishlashi uchun xotiradagi qo'riqchi. */
const ranToday = new Set<string>();

function currentSlot(now = new Date()): string | null {
  const hm = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Tashkent', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(now);
  // Slot vaqti o'tib ketgan bo'lsa ham ushlab olamiz (tekshiruv 5 daqiqada bir).
  for (const s of SLOTS) {
    if (hm >= s && hm < addMinutes(s, 15)) return s;
  }
  return null;
}

function addMinutes(hm: string, mins: number): string {
  const [h, m] = hm.split(':').map(Number);
  const t = h * 60 + m + mins;
  return `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

let started = false;

/**
 * Rejani ishga tushiradi.
 *
 * DIQQAT: bu xotiradagi qo'riqchiga tayanadi, ya'ni BIR nechta instansiyada
 * job takrorlanishi mumkin. Hozir Railway'da bitta instansiya bor. Worker
 * servis paydo bo'lganda bu funksiya o'sha yerga ko'chadi va qo'riqchi
 * Postgres advisory-lock bilan almashtiriladi (§3).
 */
export function startOperatorInsightsSchedule(companyIds: () => Promise<string[]>): void {
  if (started) return;
  started = true;

  const tick = async () => {
    try {
      const slot = currentSlot();
      if (!slot) return;
      const key = `${tashkentDayKey()}:${slot}`;
      if (ranToday.has(key)) return;
      ranToday.add(key);
      if (ranToday.size > 20) ranToday.clear();      // kun almashdi — tozalaymiz

      const ids = await companyIds();
      console.log(`operator_insights reja: ${slot} sloti, ${ids.length} kompaniya.`);
      for (const id of ids) await runOperatorInsights(id);
    } catch (e: any) {
      console.warn('operator_insights reja xatosi:', e?.message || e);
    }
  };

  void tick();
  setInterval(() => void tick(), 5 * 60_000);
  console.log(`operator_insights reja yoqildi (${SLOTS.join(', ')} Asia/Tashkent).`);
}
