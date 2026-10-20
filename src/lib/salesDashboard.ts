// ============================================================================
// SOTUV DASHBOARDI (2026-10-20, foydalanuvchi talabi — bitta ekranda butun
// biznes: tushum, qarz, voronkalar, manbalar, menejerlar, reklama, AI
// qo'ng'iroq tahlili, zapusk rejasi). Manba — amoCRM bitimlari (crm_leads,
// lib/crmDeals.ts sinxroni), UTel qo'ng'iroqlari (calls) va rejalar
// (crm_plans). amoCRM'ga TO'G'RIDAN-TO'G'RI murojaat yo'q.
//
// Ta'riflar (hamma vidjetda bir xil):
//   Lid        — davrda YARATILGAN bitim
//   Sotuv      — davrda birinchi marta to'lov bosqichiga o'tgan bitim
//                (bron/predoplata/qisman/to'liq — direktor: "hammasi
//                hisoblanadi"; first_paid_at)
//   Sotuv summasi — Kelishuv Summasi, bo'sh bo'lsa Бюджет (amount())
//   Tushgan    — Бюджет (price) = to'langan
//   Qarz       — Qarzdorlik (kelishuv bor bitimda, ≥ 0)
//   Oldingi davr — xuddi shu uzunlikdagi oldingi oraliq; joriy oy boshidan
//                bo'lsa — o'tgan oyning SHU KUNLARI (1–17 ↔ 1–17)
//
// Ma'lumot API jarayoni xotirasida (kompaniya bo'yicha) saqlanadi va sinxron
// yangilaganda (pull_at o'zgarsa) qayta o'qiladi — sahifa har ochilganda
// 26 000 qatorni bazadan tortmaslik uchun.
// ============================================================================

import { supabase } from './supabase';
import { addDays, dayBounds, monthStartOf, mondayOf, tashkentDay } from './tashkentTime';
import { operatorNamesByExt } from './operatorNames';
import { reportRpc } from './reportRpc';
import { cleanManagerName, normName, PAY_KINDS, type CrmMeta, type PayKind } from './crmDeals';

// ---------------------------------------------------------------------------
// Ma'lumot
// ---------------------------------------------------------------------------
export interface Lead {
  id: number;
  name: string | null;
  pipeline: number;
  status: number;
  kind: PayKind;
  price: number;
  deal: number;
  debt: number;
  payType: string | null;
  resp: number | null;
  contact: number | null;
  phone9: string | null;
  ext: string | null;
  created: number;      // ms
  firstPaid: number | null;
  closed: number | null;
  stageAt: number | null;
  source: string | null;
  utmContent: string | null;
  lossReason: string | null;
  lostFrom: number | null;
  group: number | null;
  cf: Record<string, string> | null;
}

export interface SalesSettings {
  deal_field_id?: number;
  debt_field_id?: number;
  /** "Potensial" — kech bosqichdagi ochiq lidlar (zapusk rejasi uchun). */
  potential_status_ids?: number[];
  /** amoCRM foydalanuvchi id → UTel ichki raqami (qo'ng'iroq vaqti uchun). */
  user_map?: Record<string, string>;
}

export interface Plan { id: string; kind: 'monthly' | 'launch'; pipeline_id: number | null; title: string | null; period_from: string; period_to: string; amount: number }

interface Ctx {
  companyId: string;
  subdomain: string;
  pullAt: string | null;
  pullError: string | null;
  meta: CrmMeta | null;
  settings: SalesSettings;
  leads: Lead[];
}

const ms = (v: unknown) => (v ? Date.parse(String(v)) || null : null);
const LEAD_COLS = 'lead_id, name, pipeline_id, status_id, pay_kind, price, deal_sum, debt, payment_type, responsible_id, contact_id, client_phone9, operator_ext, crm_created_at, first_paid_at, closed_at, stage_at, source, utm_content, loss_reason, lost_from_status_id, group_id, cf';

function toLead(r: any): Lead {
  return {
    id: Number(r.lead_id), name: r.name ?? null, pipeline: Number(r.pipeline_id), status: Number(r.status_id),
    kind: r.pay_kind, price: Number(r.price) || 0, deal: Number(r.deal_sum) || 0, debt: Number(r.debt) || 0,
    payType: r.payment_type ?? null, resp: r.responsible_id != null ? Number(r.responsible_id) : null,
    contact: r.contact_id != null ? Number(r.contact_id) : null, phone9: r.client_phone9 ?? null,
    ext: r.operator_ext ? String(r.operator_ext) : null,
    created: ms(r.crm_created_at) ?? 0, firstPaid: ms(r.first_paid_at), closed: ms(r.closed_at), stageAt: ms(r.stage_at),
    source: r.source ?? null, utmContent: r.utm_content ?? null, lossReason: r.loss_reason ?? null,
    lostFrom: r.lost_from_status_id != null ? Number(r.lost_from_status_id) : null,
    group: r.group_id != null ? Number(r.group_id) : null, cf: r.cf ?? null,
  };
}

async function loadLeads(companyId: string): Promise<Lead[]> {
  const { count, error } = await supabase
    .from('crm_leads').select('lead_id', { count: 'exact', head: true }).eq('company_id', companyId);
  if (error) throw new Error(`crm_leads: ${error.message}`);
  const total = Math.min(count ?? 0, 200_000);
  const pages = Array.from({ length: Math.ceil(total / 1000) }, (_, i) => i);
  const out: Lead[] = [];
  // 6 tadan parallel — 26 000 qator ~2–3 soniyada.
  for (let i = 0; i < pages.length; i += 6) {
    const chunk = await Promise.all(pages.slice(i, i + 6).map(async (p) => {
      const { data, error: e } = await supabase
        .from('crm_leads').select(LEAD_COLS).eq('company_id', companyId)
        .order('lead_id', { ascending: true }).range(p * 1000, p * 1000 + 999);
      if (e) throw new Error(`crm_leads: ${e.message}`);
      return (data || []).map(toLead);
    }));
    for (const c of chunk) out.push(...c);
  }
  return out;
}

const cache = new Map<string, { pullAt: string | null; loadedAt: number; leads: Promise<Lead[]> }>();

export function invalidateSalesCache(companyId: string): void {
  cache.delete(companyId);
}

/** Integratsiya + bitimlar (xotiradan). null — amoCRM ulanmagan; 'not_ready' — SQL yo'q. */
export async function loadContext(companyId: string): Promise<Ctx | null | 'not_ready'> {
  const { data: integ, error } = await supabase
    .from('company_integrations').select('config, pull_at, pull_error, pull_meta, sales_settings, pull_cursor')
    .eq('company_id', companyId).eq('provider', 'amocrm').maybeSingle();
  if (error) return 'not_ready';
  if (!integ) return null;
  const pullAt = (integ as any).pull_at ?? null;
  // Kesh kaliti — pull_cursor: u faqat amoCRM'da bitim o'zgarganda siljiydi
  // (sinxron har 2 daqiqada pull_at'ni yangilaydi — har safar 26 000 qatorni
  // qayta o'qimaslik uchun). To'liq yuklash davomida (≤ 0) — har daqiqada.
  const key = String((integ as any).pull_cursor ?? 'null');
  const fullScan = !(Number((integ as any).pull_cursor) > 0);
  let c = cache.get(companyId);
  if (!c || c.pullAt !== key || Date.now() - c.loadedAt > (fullScan ? 60_000 : 30 * 60_000)) {
    const p = loadLeads(companyId);
    c = { pullAt: key, loadedAt: Date.now(), leads: p };
    cache.set(companyId, c);
    p.catch(() => cache.delete(companyId));
  }
  const leads = await c.leads;
  return {
    companyId,
    subdomain: String((integ as any).config?.subdomain ?? ''),
    pullAt,
    pullError: (integ as any).pull_error ?? null,
    meta: (integ as any).pull_meta ?? null,
    settings: ((integ as any).sales_settings ?? {}) as SalesSettings,
    leads,
  };
}

// ---------------------------------------------------------------------------
// Yordamchilar (sof)
// ---------------------------------------------------------------------------
export const amount = (l: Lead) => (l.deal > 0 ? l.deal : l.price);
export const isPaidKind = (k: PayKind) => PAY_KINDS.includes(k);
const isOpen = (l: Lead) => l.status !== 142 && l.status !== 143 && !isPaidKind(l.kind);
const dayStart = (day: string) => Date.parse(dayBounds(day).from);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400_000);
const dayOfMonth = (d: string) => Number(d.slice(8, 10));
const lastDayOfMonth = (monthStart: string) => addDays(monthStartOf(addDays(monthStart, 32)), -1);

export interface Range { from: string; to: string }

/** Oldingi taqqoslanadigan davr. Oy boshidan bo'lsa — o'tgan oyning shu kunlari. */
export function previousRange(r: Range): Range {
  if (r.from === monthStartOf(r.from) && monthStartOf(r.from) === monthStartOf(r.to)) {
    const pm = monthStartOf(addDays(r.from, -1));
    const pEnd = lastDayOfMonth(pm);
    const to = addDays(pm, dayOfMonth(r.to) - 1);
    return { from: pm, to: to > pEnd ? pEnd : to };
  }
  const len = daysBetween(r.from, r.to) + 1;
  return { from: addDays(r.from, -len), to: addDays(r.from, -1) };
}

export function growth(cur: number, prev: number): { pct: number | null; abs: number } {
  return { pct: prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null, abs: cur - prev };
}

const inR = (t: number | null, a: number, b: number) => t != null && t >= a && t < b;
const bounds = (r: Range) => [dayStart(r.from), dayStart(addDays(r.to, 1))] as const;

interface Filter { pipeline: number | null; group: number | null }
const pass = (l: Lead, f: Filter) => (f.pipeline == null || l.pipeline === f.pipeline) && (f.group == null || l.group === f.group);

function salesIn(leads: Lead[], a: number, b: number, f: Filter) {
  return leads.filter((l) => isPaidKind(l.kind) && inR(l.firstPaid, a, b) && pass(l, f));
}
function leadsIn(leads: Lead[], a: number, b: number, f: Filter) {
  return leads.filter((l) => inR(l.created, a, b) && pass(l, f));
}
const sum = (ls: Lead[], fn: (l: Lead) => number) => ls.reduce((s, l) => s + fn(l), 0);

function salesStats(sales: Lead[]) {
  const priced = sales.filter((l) => amount(l) > 0);
  const total = sum(sales, amount);
  return { count: sales.length, sum: total, paid: sum(sales, (l) => l.price), debt: sum(sales, (l) => l.debt), avg: priced.length ? Math.round(total / priced.length) : null, noPrice: sales.length - priced.length };
}

// ---------------------------------------------------------------------------
// Vidjetlar
// ---------------------------------------------------------------------------
export interface Query extends Range, Filter { gran: 'day' | 'week' | 'month'; fieldId: number | null; now: number }

type Names = { user: (id: number | null) => string; userRaw: Map<number, CrmMeta['users'][number]>; pipeline: (id: number) => string; status: (p: number, s: number) => string; statusSort: (p: number, s: number) => number };

function namesOf(meta: CrmMeta | null): Names {
  const users = new Map((meta?.users ?? []).map((u) => [u.id, u]));
  const pipes = new Map((meta?.pipelines ?? []).map((p) => [p.id, p]));
  return {
    userRaw: users,
    user: (id) => (id == null ? '—' : cleanManagerName(users.get(id)?.name) ?? `#${id}`),
    pipeline: (id) => pipes.get(id)?.name ?? `#${id}`,
    status: (p, s) => pipes.get(p)?.statuses.find((x) => x.id === s)?.name ?? (s === 142 ? 'Успешно' : s === 143 ? 'Закрыто' : `#${s}`),
    statusSort: (p, s) => pipes.get(p)?.statuses.find((x) => x.id === s)?.sort ?? 0,
  };
}

function kpis(ctx: Ctx, q: Query, prev: Range) {
  const f: Filter = q;
  const [a, b] = bounds(q);
  const [pa, pb] = bounds(prev);
  const cur = salesStats(salesIn(ctx.leads, a, b, f));
  const old = salesStats(salesIn(ctx.leads, pa, pb, f));
  const leadsCur = leadsIn(ctx.leads, a, b, f).length;
  const leadsPrev = leadsIn(ctx.leads, pa, pb, f).length;

  // Oy: `to` oyining boshidan — o'tgan oyning shu kunlari bilan.
  const mFrom = monthStartOf(q.to);
  const mPrev = previousRange({ from: mFrom, to: q.to });
  const mCur = sum(salesIn(ctx.leads, ...bounds({ from: mFrom, to: q.to }), f), amount);
  const mOld = sum(salesIn(ctx.leads, ...bounds(mPrev), f), amount);

  // Bugun — hozirgacha; kecha — xuddi shu soatgacha.
  const today = tashkentDay(new Date(q.now));
  const tCur = sum(salesIn(ctx.leads, dayStart(today), q.now + 1, f), amount);
  const tOld = sum(salesIn(ctx.leads, dayStart(addDays(today, -1)), q.now - 86400_000 + 1, f), amount);

  // Yangi mijoz — birinchi sotuvi shu davrda bo'lgan kontakt.
  const firstSale = new Map<string, number>();
  for (const l of ctx.leads) {
    if (!isPaidKind(l.kind) || l.firstPaid == null) continue;
    const k = l.contact != null ? `c${l.contact}` : `l${l.id}`;
    const v = firstSale.get(k);
    if (v == null || l.firstPaid < v) firstSale.set(k, l.firstPaid);
  }
  const newClients = (lo: number, hi: number) => {
    const keys = new Set(salesIn(ctx.leads, lo, hi, f).map((l) => (l.contact != null ? `c${l.contact}` : `l${l.id}`)));
    let n = 0;
    for (const k of keys) if (inR(firstSale.get(k) ?? null, lo, hi)) n += 1;
    return n;
  };
  const conv = (s: number, l: number) => (l ? Math.round((s / l) * 1000) / 10 : null);
  const tm = new Date(q.now + 5 * 3600_000);
  return {
    month: { value: mCur, prev: mOld, growth: growth(mCur, mOld), prevRange: mPrev },
    today: { value: tCur, prev: tOld, growth: growth(tCur, tOld), until: `${String(tm.getUTCHours()).padStart(2, '0')}:${String(tm.getUTCMinutes()).padStart(2, '0')}` },
    newClients: { value: newClients(a, b), prev: newClients(pa, pb) },
    salesCount: { value: cur.count, prev: old.count, growth: growth(cur.count, old.count) },
    salesSum: { value: cur.sum, prev: old.sum, growth: growth(cur.sum, old.sum) },
    paid: { value: cur.paid, prev: old.paid },
    leads: { value: leadsCur, prev: leadsPrev },
    conversion: { value: conv(cur.count, leadsCur), prev: conv(old.count, leadsPrev) },
    avgCheck: { value: cur.avg, prev: old.avg, noPrice: cur.noPrice },
  };
}

function planFact(ctx: Ctx, q: Query, plans: Plan[]) {
  const p = plans.find((x) => x.kind === 'monthly' && (x.pipeline_id ?? null) === (q.pipeline ?? null) && x.period_from <= q.to && x.period_to >= q.to);
  if (!p) return { plan: null };
  const end = p.period_to < q.to ? p.period_to : q.to;
  const s = salesStats(salesIn(ctx.leads, ...bounds({ from: p.period_from, to: end }), { pipeline: p.pipeline_id, group: null }));
  const total = daysBetween(p.period_from, p.period_to) + 1;
  const passed = Math.min(total, Math.max(0, daysBetween(p.period_from, q.to) + 1));
  return {
    plan: p,
    fact: s.sum, paid: s.paid, expected: s.debt, count: s.count,
    pct: p.amount > 0 ? Math.round((s.sum / p.amount) * 1000) / 10 : null,
    timePct: Math.round((passed / total) * 1000) / 10,
    daysLeft: total - passed,
  };
}

function debt(ctx: Ctx, n: Names) {
  const ds = ctx.leads.filter((l) => isPaidKind(l.kind) && l.debt > 0);
  const by = new Map<string, { name: string; sum: number; count: number }>();
  for (const l of ds) {
    const k = String(l.resp ?? '—');
    const r = by.get(k) || { name: n.user(l.resp), sum: 0, count: 0 };
    r.sum += l.debt; r.count += 1;
    by.set(k, r);
  }
  return { total: sum(ds, (l) => l.debt), count: ds.length, managers: [...by.values()].sort((a, b) => b.sum - a.sum) };
}

function funnel(ctx: Ctx, q: Query, n: Names) {
  const [a, b] = bounds(q);
  const leads = leadsIn(ctx.leads, a, b, q);
  const sales = salesIn(ctx.leads, a, b, q);
  const total = leads.length;
  const share = (x: number) => (total ? Math.round((x / total) * 1000) / 10 : 0);
  if (q.pipeline == null) {
    const by = new Map<number, { leads: number; sales: number }>();
    for (const l of leads) { const r = by.get(l.pipeline) || { leads: 0, sales: 0 }; r.leads += 1; by.set(l.pipeline, r); }
    for (const l of sales) { const r = by.get(l.pipeline) || { leads: 0, sales: 0 }; r.sales += 1; by.set(l.pipeline, r); }
    const rows = [...by.entries()].map(([id, r]) => ({
      id, name: n.pipeline(id), leads: r.leads, share: share(r.leads), sales: r.sales,
      conv: r.leads ? Math.round((r.sales / r.leads) * 1000) / 10 : null,
    })).sort((x, y) => y.leads - x.leads);
    return { mode: 'pipelines' as const, total, sales: sales.length, conv: total ? Math.round((sales.length / total) * 1000) / 10 : null, rows };
  }
  const pipe = ctx.meta?.pipelines.find((p) => p.id === q.pipeline);
  const by = new Map<number, number>();
  for (const l of leads) by.set(l.status, (by.get(l.status) || 0) + 1);
  const rows = (pipe?.statuses ?? [...by.keys()].map((id) => ({ id, name: n.status(q.pipeline!, id), sort: 0, kind: 'none' as PayKind })))
    .map((s) => ({ id: s.id, name: s.name, kind: s.kind, leads: by.get(s.id) || 0, share: share(by.get(s.id) || 0) }))
    .filter((r) => r.leads > 0 || r.id !== 143);
  return { mode: 'stages' as const, total, sales: sales.length, conv: total ? Math.round((sales.length / total) * 1000) / 10 : null, rows };
}

function bucketKey(day: string, gran: Query['gran']) {
  return gran === 'day' ? day : gran === 'week' ? mondayOf(day) : monthStartOf(day);
}
function bucketList(r: Range, gran: Query['gran']): string[] {
  const out: string[] = [];
  for (let d = r.from; d <= r.to; d = addDays(d, 1)) {
    const k = bucketKey(d, gran);
    if (out[out.length - 1] !== k) out.push(k);
    if (out.length > 400) break;
  }
  return out;
}

function dynamics(ctx: Ctx, q: Query, prev: Range) {
  const series = (r: Range) => {
    const keys = bucketList(r, q.gran);
    const idx = new Map(keys.map((k, i) => [k, i]));
    const pts = keys.map((k) => ({ key: k, sum: 0, count: 0, partial: false }));
    for (const l of salesIn(ctx.leads, ...bounds(r), q)) {
      const i = idx.get(bucketKey(tashkentDay(new Date(l.firstPaid!)), q.gran));
      if (i == null) continue;
      pts[i].sum += amount(l); pts[i].count += 1;
    }
    const today = tashkentDay(new Date(q.now));
    for (const p of pts) {
      if (q.gran === 'day') { p.partial = p.key === today; continue; }
      const end = q.gran === 'week' ? addDays(p.key, 6) : lastDayOfMonth(p.key);
      p.partial = p.key < r.from || end > r.to || end >= today;
    }
    return pts;
  };
  const cur = series(q);
  const old = series(prev);
  const full = cur.filter((p) => !p.partial);
  const best = full.length ? full.reduce((x, y) => (y.sum > x.sum ? y : x)) : null;
  const worst = full.length ? full.reduce((x, y) => (y.sum < x.sum ? y : x)) : null;
  return {
    gran: q.gran,
    current: { range: { from: q.from, to: q.to }, sum: sum(salesIn(ctx.leads, ...bounds(q), q), amount), count: cur.reduce((s, p) => s + p.count, 0), points: cur },
    previous: { range: prev, sum: old.reduce((s, p) => s + p.sum, 0), count: old.reduce((s, p) => s + p.count, 0), points: old },
    best, worst,
    avg: full.length ? Math.round(full.reduce((s, p) => s + p.sum, 0) / full.length) : null,
  };
}

const SKIP_FIELD = /^lid manbasi|^lost sababi|^to'lov turi|^tarifi|kelishuv|qarz|debitor/;

function fieldDistribution(ctx: Ctx, q: Query) {
  const fields = (ctx.meta?.fields ?? []).filter((f) => f.type === 'select' || f.type === 'multiselect');
  const [a, b] = bounds(q);
  const leads = ctx.leads.filter((l) => inR(l.created, a, b)); // butun biznes
  let fieldId = q.fieldId;
  if (fieldId == null || !fields.some((f) => f.id === fieldId)) {
    // Standart — davrda eng ko'p to'ldirilgan maydon (manba/sabab/to'lov turi emas).
    const filled = new Map<number, number>();
    for (const l of leads) for (const k of Object.keys(l.cf ?? {})) filled.set(Number(k), (filled.get(Number(k)) || 0) + 1);
    fieldId = fields.filter((f) => !SKIP_FIELD.test(normName(f.name))).sort((x, y) => (filled.get(y.id) || 0) - (filled.get(x.id) || 0))[0]?.id ?? null;
  }
  const field = fields.find((f) => f.id === fieldId) ?? null;
  if (!field) return { field: null, fields: fields.map(({ id, name }) => ({ id, name })), total: leads.length, rows: [], notFilled: leads.length };
  const by = new Map<string, { leads: number; sales: number }>();
  let notFilled = 0;
  for (const l of leads) {
    const v = l.cf?.[String(field.id)];
    if (!v) { notFilled += 1; continue; }
    const answers = field.type === 'multiselect' ? v.split(', ') : [v];
    for (const ans of answers) {
      const r = by.get(ans) || { leads: 0, sales: 0 };
      r.leads += 1;
      if (isPaidKind(l.kind) && l.firstPaid != null) r.sales += 1;
      by.set(ans, r);
    }
  }
  const filledN = leads.length - notFilled;
  const rows = [...by.entries()]
    .map(([answer, r]) => ({ answer, leads: r.leads, sales: r.sales, share: filledN ? Math.round((r.leads / filledN) * 1000) / 10 : 0 }))
    .sort((x, y) => y.leads - x.leads);
  return { field: { id: field.id, name: field.name }, fields: fields.map(({ id, name }) => ({ id, name })), total: leads.length, rows: rows.slice(0, 12), shown: Math.min(12, rows.length), answers: rows.length, notFilled };
}

function comparison(ctx: Ctx, q: Query) {
  const curM = monthStartOf(q.to);
  const months: string[] = [];
  let m = curM;
  for (let i = 0; i < 7; i++) { months.unshift(m); m = monthStartOf(addDays(m, -1)); }
  const prevOf = (mm: string) => monthStartOf(addDays(mm, -1));
  const monthSum = (mm: string, to?: string) => sum(salesIn(ctx.leads, ...bounds({ from: mm, to: to ?? lastDayOfMonth(mm) }), q), amount);
  const partialDay = dayOfMonth(q.to);
  const isPartial = q.to < lastDayOfMonth(curM);
  const rows = months.map((mm) => {
    const current = mm === curM;
    const value = current ? monthSum(mm, q.to) : monthSum(mm);
    let base: number;
    if (current && isPartial) {
      const pm = prevOf(mm);
      const pEnd = lastDayOfMonth(pm);
      const d = addDays(pm, partialDay - 1);
      base = monthSum(pm, d > pEnd ? pEnd : d);
    } else base = monthSum(prevOf(mm));
    return { month: mm.slice(0, 7), partialDays: current && isPartial ? partialDay : null, value, base, growth: growth(value, base) };
  });
  return { rows, current: rows[rows.length - 1] };
}

function sources(ctx: Ctx, q: Query) {
  const [a, b] = bounds(q);
  const leads = leadsIn(ctx.leads, a, b, q);
  const sales = salesIn(ctx.leads, a, b, q);
  const by = new Map<string, { leads: number; sales: number; sum: number }>();
  const key = (l: Lead) => l.source || '—';
  for (const l of leads) { const r = by.get(key(l)) || { leads: 0, sales: 0, sum: 0 }; r.leads += 1; by.set(key(l), r); }
  for (const l of sales) { const r = by.get(key(l)) || { leads: 0, sales: 0, sum: 0 }; r.sales += 1; r.sum += amount(l); by.set(key(l), r); }
  const salesSum = sum(sales, amount);
  const all = [...by.entries()].map(([name, r]) => ({
    name, ...r,
    share: leads.length ? Math.round((r.leads / leads.length) * 1000) / 10 : 0,
    sumShare: salesSum ? Math.round((r.sum / salesSum) * 1000) / 10 : 0,
  }));
  const byLeads = [...all].sort((x, y) => y.leads - x.leads);
  // Rang tartibi barqaror bo'lsin: lid soni bo'yicha (donut va kanallar bir xil rang).
  const order = byLeads.map((s) => s.name);
  return {
    total: leads.length,
    salesSum,
    order,
    leads: byLeads.filter((s) => s.leads > 0),
    channels: [...all].filter((s) => s.sum > 0 || s.sales > 0).sort((x, y) => y.sum - x.sum),
  };
}

function lost(ctx: Ctx, q: Query, n: Names) {
  const [a, b] = bounds(q);
  const ls = ctx.leads.filter((l) => l.status === 143 && inR(l.closed ?? l.stageAt, a, b) && pass(l, q));
  const withReason = ls.filter((l) => l.lossReason).length;
  const byStage = ls.length > 0 && withReason / ls.length < 0.5;
  const by = new Map<string, number>();
  for (const l of ls) {
    const k = l.lossReason
      ? l.lossReason
      : l.lostFrom != null ? `${n.status(l.pipeline, l.lostFrom)}` : '—';
    by.set(k, (by.get(k) || 0) + 1);
  }
  return {
    total: ls.length,
    byStage,
    withReason,
    rows: [...by.entries()].map(([reason, count]) => ({ reason, count, share: Math.round((count / ls.length) * 1000) / 10 })).sort((x, y) => y.count - x.count).slice(0, 15),
  };
}

const SYSTEM_RE = /admin|cashier|kassir|quality|руковод|control|bot|test/i;

async function managers(ctx: Ctx, q: Query, prev: Range, n: Names) {
  const [a, b] = bounds(q);
  const [pa, pb] = bounds(prev);
  const leads = leadsIn(ctx.leads, a, b, q);
  const sales = salesIn(ctx.leads, a, b, q);
  const pLeads = leadsIn(ctx.leads, pa, pb, q);
  const pSales = salesIn(ctx.leads, pa, pb, q);
  const open = ctx.leads.filter((l) => isOpen(l) && pass(l, q));

  // Menejer ↔ UTel operatori: sozlama, bo'lmasa ism bo'yicha.
  const opNames = await operatorNamesByExt(ctx.companyId);
  const auto = new Map<number, string>();
  const byFirst = new Map<string, string>();
  for (const [ext, name] of opNames) {
    const k = normName(name).split(' ')[0];
    if (k && k.length >= 3) byFirst.set(k, byFirst.has(k) ? '' : ext); // ikki xil operator bir ismda — bog'lamaymiz
  }
  for (const u of ctx.meta?.users ?? []) {
    const k = normName(cleanManagerName(u.name)).split(' ')[0];
    const ext = byFirst.get(k);
    if (ext) auto.set(u.id, ext);
  }
  const extOf = (id: number) => ctx.settings.user_map?.[String(id)] ?? auto.get(id) ?? null;

  let talk = new Map<string, { calls: number; talk: number }>();
  try {
    const items = await reportRpc<Array<{ ext: string | null; calls: number; talk_sec: number }>>('calls_operator_day_stats', {
      p_company_id: ctx.companyId, p_from: dayBounds(q.from).from, p_to: dayBounds(addDays(q.to, 1)).from, p_long_sec: 60,
    });
    talk = new Map((items || []).filter((i) => i.ext).map((i) => [String(i.ext).trim(), { calls: Number(i.calls) || 0, talk: Number(i.talk_sec) || 0 }]));
  } catch { /* qo'ng'iroq statistikasi bo'lmasa ustun bo'sh */ }

  type Row = { id: number | null; name: string; system: boolean; ext: string | null; leads: number; inWork: number; sales: number; sum: number; priced: number; pLeads: number; pSales: number; pSum: number; oldestDays: number | null; calls: number | null; talkSec: number | null; stages: Record<string, number> };
  const rows = new Map<string, Row>();
  const row = (id: number | null): Row => {
    const k = String(id ?? '—');
    let r = rows.get(k);
    if (!r) {
      const u = id != null ? n.userRaw.get(id) : undefined;
      const ext = id != null ? extOf(id) : null;
      const t = ext ? talk.get(ext) : undefined;
      r = {
        id, name: n.user(id), system: id == null || !u || u.active === false || SYSTEM_RE.test(u.name), ext,
        leads: 0, inWork: 0, sales: 0, sum: 0, priced: 0, pLeads: 0, pSales: 0, pSum: 0, oldestDays: null,
        calls: t ? t.calls : null, talkSec: t ? t.talk : null, stages: {},
      };
      rows.set(k, r);
    }
    return r;
  };
  for (const l of leads) {
    const r = row(l.resp);
    r.leads += 1;
    if (q.pipeline != null) r.stages[String(l.status)] = (r.stages[String(l.status)] || 0) + 1;
  }
  for (const l of sales) { const r = row(l.resp); r.sales += 1; r.sum += amount(l); if (amount(l) > 0) r.priced += 1; }
  for (const l of pLeads) row(l.resp).pLeads += 1;
  for (const l of pSales) { const r = row(l.resp); r.pSales += 1; r.pSum += amount(l); }
  for (const l of open) {
    const r = row(l.resp);
    r.inWork += 1;
    const age = Math.floor((q.now - l.created) / 86400_000);
    if (r.oldestDays == null || age > r.oldestDays) r.oldestDays = age;
  }
  const out = [...rows.values()]
    .filter((r) => r.leads || r.sales || r.inWork || r.pSales)
    .map((r) => ({
      ...r,
      conv: r.leads ? Math.round((r.sales / r.leads) * 1000) / 10 : null,
      avg: r.priced ? Math.round(r.sum / r.priced) : null,
      leadsGrowth: growth(r.leads, r.pLeads), salesGrowth: growth(r.sales, r.pSales), sumGrowth: growth(r.sum, r.pSum),
    }))
    .sort((x, y) => y.sum - x.sum || y.sales - x.sales || y.leads - x.leads);
  const total = (list: typeof out) => {
    const s = list.reduce((acc, r) => ({ leads: acc.leads + r.leads, inWork: acc.inWork + r.inWork, sales: acc.sales + r.sales, sum: acc.sum + r.sum, priced: acc.priced + r.priced, calls: acc.calls + (r.calls ?? 0), talkSec: acc.talkSec + (r.talkSec ?? 0) }), { leads: 0, inWork: 0, sales: 0, sum: 0, priced: 0, calls: 0, talkSec: 0 });
    return { ...s, count: list.length, conv: s.leads ? Math.round((s.sales / s.leads) * 1000) / 10 : null, avg: s.priced ? Math.round(s.sum / s.priced) : null };
  };
  const active = out.filter((r) => !r.system);
  const system = out.filter((r) => r.system);
  const pipe = q.pipeline != null ? ctx.meta?.pipelines.find((p) => p.id === q.pipeline) : null;
  return {
    rows: active,
    system: { rows: system, total: total(system) },
    totals: { active: total(active), all: total(out) },
    stages: pipe ? pipe.statuses.filter((s) => s.id !== 143).map((s) => ({ id: s.id, name: s.name })) : null,
  };
}

function creatives(ctx: Ctx, q: Query) {
  const [a, b] = bounds(q);
  const leads = ctx.leads.filter((l) => l.utmContent && inR(l.created, a, b));
  const sales = ctx.leads.filter((l) => l.utmContent && isPaidKind(l.kind) && inR(l.firstPaid, a, b));
  const by = new Map<string, { leads: number; sales: number; sum: number }>();
  for (const l of leads) { const r = by.get(l.utmContent!) || { leads: 0, sales: 0, sum: 0 }; r.leads += 1; by.set(l.utmContent!, r); }
  for (const l of sales) { const r = by.get(l.utmContent!) || { leads: 0, sales: 0, sum: 0 }; r.sales += 1; r.sum += amount(l); by.set(l.utmContent!, r); }
  const rows = [...by.entries()].map(([id, r]) => ({ id, ...r })).sort((x, y) => y.sales - x.sales || y.leads - x.leads);
  return {
    metaConnected: false,
    rows: rows.slice(0, 20),
    total: rows.length,
    withSales: rows.filter((r) => r.sales > 0).length,
    noResult: rows.filter((r) => r.sales === 0 && r.leads >= 5).length,
  };
}

async function aiCalls(ctx: Ctx, q: Query) {
  const start = dayBounds(q.from).from;
  const end = dayBounds(addDays(q.to, 1)).from;
  type C = { id: string; operator_ext: string | null; created_at: string; duration: number | null; kpi_score: number | null; client_phone: string | null; new_leads_count: number | null; bad_leads_count: number | null };
  const calls: C[] = [];
  for (let off = 0; off < 20_000; off += 1000) {
    const { data, error } = await supabase
      .from('calls').select('id, operator_ext, created_at, duration, kpi_score, client_phone, new_leads_count, bad_leads_count')
      .eq('company_id', ctx.companyId).gte('created_at', start).lt('created_at', end)
      .order('created_at', { ascending: true }).range(off, off + 999);
    if (error) throw new Error(error.message);
    calls.push(...((data || []) as C[]));
    if (!data || data.length < 1000) break;
  }
  const analyzed = calls.filter((c) => Number(c.kpi_score) > 0);
  const paidPhones = new Set(ctx.leads.filter((l) => isPaidKind(l.kind) && l.phone9).map((l) => l.phone9!));
  const p9 = (s: string | null) => { const d = String(s ?? '').replace(/\D/g, ''); return d.length >= 9 ? d.slice(-9) : null; };
  const results = new Map<string, number>();
  const topics = new Map<string, number>();
  const seen = new Set<string>();
  const ops = new Map<string, { sum: number; count: number }>();
  for (const c of calls) {
    const ph = p9(c.client_phone);
    const repeat = ph ? seen.has(ph) : false;
    if (ph) seen.add(ph);
    if (!(Number(c.kpi_score) > 0)) continue;
    const res = ph && paidPhones.has(ph) ? 'paid' : Number(c.bad_leads_count) > 0 ? 'unqualified' : Number(c.new_leads_count) > 0 ? 'qualified' : 'unknown';
    results.set(res, (results.get(res) || 0) + 1);
    const topic = Number(c.duration) > 0 && Number(c.duration) < 120 ? 'short' : repeat ? 'followup' : 'sales';
    topics.set(topic, (topics.get(topic) || 0) + 1);
    const ext = String(c.operator_ext ?? '').trim();
    if (ext) { const o = ops.get(ext) || { sum: 0, count: 0 }; o.sum += Number(c.kpi_score) / 10; o.count += 1; ops.set(ext, o); }
  }
  const names = await operatorNamesByExt(ctx.companyId);
  const pct = (x: number) => (analyzed.length ? Math.round((x / analyzed.length) * 1000) / 10 : 0);
  const avg = analyzed.length ? Math.round((analyzed.reduce((s, c) => s + Number(c.kpi_score), 0) / analyzed.length)) / 10 : null;
  return {
    total: calls.length,
    analyzed: analyzed.length,
    coverage: calls.length ? Math.round((analyzed.length / calls.length) * 1000) / 10 : null,
    lastAt: analyzed.length ? analyzed[analyzed.length - 1].created_at : null,
    avg,
    results: [...results.entries()].map(([key, count]) => ({ key, count, share: pct(count) })).sort((x, y) => y.count - x.count),
    topics: [...topics.entries()].map(([key, count]) => ({ key, count })).sort((x, y) => y.count - x.count),
    operators: [...ops.entries()].map(([ext, o]) => ({ ext, name: names.get(ext) || `Operator ${ext}`, score: Math.round((o.sum / o.count) * 10) / 10, count: o.count })).sort((x, y) => y.score - x.score),
  };
}

const POTENTIAL_RE = /hisob raqam yuborildi|shartnoma berildi|o'qiydigan bo'ldi|aniq o'qi|uchrashuvga keldi|konsultatsiya o'tkazildi|probniy darsga keldi/;

function launch(ctx: Ctx, q: Query, plans: Plan[], n: Names) {
  const today = tashkentDay(new Date(q.now));
  const list = plans.filter((p) => p.kind === 'launch').sort((x, y) => y.period_to.localeCompare(x.period_to));
  const p = list.find((x) => x.period_from <= today && x.period_to >= today) ?? list[0];
  if (!p) return { plan: null };
  const f: Filter = { pipeline: p.pipeline_id, group: null };
  const r: Range = { from: p.period_from, to: p.period_to };
  const [a, b] = bounds(r);
  const sales = salesIn(ctx.leads, a, b, f);
  const s = salesStats(sales);
  const potentialIds = new Set(ctx.settings.potential_status_ids ?? []);
  const isPotential = (l: Lead) => isOpen(l) && pass(l, f) && (potentialIds.size
    ? potentialIds.has(l.status)
    : POTENTIAL_RE.test(normName(n.status(l.pipeline, l.status))));
  const potLeads = ctx.leads.filter(isPotential);
  const avg = s.avg ?? 0;
  const potential = potLeads.length * avg;
  const total = daysBetween(p.period_from, p.period_to) + 1;
  const day = Math.min(total, Math.max(0, daysBetween(p.period_from, today) + 1));
  const left = Math.max(0, total - day);
  const toPlan = Math.max(0, p.amount - s.sum);
  const created = leadsIn(ctx.leads, a, b, f);

  const byPipe = new Map<number, { leads: number; sold: number; agreed: number; paid: number; expected: number; potential: number }>();
  const pr = (id: number) => { let x = byPipe.get(id); if (!x) { x = { leads: 0, sold: 0, agreed: 0, paid: 0, expected: 0, potential: 0 }; byPipe.set(id, x); } return x; };
  for (const l of created) pr(l.pipeline).leads += 1;
  for (const l of sales) { const x = pr(l.pipeline); x.sold += 1; x.agreed += amount(l); x.paid += l.price; x.expected += l.debt; }
  for (const l of potLeads) pr(l.pipeline).potential += 1;
  const byMgr = new Map<string, { name: string; sold: number; agreed: number; paid: number; expected: number }>();
  for (const l of sales) {
    const k = String(l.resp ?? '—');
    const x = byMgr.get(k) || { name: n.user(l.resp), sold: 0, agreed: 0, paid: 0, expected: 0 };
    x.sold += 1; x.agreed += amount(l); x.paid += l.price; x.expected += l.debt;
    byMgr.set(k, x);
  }
  const unpaidFull = sales.filter((l) => l.kind === 'full' && l.debt > 0);
  return {
    plan: p,
    day, totalDays: total, daysLeft: left,
    fact: s.sum, paid: s.paid, expected: s.debt,
    potential, potentialLeads: potLeads.length, avgCheck: avg,
    toPlan, perDay: left > 0 ? Math.round(toPlan / left) : toPlan,
    factPct: p.amount ? Math.round((s.sum / p.amount) * 1000) / 10 : null,
    totalPotential: s.paid + s.debt + potential,
    totalPotentialPct: p.amount ? Math.round(((s.paid + s.debt + potential) / p.amount) * 1000) / 10 : null,
    timePct: Math.round((day / total) * 1000) / 10,
    pipelines: [...byPipe.entries()].map(([id, x]) => ({ id, name: n.pipeline(id), ...x })).filter((x) => x.leads || x.sold || x.potential).sort((x, y) => y.agreed - x.agreed || y.leads - x.leads),
    managers: [...byMgr.values()].sort((x, y) => y.agreed - x.agreed),
    warnings: { unpaidFull: { count: unpaidFull.length, sum: sum(unpaidFull, (l) => l.debt) }, lost: created.filter((l) => l.status === 143).length },
  };
}

/** Raqamlardan xulosa va tavsiyalar (qoidalar bo'yicha). Kalit + qiymatlar — matn frontendda tarjima qilinadi. */
export function insights(w: { kpis: ReturnType<typeof kpis>; debt: ReturnType<typeof debt>; lost: ReturnType<typeof lost>; sources: ReturnType<typeof sources>; managers: Awaited<ReturnType<typeof managers>> | null; ai: Awaited<ReturnType<typeof aiCalls>> | null; pending: number }) {
  const facts: Array<{ key: string; v: Record<string, string | number> }> = [];
  const recs: Array<{ key: string; v: Record<string, string | number> }> = [];
  const k = w.kpis;
  facts.push(k.salesSum.prev > 0
    ? { key: 'sales', v: { sum: k.salesSum.value, n: k.salesCount.value, pct: k.salesSum.growth.pct ?? 0 } }
    : { key: 'salesNoPrev', v: { sum: k.salesSum.value, n: k.salesCount.value } });
  if (k.conversion.value != null) facts.push({ key: 'conversion', v: { p: k.conversion.value, leads: k.leads.value } });
  const top = w.sources.leads.find((s) => s.name !== '—');
  if (top) facts.push({ key: 'topSource', v: { name: top.name, p: top.share } });
  const best = w.managers?.rows[0];
  if (best && best.sum > 0) facts.push({ key: 'bestManager', v: { name: best.name, sum: best.sum } });
  if (w.debt.total > 0) facts.push({ key: 'debt', v: { sum: w.debt.total, n: w.debt.count } });
  if (w.lost.total > 0 && w.lost.rows[0]) facts.push({ key: 'lostTop', v: { reason: w.lost.rows[0].reason, p: w.lost.rows[0].share, n: w.lost.total } });

  if (w.lost.total > 0 && w.lost.byStage) recs.push({ key: 'fillLossReason', v: { p: Math.round(((w.lost.total - w.lost.withReason) / w.lost.total) * 100) } });
  if (k.avgCheck.noPrice > 0) recs.push({ key: 'fillPrice', v: { n: k.avgCheck.noPrice } });
  if (w.pending > 0) recs.push({ key: 'checkReceipts', v: { n: w.pending } });
  if (w.debt.total > 0 && w.debt.managers[0]) recs.push({ key: 'collectDebt', v: { name: w.debt.managers[0].name, sum: w.debt.managers[0].sum } });
  const unknown = w.sources.leads.find((s) => s.name === '—');
  if (unknown && unknown.share >= 20) recs.push({ key: 'fillSource', v: { p: unknown.share } });
  if (k.conversion.value != null && k.conversion.value < 3 && k.leads.value >= 50) recs.push({ key: 'lowConversion', v: { p: k.conversion.value } });
  const stale = w.managers?.rows.filter((r) => (r.oldestDays ?? 0) > 30) ?? [];
  if (stale.length) recs.push({ key: 'staleLeads', v: { n: stale.length, d: Math.max(...stale.map((r) => r.oldestDays ?? 0)) } });
  if (w.ai && w.ai.total > 20 && (w.ai.coverage ?? 0) < 50) recs.push({ key: 'aiCoverage', v: { p: w.ai.coverage ?? 0 } });
  return { facts, recs };
}

async function loadPlans(companyId: string): Promise<Plan[]> {
  const { data, error } = await supabase
    .from('crm_plans').select('id, kind, pipeline_id, title, period_from, period_to, amount')
    .eq('company_id', companyId).order('period_to', { ascending: false }).limit(200);
  if (error) return [];
  return ((data || []) as any[]).map((p) => ({ ...p, pipeline_id: p.pipeline_id != null ? Number(p.pipeline_id) : null, amount: Number(p.amount) || 0 }));
}

/** Har vidjet alohida: bittasi yiqilsa qolganlari ishlaydi. */
async function safe<T>(fn: () => T | Promise<T>): Promise<T | { error: string }> {
  try { return await fn(); } catch (e: any) { return { error: String(e?.message || e).slice(0, 200) }; }
}
const ok = <T,>(v: T | { error: string }): T | null => (v && typeof v === 'object' && 'error' in (v as any) ? null : (v as T));

export async function buildSalesDashboard(companyId: string, q: Query) {
  const ctx = await loadContext(companyId);
  if (ctx === 'not_ready') return { ready: false as const };
  if (!ctx) return { ready: true as const, connected: false as const };
  const n = namesOf(ctx.meta);
  const prev = previousRange(q);
  const plans = await loadPlans(companyId);
  const [k, pf, dt, fn, dy, fd, cmp, src, ls, mg, cr, ai, ln] = await Promise.all([
    safe(() => kpis(ctx, q, prev)),
    safe(() => planFact(ctx, q, plans)),
    safe(() => debt(ctx, n)),
    safe(() => funnel(ctx, q, n)),
    safe(() => dynamics(ctx, q, prev)),
    safe(() => fieldDistribution(ctx, q)),
    safe(() => comparison(ctx, q)),
    safe(() => sources(ctx, q)),
    safe(() => lost(ctx, q, n)),
    safe(() => managers(ctx, q, prev, n)),
    safe(() => creatives(ctx, q)),
    safe(() => aiCalls(ctx, q)),
    safe(() => launch(ctx, q, plans, n)),
  ]);
  const kk = ok(k);
  const srcOk = ok(src);
  const mgOk = ok(mg);
  const [a, b] = bounds(q);
  const pending = salesIn(ctx.leads, a, b, q).filter((l) => l.kind === 'pending').length;
  const quick = kk && srcOk ? {
    bestManager: mgOk?.rows[0] && mgOk.rows[0].sum > 0 ? { name: mgOk.rows[0].name, sum: mgOk.rows[0].sum, sales: mgOk.rows[0].sales } : null,
    topSource: srcOk.leads.find((s) => s.name !== '—') ?? null,
    avgCheck: kk.avgCheck.value,
    conversion: kk.conversion.value,
  } : { error: 'kpis' };
  const ins = kk && srcOk && ok(dt) && ok(ls)
    ? await safe(() => insights({ kpis: kk, debt: ok(dt)!, lost: ok(ls)!, sources: srcOk, managers: mgOk, ai: ok(ai), pending }))
    : { error: 'kpis' };
  return {
    ready: true as const,
    connected: true as const,
    meta: {
      pull_at: ctx.pullAt,
      pull_error: ctx.pullError,
      leads_total: ctx.leads.length,
      subdomain: ctx.subdomain,
      pipelines: (ctx.meta?.pipelines ?? []).map((p) => ({ id: p.id, name: p.name })),
      groups: ctx.meta?.groups ?? [],
      range: { from: q.from, to: q.to },
      prev,
    },
    widgets: { kpis: k, planFact: pf, debt: dt, funnel: fn, dynamics: dy, field: fd, comparison: cmp, quick, lost: ls, sources: src, managers: mg, creatives: cr, ai, launch: ln, insights: ins },
  };
}

/** Ctrl+K: bitim nomi, ID yoki telefon bo'yicha. */
export async function searchLeads(companyId: string, text: string) {
  const ctx = await loadContext(companyId);
  if (!ctx || ctx === 'not_ready') return [];
  const n = namesOf(ctx.meta);
  const s = normName(text);
  const digits = text.replace(/\D/g, '');
  if (!s) return [];
  const host = ctx.subdomain.includes('.') ? ctx.subdomain : `${ctx.subdomain}.amocrm.ru`;
  return ctx.leads
    .filter((l) => String(l.id) === digits || (digits.length >= 5 && l.phone9?.includes(digits.slice(-9))) || normName(l.name).includes(s))
    .sort((x, y) => y.created - x.created)
    .slice(0, 20)
    .map((l) => ({
      id: l.id, name: l.name, pipeline: n.pipeline(l.pipeline), stage: n.status(l.pipeline, l.status), kind: l.kind,
      amount: amount(l), debt: l.debt, manager: n.user(l.resp), created: new Date(l.created).toISOString(),
      url: ctx.subdomain ? `https://${host}/leads/detail/${l.id}` : null,
    }));
}
