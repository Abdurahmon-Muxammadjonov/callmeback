import { Router, Response } from 'express';
import { supabase } from '../lib/supabase';
import { requireAuth, requireCompanyRole, type CompanyAuthedRequest } from '../middleware/companyAuth';
import { addDays, monthStartOf, tashkentDay } from '../lib/tashkentTime';
import { buildSalesDashboard, invalidateSalesCache, searchLeads, type Query, type SalesSettings } from '../lib/salesDashboard';
import { sendReportToChat } from '../lib/telegramReport';

// ============================================================================
// /analytics/sales — SOTUV DASHBOARDI (2026-10-20, lib/salesDashboard.ts).
//   GET    /?from&to&pipeline&group&gran&field — hamma vidjetlar (har biri
//          alohida: biri yiqilsa {error}, qolganlari ishlaydi)
//   GET    /search?q=                  — Ctrl+K: bitim nomi / ID / telefon
//   GET    /plans | POST /plans | PUT /plans/:id | DELETE /plans/:id
//   GET    /settings | PUT /settings   — pul maydonlari, potensial bosqichlar,
//                                        menejer ↔ operator
//   POST   /telegram                   — qisqa hisobot Telegram chatlarga
//   POST   /ask                        — AI yordamchi (dashboard raqamlari bo'yicha)
// Kompaniya — faqat tokendan; xodim (operator) /analytics'ga kira olmaydi.
// ============================================================================

const router = Router();
router.use(requireAuth);
const adminOnly = requireCompanyRole(['director', 'admin']);

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseQuery(qs: Record<string, unknown>): Query {
  const today = tashkentDay(new Date());
  const to = typeof qs.to === 'string' && DAY_RE.test(qs.to) ? qs.to : today;
  let from = typeof qs.from === 'string' && DAY_RE.test(qs.from) ? qs.from : monthStartOf(to);
  if (from > to) from = to;
  if (addDays(from, 731) < to) from = addDays(to, -730);
  const num = (v: unknown) => (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null);
  const gran = qs.gran === 'week' || qs.gran === 'month' ? qs.gran : 'day';
  return { from, to, pipeline: num(qs.pipeline), group: num(qs.group), gran, fieldId: num(qs.field), now: Date.now() };
}

router.get('/', async (req: CompanyAuthedRequest, res: Response) => {
  try {
    const data = await buildSalesDashboard(req.auth!.companyId as string, parseQuery(req.query as Record<string, unknown>));
    return res.status(200).json({ success: true, data });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Sotuv dashboardida xatolik.' });
  }
});

router.get('/search', async (req: CompanyAuthedRequest, res: Response) => {
  const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 80) : '';
  try {
    return res.status(200).json({ success: true, data: await searchLeads(req.auth!.companyId as string, q) });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Qidiruvda xatolik.' });
  }
});

// ---------------------------------------------------------------- rejalar
function parsePlan(body: any): { ok: true; row: Record<string, unknown> } | { ok: false; error: string } {
  const kind = body?.kind === 'launch' ? 'launch' : body?.kind === 'monthly' ? 'monthly' : null;
  if (!kind) return { ok: false, error: 'Reja turi: monthly yoki launch.' };
  const from = String(body.period_from ?? '');
  const to = String(body.period_to ?? '');
  if (!DAY_RE.test(from) || !DAY_RE.test(to) || from > to) return { ok: false, error: 'Reja davri noto\'g\'ri.' };
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount < 0 || amount > 1e15) return { ok: false, error: 'Reja summasi noto\'g\'ri.' };
  const pid = body.pipeline_id == null || body.pipeline_id === '' ? null : Number(body.pipeline_id);
  if (pid != null && !Number.isFinite(pid)) return { ok: false, error: 'Voronka noto\'g\'ri.' };
  const title = typeof body.title === 'string' ? body.title.trim().slice(0, 120) || null : null;
  return { ok: true, row: { kind, period_from: from, period_to: to, amount, pipeline_id: pid, title } };
}

router.get('/plans', async (req: CompanyAuthedRequest, res: Response) => {
  const { data, error } = await supabase
    .from('crm_plans').select('id, kind, pipeline_id, title, period_from, period_to, amount')
    .eq('company_id', req.auth!.companyId).order('period_to', { ascending: false }).limit(200);
  if (error) return res.status(200).json({ success: true, data: { ready: false, items: [] } });
  return res.status(200).json({ success: true, data: { ready: true, items: data } });
});

router.post('/plans', adminOnly, async (req: CompanyAuthedRequest, res: Response) => {
  const p = parsePlan(req.body);
  if (!p.ok) return res.status(400).json({ success: false, error: p.error });
  const { data, error } = await supabase.from('crm_plans').insert({ ...p.row, company_id: req.auth!.companyId }).select('id').single();
  if (error) return res.status(500).json({ success: false, error: error.message });
  return res.status(201).json({ success: true, data });
});

router.put('/plans/:id', adminOnly, async (req: CompanyAuthedRequest, res: Response) => {
  const p = parsePlan(req.body);
  if (!p.ok) return res.status(400).json({ success: false, error: p.error });
  const { data, error } = await supabase
    .from('crm_plans').update({ ...p.row, updated_at: new Date().toISOString() })
    .eq('id', String(req.params.id)).eq('company_id', req.auth!.companyId).select('id').maybeSingle();
  if (error) return res.status(500).json({ success: false, error: error.message });
  if (!data) return res.status(404).json({ success: false, error: 'Reja topilmadi.' });
  return res.status(200).json({ success: true, data });
});

router.delete('/plans/:id', adminOnly, async (req: CompanyAuthedRequest, res: Response) => {
  const { error } = await supabase.from('crm_plans').delete().eq('id', String(req.params.id)).eq('company_id', req.auth!.companyId);
  if (error) return res.status(500).json({ success: false, error: error.message });
  return res.status(200).json({ success: true });
});

// ------------------------------------------------------------- sozlamalar
router.get('/settings', async (req: CompanyAuthedRequest, res: Response) => {
  const { data, error } = await supabase
    .from('company_integrations').select('sales_settings, pull_meta')
    .eq('company_id', req.auth!.companyId).eq('provider', 'amocrm').maybeSingle();
  if (error) return res.status(200).json({ success: true, data: { ready: false } });
  const meta = (data as any)?.pull_meta ?? null;
  return res.status(200).json({
    success: true,
    data: {
      ready: true,
      connected: !!data,
      settings: (data as any)?.sales_settings ?? {},
      fields: (meta?.fields ?? []).filter((f: any) => f.type === 'monetary' || f.type === 'numeric'),
      pipelines: meta?.pipelines ?? [],
      users: (meta?.users ?? []).filter((u: any) => u.active),
    },
  });
});

router.put('/settings', adminOnly, async (req: CompanyAuthedRequest, res: Response) => {
  const b = req.body ?? {};
  const id = (v: unknown) => (v == null || v === '' ? undefined : Number.isFinite(Number(v)) ? Number(v) : undefined);
  const settings: SalesSettings = {
    deal_field_id: id(b.deal_field_id),
    debt_field_id: id(b.debt_field_id),
    potential_status_ids: Array.isArray(b.potential_status_ids) ? b.potential_status_ids.map(Number).filter(Number.isFinite).slice(0, 200) : undefined,
    user_map: b.user_map && typeof b.user_map === 'object'
      ? Object.fromEntries(Object.entries(b.user_map as Record<string, unknown>)
        .filter(([k, v]) => /^\d+$/.test(k) && typeof v === 'string' && /^[\w-]{1,20}$/.test(v))
        .slice(0, 500) as Array<[string, string]>)
      : undefined,
  };
  const companyId = req.auth!.companyId as string;
  const { data: old } = await supabase.from('company_integrations').select('sales_settings').eq('company_id', companyId).eq('provider', 'amocrm').maybeSingle();
  const moneyChanged = (old as any)?.sales_settings?.deal_field_id !== settings.deal_field_id || (old as any)?.sales_settings?.debt_field_id !== settings.debt_field_id;
  const patch: Record<string, unknown> = { sales_settings: settings, updated_at: new Date().toISOString() };
  // Pul maydoni almashsa — hamma bitim qaytadan o'qiladi.
  if (moneyChanged) Object.assign(patch, { pull_cursor: null });
  const { error } = await supabase.from('company_integrations').update(patch).eq('company_id', companyId).eq('provider', 'amocrm');
  if (error) return res.status(500).json({ success: false, error: error.message });
  invalidateSalesCache(companyId);
  return res.status(200).json({ success: true, data: { settings, resync: moneyChanged } });
});

// -------------------------------------------------------------- Telegram
const fmt = (v: number) => Math.round(v).toLocaleString('ru-RU').replace(/ /g, ' ');
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function salesSummaryText(d: any, from: string, to: string): string {
  const w = d.widgets;
  const L: string[] = [`📈 <b>Sotuv hisoboti</b> · ${from === to ? from : `${from} – ${to}`}`, ''];
  const k = w.kpis && !w.kpis.error ? w.kpis : null;
  if (k) {
    L.push(`💰 Sotuv: <b>${fmt(k.salesSum.value)}</b> so'm · ${k.salesCount.value} ta${k.salesSum.growth.pct != null ? ` (${k.salesSum.growth.pct > 0 ? '+' : ''}${k.salesSum.growth.pct}%)` : ''}`);
    L.push(`✅ Tushgan: ${fmt(k.paid.value)} so'm`);
    L.push(`🎯 Lidlar: ${k.leads.value} · konversiya ${k.conversion.value ?? '—'}% · o'rtacha chek ${k.avgCheck.value != null ? fmt(k.avgCheck.value) : '—'}`);
    L.push(`🆕 Yangi mijozlar: ${k.newClients.value}`);
  }
  if (w.debt && !w.debt.error && w.debt.total > 0) L.push(`⚠️ Qarzdorlik (jami): <b>${fmt(w.debt.total)}</b> so'm · ${w.debt.count} ta`);
  if (w.managers && !w.managers.error && w.managers.rows.length) {
    L.push('', '👥 <b>Menejerlar</b>');
    for (const r of w.managers.rows.slice(0, 8)) L.push(` • ${esc(r.name)} — ${fmt(r.sum)} so'm, ${r.sales} sotuv, ${r.leads} lid`);
  }
  if (w.launch && !w.launch.error && w.launch.plan) {
    const ln = w.launch;
    L.push('', `🚀 Zapusk: ${fmt(ln.fact)} / ${fmt(ln.plan.amount)} (${ln.factPct ?? 0}%) · qoldi ${ln.daysLeft} kun`);
  }
  L.push('', '🔗 https://www.procell.uz/dashboard/sales');
  return L.join('\n');
}

router.post('/telegram', adminOnly, async (req: CompanyAuthedRequest, res: Response) => {
  const companyId = req.auth!.companyId as string;
  const q = parseQuery({ ...(req.query as Record<string, unknown>), ...(req.body ?? {}) });
  const { data: chats, error } = await supabase
    .from('telegram_report_chats').select('chat_id').eq('company_id', companyId).eq('enabled', true);
  if (error || !chats?.length) return res.status(400).json({ success: false, error: 'Telegram ulanmagan — CRM ulanishi sahifasida guruhni ulang.' });
  const d = await buildSalesDashboard(companyId, q);
  if (!d.ready || !('widgets' in d)) return res.status(400).json({ success: false, error: 'amoCRM ma\'lumoti hali yo\'q.' });
  const text = salesSummaryText(d, q.from, q.to);
  let sent = 0;
  for (const c of chats as Array<{ chat_id: number }>) {
    try { await sendReportToChat(c.chat_id, text); sent += 1; } catch { /* bloklangan chat */ }
  }
  return res.status(200).json({ success: true, data: { sent } });
});

// ----------------------------------------------------------- AI yordamchi
router.post('/ask', async (req: CompanyAuthedRequest, res: Response) => {
  const question = typeof req.body?.question === 'string' ? req.body.question.trim().slice(0, 600) : '';
  if (!question) return res.status(400).json({ success: false, error: 'Savol yozing.' });
  const key = process.env.OPENAI_API_KEY;
  if (!key) return res.status(503).json({ success: false, error: 'AI yordamchi sozlanmagan (OPENAI_API_KEY).' });
  const q = parseQuery({ ...(req.query as Record<string, unknown>), ...(req.body ?? {}) });
  const d = await buildSalesDashboard(req.auth!.companyId as string, q);
  if (!d.ready || !('widgets' in d) || !d.meta) return res.status(400).json({ success: false, error: 'amoCRM ma\'lumoti hali yo\'q.' });
  // Modelga faqat yig'ma raqamlar (mijoz ismlari va telefonlar yuborilmaydi).
  const w: any = d.widgets;
  const compact = {
    range: d.meta.range, prev: d.meta.prev,
    kpis: w.kpis, debt: w.debt?.error ? null : { total: w.debt.total, count: w.debt.count, managers: w.debt.managers.slice(0, 15) },
    funnel: w.funnel, sources: w.sources?.error ? null : { total: w.sources.total, leads: w.sources.leads.slice(0, 12), channels: w.sources.channels.slice(0, 12) },
    lost: w.lost, comparison: w.comparison,
    managers: w.managers?.error ? null : w.managers.rows.map((r: any) => ({ name: r.name, leads: r.leads, inWork: r.inWork, sales: r.sales, sum: r.sum, conv: r.conv, avg: r.avg, calls: r.calls, talkSec: r.talkSec, oldestDays: r.oldestDays })),
    ai: w.ai?.error ? null : { total: w.ai.total, analyzed: w.ai.analyzed, avg: w.ai.avg, results: w.ai.results, operators: w.ai.operators },
    launch: w.launch?.error ? null : w.launch.plan ? { plan: w.launch.plan.amount, fact: w.launch.fact, paid: w.launch.paid, expected: w.launch.expected, potential: w.launch.potential, daysLeft: w.launch.daysLeft } : null,
  };
  const lang = String(req.headers['accept-language'] ?? 'uz').slice(0, 2);
  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: process.env.OPENAI_ANALYZE_MODEL || 'gpt-4o-mini',
        temperature: 0.2,
        messages: [
          { role: 'system', content: `Sen sotuv bo'limi tahlilchisisan. Faqat berilgan JSON raqamlariga tayan, raqam o'ylab topma. Summalar — so'm. Qisqa va aniq javob ber (5–8 gap yoki ro'yxat). Javob tili: ${lang === 'ru' ? 'rus' : lang === 'en' ? 'ingliz' : "o'zbek (lotin)"}. Ta'riflar: sotuv — davrda to'lov bosqichiga o'tgan bitim; sum — kelishuv summasi; paid — to'langan; debt — qarz.` },
          { role: 'user', content: `Dashboard ma'lumoti:\n${JSON.stringify(compact).slice(0, 60_000)}\n\nSavol: ${question}` },
        ],
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!resp.ok) throw new Error(`AI HTTP ${resp.status}`);
    const j: any = await resp.json();
    return res.status(200).json({ success: true, data: { answer: String(j?.choices?.[0]?.message?.content ?? '').trim() } });
  } catch (e: any) {
    return res.status(502).json({ success: false, error: e?.message || 'AI javob bermadi.' });
  }
});

export default router;
