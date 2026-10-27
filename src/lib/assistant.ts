// ============================================================================
// AI YORDAMCHI (2026-10-20, foydalanuvchi talabi: "o'ng tomonda AI yordamchi —
// messenjer kabi yozishib savol bersa hammasiga javob bersin: nechta audio
// tushdi, nechtasi muvaffaqiyatli, qaysi xodim zo'r ishlayapti; GPT'ga
// ulansin, audiolardan xulosa chiqarib aytsin").
//
// GPT (OpenAI, function calling) kerakli ma'lumotni O'ZI so'raydi — vositalar
// faqat shu kompaniyaning ma'lumotini qaytaradi (companyId tokendan):
//   get_call_stats    — davr: qo'ng'iroqlar, tahlil, ball, muvaffaqiyatli, kayfiyat
//   get_operators     — xodimlar kesimi (kim zo'r / kim sust)
//   get_call_summaries— qo'ng'iroqlar xulosasi (AI tahlil matni) — "audiodan xulosa"
//   get_lead_quality  — sifatli/sifatsiz lid va sabablar
//   get_sales         — amoCRM: sotuv, tushum, qarz, menejerlar (ulangan bo'lsa)
//   get_target        — target reklama: xarajat, CPL, ROAS, kreativlar (Meta Ads)
// Mijoz telefon raqami modelga yuborilmaydi.
// ============================================================================

import { supabase } from './supabase';
import { addDays, dayBounds, tashkentDay } from './tashkentTime';
import { operatorNamesByExt } from './operatorNames';
import { computeLeadQuality } from './leadQuality';
import { buildSalesDashboard } from './salesDashboard';
import { computeTarget } from './metaAds';

const API_URL = 'https://api.openai.com/v1/chat/completions';
const MODEL = process.env.OPENAI_ASSISTANT_MODEL || 'gpt-4o-mini';
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

type CallRow = {
  id: string; operator_ext: string | null; created_at: string; duration: number | null; kpi_score: number | null;
  direction: string | null; sentiment: string | null; closed_deals_count: number | null; new_leads_count: number | null;
  bad_leads_count: number | null; is_problem: boolean | null; summary: string | null; final_agreement: string | null;
  client_info: string | null; rop_comment: string | null; status: string | null;
};

/** Model eski yil bilan so'rasa (masalan 2023-10-16 — ichki bilimi eski),
 *  oy-kunini saqlab joriy yilga o'tkazamiz. */
export function fixYear(day: unknown, today: string): unknown {
  if (typeof day !== 'string' || !DAY_RE.test(day)) return day;
  const y = Number(day.slice(0, 4));
  const ty = Number(today.slice(0, 4));
  if (y >= ty - 1 && y <= ty) return day;
  const moved = `${ty}${day.slice(4)}`;
  return moved > today ? `${ty - 1}${day.slice(4)}` : moved;
}

function clampRange(fromRaw: unknown, toRaw: unknown): { from: string; to: string } {
  const today = tashkentDay(new Date());
  const from = fixYear(fromRaw, today);
  const to = fixYear(toRaw, today);
  let t = typeof to === 'string' && DAY_RE.test(to) ? to : today;
  if (t > today) t = today;
  let f = typeof from === 'string' && DAY_RE.test(from) ? from : t;
  if (f > t) f = t;
  if (addDays(f, 92) < t) f = addDays(t, -92);
  return { from: f, to: t };
}

async function loadCalls(companyId: string, from: string, to: string, cols: string): Promise<CallRow[]> {
  const out: CallRow[] = [];
  for (let off = 0; off < 20_000; off += 1000) {
    const { data, error } = await supabase
      .from('calls').select(cols)
      .eq('company_id', companyId).gte('created_at', dayBounds(from).from).lt('created_at', dayBounds(addDays(to, 1)).from)
      .order('created_at', { ascending: false }).range(off, off + 999);
    if (error) throw new Error(error.message);
    out.push(...((data || []) as unknown as CallRow[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

const STAT_COLS = 'id, operator_ext, created_at, duration, kpi_score, direction, sentiment, closed_deals_count, new_leads_count, bad_leads_count, is_problem, status';
const analyzed = (c: CallRow) => Number(c.kpi_score) > 0;
const success = (c: CallRow) => Number(c.closed_deals_count) > 0;
const r1 = (v: number) => Math.round(v * 10) / 10;

function stats(calls: CallRow[]) {
  const a = calls.filter(analyzed);
  const sent: Record<string, number> = {};
  for (const c of a) if (c.sentiment) sent[c.sentiment] = (sent[c.sentiment] || 0) + 1;
  return {
    calls: calls.length,
    incoming: calls.filter((c) => c.direction === 'incoming' || c.direction === 'inbound').length,
    outgoing: calls.filter((c) => c.direction === 'outgoing' || c.direction === 'outbound').length,
    analyzed: a.length,
    waiting_analysis: calls.filter((c) => !analyzed(c) && c.status !== 'done').length,
    avg_score_10: a.length ? r1(a.reduce((s, c) => s + Number(c.kpi_score), 0) / a.length / 10) : null,
    successful_deal_closed: a.filter(success).length,
    qualified_leads: a.filter((c) => Number(c.new_leads_count) > 0 && !(Number(c.bad_leads_count) > 0)).length,
    unqualified_leads: a.filter((c) => Number(c.bad_leads_count) > 0).length,
    problem_calls: a.filter((c) => c.is_problem).length,
    talk_minutes: Math.round(calls.reduce((s, c) => s + (Number(c.duration) || 0), 0) / 60),
    avg_duration_sec: calls.length ? Math.round(calls.reduce((s, c) => s + (Number(c.duration) || 0), 0) / calls.length) : 0,
    sentiment: sent,
  };
}

const TOOLS = [
  { type: 'function', function: { name: 'get_call_stats', description: "Davr bo'yicha qo'ng'iroqlar statistikasi: jami, kiruvchi/chiquvchi, tahlil qilingan, o'rtacha ball (10 lik), muvaffaqiyatli (bitim yopilgan), sifatli/sifatsiz lid, muammoli, gaplashuv daqiqalari, kayfiyat. by_day=true — kunma-kun.", parameters: { type: 'object', properties: { from: { type: 'string', description: 'YYYY-MM-DD' }, to: { type: 'string', description: 'YYYY-MM-DD' }, by_day: { type: 'boolean' } }, required: ['from', 'to'] } } },
  { type: 'function', function: { name: 'get_operators', description: "Xodimlar (operatorlar) kesimi: qo'ng'iroqlar, tahlil, o'rtacha ball, muvaffaqiyatli, sifatli/sifatsiz lid, gaplashuv daqiqalari, muammoli. Kim zo'r/sust ishlayotganini aniqlash uchun.", parameters: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] } } },
  { type: 'function', function: { name: 'get_call_summaries', description: "Tahlil qilingan qo'ng'iroqlar xulosasi (AI matni: nima bo'ldi, kelishuv, mijoz, ROP izohi). Audiolardan xulosa chiqarish, sabab va misollar uchun. filter: all | successful | unqualified | problem | low_score | high_score.", parameters: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, operator_ext: { type: 'string', description: 'ixtiyoriy: xodim ichki raqami' }, filter: { type: 'string', enum: ['all', 'successful', 'unqualified', 'problem', 'low_score', 'high_score'] }, limit: { type: 'integer', description: '1-40' } }, required: ['from', 'to'] } } },
  { type: 'function', function: { name: 'get_lead_quality', description: "Sifatli va sifatsiz lidlar, sifatsizlik sabablari, xodimlar bo'yicha.", parameters: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] } } },
  { type: 'function', function: { name: 'get_sales', description: "amoCRM sotuvlari: sotuv summasi va soni, tushgan pul, qarzdorlik, konversiya, o'rtacha chek, menejerlar, manbalar, yo'qotish sabablari.", parameters: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] } } },
  { type: 'function', function: { name: 'get_target', description: "Target reklama (Meta: Instagram/Facebook): xarajat (so'mda), ko'rishlar, kliklar, CTR, lidlar, lid narxi (CPL), sifatli lid narxi, sotuvlar, sotuv narxi, ROAS/ROMI; kampaniya va kreativ (reels) kesimi, tavsiyalar.", parameters: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] } } },
] as const;

async function runTool(companyId: string, name: string, args: any): Promise<unknown> {
  const { from, to } = clampRange(args?.from, args?.to);
  if (name === 'get_call_stats') {
    const calls = await loadCalls(companyId, from, to, STAT_COLS);
    const out: any = { from, to, ...stats(calls) };
    if (args?.by_day) {
      const by = new Map<string, CallRow[]>();
      for (const c of calls) { const d = tashkentDay(c.created_at); by.set(d, [...(by.get(d) || []), c]); }
      out.by_day = [...by.entries()].sort().map(([day, cs]) => ({ day, ...stats(cs), sentiment: undefined }));
    }
    return out;
  }
  if (name === 'get_operators') {
    const [calls, names] = await Promise.all([loadCalls(companyId, from, to, STAT_COLS), operatorNamesByExt(companyId)]);
    const by = new Map<string, CallRow[]>();
    for (const c of calls) { const k = String(c.operator_ext ?? '').trim() || '—'; by.set(k, [...(by.get(k) || []), c]); }
    return {
      from, to,
      operators: [...by.entries()].map(([ext, cs]) => ({ ext, name: ext === '—' ? 'Aniqlanmagan' : names.get(ext) || `Operator ${ext}`, ...stats(cs), sentiment: undefined }))
        .sort((a, b) => (b.avg_score_10 ?? 0) - (a.avg_score_10 ?? 0)),
    };
  }
  if (name === 'get_call_summaries') {
    const cols = `${STAT_COLS}, summary, final_agreement, client_info, rop_comment`;
    const [calls, names] = await Promise.all([loadCalls(companyId, from, to, cols), operatorNamesByExt(companyId)]);
    const f = String(args?.filter ?? 'all');
    let list = calls.filter(analyzed);
    if (args?.operator_ext) list = list.filter((c) => String(c.operator_ext ?? '').trim() === String(args.operator_ext).trim());
    if (f === 'successful') list = list.filter(success);
    else if (f === 'unqualified') list = list.filter((c) => Number(c.bad_leads_count) > 0);
    else if (f === 'problem') list = list.filter((c) => c.is_problem);
    else if (f === 'low_score') list = [...list].sort((a, b) => Number(a.kpi_score) - Number(b.kpi_score));
    else if (f === 'high_score') list = [...list].sort((a, b) => Number(b.kpi_score) - Number(a.kpi_score));
    const limit = Math.max(1, Math.min(40, Number(args?.limit) || 20));
    const cut = (s: string | null, n: number) => (s ? (s.length > n ? `${s.slice(0, n)}…` : s) : null);
    return {
      from, to, filter: f, matched: list.length,
      calls: list.slice(0, limit).map((c) => ({
        at: c.created_at.slice(0, 16).replace('T', ' '),
        operator: c.operator_ext ? names.get(String(c.operator_ext).trim()) || `Operator ${c.operator_ext}` : null,
        duration_sec: c.duration, score_10: c.kpi_score ? r1(Number(c.kpi_score) / 10) : null,
        deal_closed: success(c), sentiment: c.sentiment,
        lead: Number(c.bad_leads_count) > 0 ? 'sifatsiz' : Number(c.new_leads_count) > 0 ? 'sifatli' : null,
        summary: cut(c.summary, 300), agreement: cut(c.final_agreement, 160), client: cut(c.client_info, 120), rop_comment: cut(c.rop_comment, 350),
      })),
    };
  }
  if (name === 'get_lead_quality') return { from, to, ...(await computeLeadQuality(companyId, from, to)), recent_unqualified: undefined };
  if (name === 'get_sales') {
    const d: any = await buildSalesDashboard(companyId, { from, to, pipeline: null, group: null, gran: 'day', fieldId: null, now: Date.now() });
    if (!d.ready || !d.connected) return { connected: false, note: 'amoCRM ulanmagan' };
    const w = d.widgets;
    const ok = (x: any) => (x && !x.error ? x : null);
    return {
      from, to,
      kpis: ok(w.kpis),
      debt: ok(w.debt) && { total: w.debt.total, count: w.debt.count, managers: w.debt.managers.slice(0, 10) },
      managers: ok(w.managers) && w.managers.rows.slice(0, 15).map((r: any) => ({ name: r.name, leads: r.leads, sales: r.sales, sum: r.sum, conv: r.conv, avg_check: r.avg, in_work: r.inWork, oldest_open_days: r.oldestDays })),
      sources: ok(w.sources) && w.sources.leads.slice(0, 10).map((s: any) => ({ name: s.name, leads: s.leads, sales: s.sales, sum: s.sum })),
      lost: ok(w.lost) && { total: w.lost.total, top: w.lost.rows.slice(0, 8) },
      funnel: ok(w.funnel) && { total: w.funnel.total, sales: w.funnel.sales, conv: w.funnel.conv },
    };
  }
  if (name === 'get_target') {
    const d: any = await computeTarget(companyId, from, to);
    if (!d.ready) return { note: 'target jadvali hali yo\'q' };
    return {
      from, to, meta_connected: d.connected, currency_rate: d.rate, totals: d.totals, recs: d.recs,
      campaigns: d.campaigns.slice(0, 15),
      creatives: d.creatives.slice(0, 25).map((c: any) => ({ ...c, thumb: undefined })),
    };
  }
  return { error: `noma'lum vosita: ${name}` };
}

export interface ChatMsg { role: 'user' | 'assistant'; content: string }

export async function askAssistant(companyId: string, history: ChatMsg[], lang: string): Promise<string> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('AI yordamchi sozlanmagan (OPENAI_API_KEY).');
  const { data: company } = await supabase.from('companies').select('name').eq('id', companyId).maybeSingle();
  const today = tashkentDay(new Date());
  const wd = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7; // 0 = dushanba
  const weekStart = addDays(today, -wd);
  const language = lang === 'ru' ? 'rus tilida' : lang === 'en' ? 'ingliz tilida' : "o'zbek tilida (lotin)";
  const system = [
    `Sen "${(company as any)?.name ?? 'kompaniya'}" sotuv bo'limining AI yordamchisisan (SalesPulse).`,
    `SANALAR (aynan shularni ishlat, yil — ${today.slice(0, 4)}): bugun = ${today}; kecha = ${addDays(today, -1)}; shu hafta = ${weekStart} … ${today}; o'tgan hafta = ${addDays(weekStart, -7)} … ${addDays(weekStart, -1)}; shu oy = ${today.slice(0, 8)}01 … ${today}; so'nggi 7 kun = ${addDays(today, -6)} … ${today}; so'nggi 30 kun = ${addDays(today, -29)} … ${today}.`,
    "Savolga javob berishdan oldin KERAKLI vositani chaqir va FAQAT qaytgan raqamlarga tayan — hech qachon raqam yoki xulosa o'ylab topma.",
    "Natija bo'sh bo'lsa (calls=0, analyzed=0 yoki matched=0) — ochiq ayt: 'bu davrda ma'lumot yo'q' yoki 'qo'ng'iroqlar hali tahlil qilinmagan'; 'hammasi yaxshi' kabi taxmin qilma. Qo'ng'iroq ko'p-u tahlil kam bo'lsa — buni alohida ayt (waiting_analysis).",
    "Davr aytilmasa: bugun va so'nggi 7 kun.",
    "'Muvaffaqiyatli' — bitim yopilgan qo'ng'iroq (deal_closed). 'Zo'r ishlayapti' — o'rtacha ball, muvaffaqiyatli va sifatli lidlar bo'yicha; kam tahlilli xodimni ehtiyot bilan bahola.",
    "Audiolardan xulosa so'ralsa — get_call_summaries bilan xulosalarni o'qib, umumiy naqshlar, kuchli va zaif tomonlar, aniq tavsiyalar ber.",
    `Javob ${language}, qisqa va aniq: avval asosiy raqamlar, keyin 2–5 punkt xulosa. Summalar so'mda, minglar bo'shliq bilan (1 250 000).`,
  ].join('\n');
  const messages: any[] = [{ role: 'system', content: system }, ...history.slice(-12).map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }))];
  for (let round = 0; round < 6; round++) {
    const resp = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: MODEL, temperature: 0.2, messages, tools: TOOLS, tool_choice: 'auto' }),
      signal: AbortSignal.timeout(90_000),
    });
    if (!resp.ok) throw new Error(`AI HTTP ${resp.status}: ${(await resp.text()).slice(0, 160)}`);
    const j: any = await resp.json();
    const msg = j?.choices?.[0]?.message;
    if (!msg) throw new Error('AI javob bermadi.');
    const calls: any[] = msg.tool_calls ?? [];
    if (!calls.length) return String(msg.content ?? '').trim();
    messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: calls });
    for (const tc of calls) {
      let result: unknown;
      try {
        if (process.env.ASSISTANT_DEBUG) console.log('assistant tool:', tc.function?.name, tc.function?.arguments);
        result = await runTool(companyId, tc.function?.name, JSON.parse(tc.function?.arguments || '{}'));
      } catch (e: any) {
        result = { error: String(e?.message || e).slice(0, 200) };
      }
      messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(result).slice(0, 60_000) });
    }
  }
  throw new Error('AI javobni yakunlay olmadi — savolni aniqroq yozing.');
}
