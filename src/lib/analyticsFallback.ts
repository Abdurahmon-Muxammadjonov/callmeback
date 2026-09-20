import { supabase, fetchAllRows } from './supabase';

// supabase/tenant_scoped_aggregates.sql ishga tushirilMAGAN bo'lsa (DB'dagi
// calls_pop_stats / calls_relationship_dynamics hali p_manager_ids
// parametrini bilmaydi -> PostgREST PGRST202 "function not found"), shu
// yerdagi Node hisob-kitobi ishlatiladi — BIR XIL JSON shakl, BIR XIL
// tenant chegarasi (faqat berilgan manager_id'lar). SQL ishga tushirilgach
// route'lar avtomatik tez (DB) yo'lga qaytadi. Boshqa tenant ma'lumotini
// "vaqtincha" ko'rsatish o'rniga shu fallback — xavfsiz va dashboard ishlaydi.
//
// Hisob mantiqi supabase/pop_stats.sql va optimize_analytics_aggregates.sql
// bilan bir xil (UTC, now() asosida). Oyna bitta kompaniyaning oxirgi ~2 oyi
// bilan cheklangan, shu sabab Node'ga tortish hajmi katta emas.

export function isMissingFunctionError(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return error.code === 'PGRST202' || /could not find the function|no matches were found/i.test(error.message || '');
}

function popPct(cur: number, prev: number): number {
  if (!prev) return cur > 0 ? 100 : 0;
  return Math.round(((cur - prev) / prev) * 1000) / 10;
}
const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

function startOfDayUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
// Postgres date_trunc('week') — dushanba.
function startOfWeekUTC(d: Date): Date {
  const day = startOfDayUTC(d);
  const dow = (day.getUTCDay() + 6) % 7; // dushanba=0
  day.setUTCDate(day.getUTCDate() - dow);
  return day;
}
function startOfMonthUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}
function minus(d: Date, ms: number): Date { return new Date(d.getTime() - ms); }
function minusMonths(d: Date, n: number): Date {
  const c = new Date(d);
  c.setUTCMonth(c.getUTCMonth() - n);
  return c;
}
const DAY = 24 * 60 * 60 * 1000;

interface CallLite { created_at: string; duration: number | null; kpi_score: number | null; unanswered_count?: number | null; bad_leads_count?: number | null }

async function loadCalls(managerIds: string[], since: Date, columns: string): Promise<CallLite[]> {
  if (managerIds.length === 0) return [];
  // select(columns) dinamik satr bo'lgani uchun supabase-js qator tipini
  // chiqara olmaydi — shu sabab `as any`.
  return fetchAllRows<CallLite>((from, to) =>
    supabase.from('calls').select(columns).in('manager_id', managerIds).gte('created_at', since.toISOString()).range(from, to) as any);
}

function agg(rows: CallLite[], from: Date, to?: Date) {
  const f = from.getTime();
  const t = to?.getTime();
  const sel = rows.filter((r) => { const x = new Date(r.created_at).getTime(); return x >= f && (t === undefined || x < t); });
  const calls = sel.length;
  const dur = sel.reduce((a, r) => a + (Number(r.duration) || 0), 0);
  const kpis = sel.map((r) => r.kpi_score).filter((k): k is number => k !== null && k !== undefined);
  const kpi = kpis.length ? kpis.reduce((a, k) => a + Number(k), 0) / kpis.length : 0;
  return { calls, dur, kpi };
}

function popBlock(cur: ReturnType<typeof agg>, prev: ReturnType<typeof agg>) {
  return {
    calls: { current: cur.calls, previous: prev.calls, change_pct: popPct(cur.calls, prev.calls) },
    duration_minutes: { current: round1(cur.dur / 60), previous: round1(prev.dur / 60), change_pct: popPct(cur.dur, prev.dur) },
    avg_kpi: { current: round2(cur.kpi), previous: round2(prev.kpi), change_pct: popPct(cur.kpi, prev.kpi) },
  };
}

export async function popStatsInNode(managerIds: string[]): Promise<Record<string, unknown>> {
  const now = new Date();
  const monthStart = startOfMonthUTC(now);
  const since = minusMonths(monthStart, 1);
  const rows = await loadCalls(managerIds, since, 'created_at, duration, kpi_score');

  const dayStart = startOfDayUTC(now);
  const weekStart = startOfWeekUTC(now);

  return {
    daily: popBlock(agg(rows, dayStart), agg(rows, minus(dayStart, DAY), minus(now, DAY))),
    weekly: popBlock(agg(rows, weekStart), agg(rows, minus(weekStart, 7 * DAY), minus(now, 7 * DAY))),
    monthly: popBlock(agg(rows, monthStart), agg(rows, minusMonths(monthStart, 1), minusMonths(now, 1))),
    generated_at: now.toISOString(),
  };
}

export async function relationshipDynamicsInNode(managerIds: string[], platformId: string | null): Promise<unknown[]> {
  const now = new Date();
  const today = startOfDayUTC(now);
  const since = minus(today, 13 * DAY);
  let rows = await loadCalls(managerIds, since, 'created_at, duration, kpi_score, unanswered_count, bad_leads_count, platform_id');
  if (platformId) rows = rows.filter((r: any) => r.platform_id === platformId);

  // kun -> {u, b}
  const daily = new Map<number, { u: number; b: number }>();
  for (const r of rows) {
    const d = startOfDayUTC(new Date(r.created_at)).getTime();
    const cur = daily.get(d) || { u: 0, b: 0 };
    cur.u += Number(r.unanswered_count) || 0;
    cur.b += Number(r.bad_leads_count) || 0;
    daily.set(d, cur);
  }
  const sum = (from: Date, to: Date | null, k: 'u' | 'b') => {
    let s = 0;
    for (const [d, v] of daily) if (d >= from.getTime() && (to === null || d < to.getTime())) s += v[k];
    return s;
  };
  const spark = (k: 'u' | 'b') => Array.from({ length: 7 }, (_, i) => daily.get(minus(today, (6 - i) * DAY).getTime())?.[k] ?? 0);

  const block = (key: string, label: string, k: 'u' | 'b') => ({
    key, label,
    today: sum(today, null, k),
    yesterday: sum(minus(today, DAY), today, k),
    week: sum(minus(today, 6 * DAY), null, k),
    lastWeek: sum(minus(today, 13 * DAY), minus(today, 6 * DAY), k),
    spark: spark(k),
    lowerIsBetter: true,
  });

  return [block('unanswered', 'Javobsiz qoldirilgan', 'u'), block('bad_leads', 'Sifatsiz lidlar', 'b')];
}
