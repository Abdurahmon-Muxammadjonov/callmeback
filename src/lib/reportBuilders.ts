import { deriveFaults } from './coaching';
import { addDays, mondayOf, monthStartOf, minusMonthsTashkent, tashkentDay, tashkentDayStart } from './tashkentTime';
import { virtualManagerId } from './virtualOperators';

export { addDays };

// ============================================================================
// HISOBOT JSON QURUVCHILARI (2026-10-12).
//
// Og'ir sanash endi Postgres funksiyalarida (supabase/perf_*.sql) — bu yerda
// faqat ularning kichik natijasidan endpoint javobi yig'iladi. Funksiyalar
// SOF (bazaga murojaat qilmaydi), shu sabab test qilish va eski Node hisobi
// bilan solishtirish oson.
//
// Yaxlitlash, foiz, saralash va maydon tartibi eski Node kodidan AYNAN
// ko'chirilgan — JSON shakli (maydon nomlari, tiplari) o'zgarmasin.
// ============================================================================

/** PostgREST bigint/numeric'ni son qilib beradi; ehtiyot uchun Number(). */
const num = (v: unknown): number => Number(v) || 0;
const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
const minutesOf = (seconds: number) => Math.round((seconds / 60) * 10) / 10;
/** Teng qiymatlarda barqaror tartib uchun ikkinchi kalit (localeCompare emas — oddiy). */
const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// BARQAROR TARTIB (2026-10-12): eski kodda teng qiymatli elementlar
// (masalan bir xil ball yo'qotgan ikki xato) qatorlar bazadan qaysi
// tartibda kelsa, shunday turardi — har yangilanishda o'rni almashib,
// top-6 ga goh biri, goh boshqasi tushardi. Endi hamma saralashda
// ikkinchi kalit bor: bir xil ma'lumot => doim bir xil javob.

const DAY_MS = 24 * 60 * 60 * 1000;

// ----------------------------------------------------------------------------
// /analytics/pop va /analytics/overview — calls_range_stats (perf_02)
// ----------------------------------------------------------------------------

export interface TimeRange { from: Date; to: Date | null }
export interface RangeStatRow {
  idx: number; calls: number; operator_calls: number; seconds: number; kpi_sum: number; kpi_n: number;
}

function minus(d: Date, ms: number): Date { return new Date(d.getTime() - ms); }

/**
 * PoP oynalari, tartib: kun (joriy, oldingi), hafta (joriy, oldingi),
 * oy (joriy, oldingi). Oldingi davr ham "shu vaqtgacha" olinadi —
 * adolatli solishtirish uchun.
 *
 * KUN/HAFTA/OY TOSHKENT BO'YICHA (2026-10-12). Avval UTC edi: Toshkent
 * 00:00–05:00 dagi qo'ng'iroqlar overview'da "kecha"ga tushar va
 * daily-summary bilan bir xil kun boshqa son ko'rsatardi. Hafta —
 * dushanbadan. Oldingi oy oynasining oxiri Toshkent devor soati bo'yicha
 * "1 oy oldin" (31-sana => oy oxiri); eski JS setUTCMonth 31-martda
 * 3-martni berib, joriy oyning qatorlarini "o'tgan oy"ga qo'shib yuborardi.
 *
 * Joriy oyna davr OXIRIGACHA (keyingi kun/hafta/oy boshi) — avval
 * chegarasiz edi: soati noto'g'ri, kelajak sanali qator overview'ning
 * "bugun"iga tushib, daily-summary'dagi o'sha kundan farq qilardi.
 */
export function popRanges(now: Date): TimeRange[] {
  const today = tashkentDay(now);
  const dayStart = tashkentDayStart(today);
  const weekStart = tashkentDayStart(mondayOf(today));
  const monthStart = tashkentDayStart(monthStartOf(today));
  const prevMonthStart = minusMonthsTashkent(monthStart, 1);
  const nextMonthStart = minusMonthsTashkent(monthStart, -1);
  return [
    { from: dayStart, to: tashkentDayStart(addDays(today, 1)) },
    { from: minus(dayStart, DAY_MS), to: minus(now, DAY_MS) },
    { from: weekStart, to: tashkentDayStart(addDays(mondayOf(today), 7)) },
    { from: minus(weekStart, 7 * DAY_MS), to: minus(now, 7 * DAY_MS) },
    { from: monthStart, to: nextMonthStart },
    { from: prevMonthStart, to: minusMonthsTashkent(now, 1) },
  ];
}

/** calls_range_stats uchun p_ranges argumenti. */
export function rangesArg(ranges: TimeRange[]): Array<{ from: string; to: string | null }> {
  return ranges.map((r) => ({ from: r.from.toISOString(), to: r.to ? r.to.toISOString() : null }));
}

function popPct(cur: number, prev: number): number {
  if (!prev) return cur > 0 ? 100 : 0;
  return Math.round(((cur - prev) / prev) * 1000) / 10;
}

function rangeAgg(r: RangeStatRow | undefined) {
  const kpiN = num(r?.kpi_n);
  return {
    calls: num(r?.calls), opCalls: num(r?.operator_calls),
    dur: num(r?.seconds), kpi: kpiN ? num(r?.kpi_sum) / kpiN : 0,
  };
}

function popBlock(cur: ReturnType<typeof rangeAgg>, prev: ReturnType<typeof rangeAgg>) {
  return {
    calls: { current: cur.calls, previous: prev.calls, change_pct: popPct(cur.calls, prev.calls) },
    // calls — BARCHA qo'ng'iroqlar; operator_calls — faqat operatorniki
    // (ichki raqami yoki xodimi bor). Bir maydon ikki ma'noda ishlatilmaydi.
    operator_calls: { current: cur.opCalls, previous: prev.opCalls, change_pct: popPct(cur.opCalls, prev.opCalls) },
    duration_minutes: { current: round1(cur.dur / 60), previous: round1(prev.dur / 60), change_pct: popPct(cur.dur, prev.dur) },
    avg_kpi: { current: round2(cur.kpi), previous: round2(prev.kpi), change_pct: popPct(cur.kpi, prev.kpi) },
  };
}

export function buildPopStats(rows: RangeStatRow[], now: Date): Record<string, unknown> {
  const at = (i: number) => rangeAgg(rows.find((r) => num(r.idx) === i));
  return {
    daily: popBlock(at(0), at(1)),
    weekly: popBlock(at(2), at(3)),
    monthly: popBlock(at(4), at(5)),
    generated_at: now.toISOString(),
  };
}

// ----------------------------------------------------------------------------
// Kunlik / soatlik kesim — calls_bucket_stats (perf_03)
// ----------------------------------------------------------------------------

export interface BucketRow {
  day: string; hour: number | null;
  calls: number; operator_calls: number; seconds: number; long_calls: number;
  with_transcript: number; analyzed_any: number;
  scored: number; score_sum: number; low_score: number;
  kpi_sum: number; low_any: number; penalized: number;
  incoming: number; outgoing: number;
  invited: number; closed: number; bad_leads: number; unanswered: number;
  lead_phones: number; leads_no_phone: number;
  penalty_sum: number; bonus_sum: number;
}

/** /analytics/daily-summary javobidagi `data` (yangi kun yuqorida). */
export function buildDailySummary(rows: BucketRow[]) {
  return [...rows]
    .sort((x, y) => y.day.localeCompare(x.day))
    .map((r) => {
      const scored = num(r.scored);
      return {
        date: r.day,
        calls: num(r.calls),
        operator_calls: num(r.operator_calls),
        minutes: minutesOf(num(r.seconds)),
        analyzed: num(r.with_transcript),
        scored,
        avg_score: scored ? Math.round(num(r.score_sum) / scored) : 0, // 0-100
        low_score: num(r.low_score),
        long_calls: num(r.long_calls),
        incoming: num(r.incoming),
        outgoing: num(r.outgoing),
        leads: num(r.lead_phones) + num(r.leads_no_phone),
        invited: num(r.invited),
        closed: num(r.closed),
        bad_leads: num(r.bad_leads),
        unanswered: num(r.unanswered),
        penalty_sum: Math.round(num(r.penalty_sum)),
        bonus_sum: Math.round(num(r.bonus_sum)),
      };
    });
}

/** /analytics/hourly javobidagi `data` — 0..23 har soat (bo'sh soat nol bilan). */
export function buildHourly(rows: BucketRow[]) {
  const hours = Array.from({ length: 24 }, (_, hour) => ({
    hour, calls: 0, operator_calls: 0, long_calls: 0, analyzed: 0, talk_seconds: 0,
  }));
  for (const r of rows) {
    const h = hours[num(r.hour)];
    if (!h) continue;
    h.calls += num(r.calls);
    h.operator_calls += num(r.operator_calls);
    h.long_calls += num(r.long_calls);
    h.analyzed += num(r.analyzed_any);
    h.talk_seconds += num(r.seconds);
  }
  return hours;
}

// ----------------------------------------------------------------------------
// /api/management/relationship-dynamics — calls_bucket_stats (perf_03)
// ----------------------------------------------------------------------------

/** today — hisobot kuni "YYYY-MM-DD"; rows — shu kundan 13 kun oldingidan beri. */
export function buildRelationshipDynamics(
  rows: Array<Pick<BucketRow, 'day' | 'unanswered' | 'bad_leads'>>,
  today: string,
): unknown[] {
  const daily = new Map<string, { u: number; b: number }>();
  for (const r of rows) {
    const cur = daily.get(r.day) || { u: 0, b: 0 };
    cur.u += num(r.unanswered);
    cur.b += num(r.bad_leads);
    daily.set(r.day, cur);
  }
  const sum = (from: string, to: string | null, k: 'u' | 'b') => {
    let s = 0;
    for (const [d, v] of daily) if (d >= from && (to === null || d < to)) s += v[k];
    return s;
  };
  const spark = (k: 'u' | 'b') => Array.from({ length: 7 }, (_, i) => daily.get(addDays(today, -(6 - i)))?.[k] ?? 0);

  const block = (key: string, label: string, k: 'u' | 'b') => ({
    key, label,
    today: sum(today, null, k),
    yesterday: sum(addDays(today, -1), today, k),
    week: sum(addDays(today, -6), null, k),
    lastWeek: sum(addDays(today, -13), addDays(today, -6), k),
    spark: spark(k),
    lowerIsBetter: true,
  });

  return [block('unanswered', 'Javobsiz qoldirilgan', 'u'), block('bad_leads', 'Sifatsiz lidlar', 'b')];
}

// ----------------------------------------------------------------------------
// /api/management/conversion-history — company_conversions_daily (perf_10)
// + kunlik qo'ng'iroqlar calls_bucket_stats (perf_03)
// ----------------------------------------------------------------------------

/** traffic_avg/sales_avg bazada 2 xonagacha aniq yaxlitlangan (perf_10). */
export interface ConversionDayRow { day: string; conv_n: number; traffic_avg: number; sales_avg: number }

export function buildConversionHistory(
  convRows: ConversionDayRow[],
  callRows: Array<Pick<BucketRow, 'day' | 'calls' | 'operator_calls'>>,
  days: number,
  today: string,
) {
  const conv = new Map(convRows.map((r) => [r.day, r]));
  const calls = new Map<string, number>();
  const opCalls = new Map<string, number>();
  for (const r of callRows) {
    calls.set(r.day, (calls.get(r.day) || 0) + num(r.calls));
    opCalls.set(r.day, (opCalls.get(r.day) || 0) + num(r.operator_calls));
  }
  return Array.from({ length: days }, (_, i) => {
    const date = addDays(today, -(days - 1 - i));
    const a = conv.get(date);
    const n = num(a?.conv_n);
    return {
      date,
      traffic_conversion: n ? num(a?.traffic_avg) : 0,
      sales_conversion: n ? num(a?.sales_avg) : 0,
      calls: calls.get(date) || 0,                   // BARCHA qo'ng'iroqlar
      operator_calls: opCalls.get(date) || 0,        // faqat operator qo'ng'iroqlari
    };
  });
}

// ----------------------------------------------------------------------------
// /api/management/daily-panel — "Boshqaruv paneli" (perf_03 soatlik + perf_04)
// ----------------------------------------------------------------------------

const round2Money = (n: number) => Math.round(n * 100) / 100;

/**
 * NEGA (2026-10-12): panel avval 14 kunlik BARCHA qo'ng'iroqni /api/calls'dan
 * 200 tadan offset bilan (~90 ketma-ket so'rov) tortib brauzerda sanardi.
 * Sahifalash paytida yangi qo'ng'iroq kelsa sahifalar surilib, bir qator
 * ikki marta sanalardi — "Bugungi qo'ng'iroqlar" o'zidan o'zgarib turardi;
 * vaqt intervallari esa BRAUZER soati bo'yicha edi. Endi hammasi serverda,
 * Toshkent bo'yicha, boshqa hisobotlar bilan bir xil ta'rifda.
 *
 *   days[0] = bugun ... days[n-1]; har kun:
 *     calls / operator_calls — daily-summary bilan bir xil
 *     kpi_sum   — barcha qo'ng'iroqlar kpi yig'indisi (panel o'rtachasi = kpi_sum / calls)
 *     seconds   — sum(max(0, duration))
 *     low       — kpi < 50 (baholanmaganlar ham — panelning eski ta'rifi)
 *     penalized — jarimali qo'ng'iroqlar soni
 *     short     — uzun bo'lmaganlar = calls - long_calls (chegara KPI normalaridan)
 *     bonus_sum / penalty_sum
 *   hours[h]   — oyna bo'yicha h-soatdagi qo'ng'iroqlar (Toshkent soati)
 *   today_by_manager — bugungi qo'ng'iroqlar xodim (yoki virtual operator) id bo'yicha
 */
export function buildDailyPanel(
  dayRows: BucketRow[],
  hourRows: BucketRow[],
  dayItems: OperatorDailyItem[],
  companyId: string,
  anchor: string,
  windowDays: number,
) {
  const blankDay = (date: string) => ({
    date, calls: 0, operator_calls: 0, kpi_sum: 0, seconds: 0, low: 0, penalized: 0, short: 0,
    bonus_sum: 0, penalty_sum: 0,
    // 2026-10-14: Pulse Boshqaruv paneli uchun qo'shimcha maydonlar.
    long_calls: 0, scored: 0, score_sum: 0, low_scored: 0, unanswered: 0, bad_leads: 0,
    leads: 0, invited: 0, closed: 0, incoming: 0, outgoing: 0,
  });
  const index = new Map<string, number>();
  const days = Array.from({ length: windowDays }, (_, i) => {
    const date = addDays(anchor, -i);
    index.set(date, i);
    return blankDay(date);
  });
  const monthFrom = `${anchor.slice(0, 7)}-01`;
  const month = { from: monthFrom, to: anchor, calls: 0, long_calls: 0, leads: 0, invited: 0, closed: 0 };

  for (const r of dayRows) {
    if (r.day >= monthFrom && r.day <= anchor) {
      month.calls += num(r.calls);
      month.long_calls += num(r.long_calls);
      month.leads += num(r.lead_phones) + num(r.leads_no_phone);
      month.invited += num(r.invited);
      month.closed += num(r.closed);
    }
    const i = index.get(r.day);
    if (i === undefined) continue; // oynadan tashqari (oy boshi uchun olingan kunlar yoki kelajak sanali qator)
    const d = days[i];
    const calls = num(r.calls);
    d.calls += calls;
    d.operator_calls += num(r.operator_calls);
    d.kpi_sum += num(r.kpi_sum);
    d.seconds += num(r.seconds);
    d.low += num(r.low_any);
    d.penalized += num(r.penalized);
    d.short += calls - num(r.long_calls);
    d.bonus_sum = round2Money(d.bonus_sum + num(r.bonus_sum));
    d.penalty_sum = round2Money(d.penalty_sum + num(r.penalty_sum));
    d.long_calls += num(r.long_calls);
    d.scored += num(r.scored);
    d.score_sum += num(r.score_sum);
    // low — eski panel ta'rifi (kpi < 50, baholanmaganlar ham); low_scored —
    // faqat BAHOLANGAN va 50 dan past (daily-summary low_score bilan bir xil).
    d.low_scored += num(r.low_score);
    d.unanswered += num(r.unanswered);
    d.bad_leads += num(r.bad_leads);
    d.leads += num(r.lead_phones) + num(r.leads_no_phone);
    d.invited += num(r.invited);
    d.closed += num(r.closed);
    d.incoming += num(r.incoming);
    d.outgoing += num(r.outgoing);
  }

  // Tanlangan kunning 24 soati (Toshkent).
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, calls: 0 }));
  for (const r of hourRows) {
    if (r.day !== anchor) continue;
    const h = hours[num(r.hour)];
    if (h) h.calls += num(r.calls);
  }

  const byManager: Record<string, number> = {};
  for (const it of dayItems) {
    if (it.day !== anchor) continue;
    // /api/calls bilan bir xil kalit: xodim yoki ichki raqamdan virtual id.
    const id = it.manager_id || (it.operator_ext ? virtualManagerId(companyId, String(it.operator_ext)) : null);
    if (id) byManager[id] = (byManager[id] || 0) + num(it.calls);
  }

  return { date: anchor, days, hours, month, today_by_manager: byManager };
}

// ----------------------------------------------------------------------------
// /analytics/operators — calls_operator_day_stats (perf_13)
// ----------------------------------------------------------------------------

export interface OperatorDayItem {
  key: string; ext: string | null; manager_id: string | null;
  calls: number; long_calls: number; incoming: number; outgoing: number;
  leads: number; scored: number; score10_sum: number; talk_sec: number;
}

/** Frontend dayCalls.operatorsOf bilan bir xil shakl (OperatorDay). */
export function buildOperatorDay(
  items: OperatorDayItem[],
  nameById: Map<string, string>,
  nameByExt: Map<string, string> = new Map(),
) {
  return [...items].map((o) => {
    const scored = num(o.scored);
    return {
      key: o.key,
      ext: o.ext ?? null,
      name: (o.ext && nameByExt.get(String(o.ext).trim())) || (o.manager_id && nameById.get(o.manager_id)) || null,
      calls: num(o.calls),
      longCalls: num(o.long_calls),
      incoming: num(o.incoming),
      outgoing: num(o.outgoing),
      leads: num(o.leads),
      score10: scored ? Math.round((num(o.score10_sum) / scored) * 10) / 10 : null,
      scored,
      talkSec: num(o.talk_sec),
    };
  });
}

// ----------------------------------------------------------------------------
// /analytics/daily-minutes — calls_operator_daily (perf_04)
// ----------------------------------------------------------------------------

export interface OperatorDailyItem {
  day: string; manager_id: string | null; operator_ext: string | null; calls: number; seconds: number;
}

/**
 * MAYDONLAR MA'NOSI (2026-10-12, "bir maydon — bitta ma'no"):
 *   calls / seconds / minutes        — kundagi BARCHA qo'ng'iroqlar (daily-summary,
 *                                      hourly, analysis-status bilan bir xil)
 *   operator_calls / operator_minutes — faqat operator qo'ng'iroqlari
 *   operators[]                      — operator kesimi (egasi aniq bo'lganlar;
 *                                      foydalanuvchi talabi 2026-09-23)
 * Avval kun darajasidagi calls/minutes FAQAT operator qo'ng'iroqlarini
 * sanardi — daily-summary'dagi "calls" bilan bir xil nomda boshqa son edi.
 */
// nameByExt (2026-10-16): ichki raqam -> "Xodimlarni boshqarish"dagi ism
// (lib/operatorNames.ts). Hamma builder'da ixtiyoriy — berilmasa eski nom.
export function buildDailyMinutes(
  items: OperatorDailyItem[],
  nameById: Map<string, string>,
  dayRows: Array<Pick<BucketRow, 'day' | 'calls' | 'operator_calls' | 'seconds'>>,
  nameByExt: Map<string, string> = new Map(),
) {
  type Ops = Map<string, { name: string; calls: number; seconds: number }>;
  const byDay = new Map<string, { calls: number; opCalls: number; seconds: number; opSeconds: number; ops: Ops }>();
  const entryOf = (day: string) => {
    const e = byDay.get(day) || { calls: 0, opCalls: 0, seconds: 0, opSeconds: 0, ops: new Map() };
    byDay.set(day, e);
    return e;
  };
  for (const r of dayRows) {
    const e = entryOf(r.day);
    e.calls += num(r.calls);
    e.opCalls += num(r.operator_calls);
    e.seconds += num(r.seconds);
  }
  for (const it of items) {
    const entry = entryOf(it.day);
    const calls = num(it.calls);
    const sec = num(it.seconds);
    entry.opSeconds += sec;

    const opKey = it.manager_id || (it.operator_ext ? `ext:${it.operator_ext}` : 'ext:—');
    const opName = (it.operator_ext && nameByExt.get(String(it.operator_ext).trim())) || (it.manager_id
      ? nameById.get(it.manager_id) || 'Xodim'
      : it.operator_ext
        ? `Operator ${it.operator_ext}`
        : 'Noma\'lum');
    const op = entry.ops.get(opKey) || { name: opName, calls: 0, seconds: 0 };
    op.calls += calls;
    op.seconds += sec;
    entry.ops.set(opKey, op);
  }

  const data = [...byDay.entries()]
    .sort((a, b) => b[0].localeCompare(a[0])) // yangi kun yuqorida
    .map(([date, v]) => ({
      date,
      calls: v.calls,
      operator_calls: v.opCalls,
      seconds: v.seconds,
      minutes: minutesOf(v.seconds),
      operator_minutes: minutesOf(v.opSeconds),
      operators: [...v.ops.values()]
        .sort((a, b) => b.seconds - a.seconds || byText(a.name, b.name))
        .map((o) => ({ name: o.name, calls: o.calls, minutes: minutesOf(o.seconds) })),
    }));

  const sum = (f: (d: (typeof data)[number]) => number) => data.reduce((s, d) => s + f(d), 0);
  const opSecondsTotal = [...byDay.values()].reduce((s, v) => s + v.opSeconds, 0);
  return {
    data,
    summary: {
      days: data.length,
      calls: sum((d) => d.calls),
      operator_calls: sum((d) => d.operator_calls),
      minutes: minutesOf(sum((d) => d.seconds)),
      operator_minutes: minutesOf(opSecondsTotal),
    },
  };
}

// ----------------------------------------------------------------------------
// /analytics/staff-stats — calls_staff_day_stats (perf_05)
// ----------------------------------------------------------------------------

export interface StaffOpItem {
  key: string; manager_id: string | null; operator_ext: string | null;
  calls: number; seconds: number; scored_calls: number; score_sum: number;
  leads: number; invited: number; closed: number; problems: number;
  stages: Array<{ title: string; sum: number; n: number }>;
  mistakes: Array<{ label: string; count: number; minus: number }>;
  lost: Array<{ reason: string; count: number }>;
  reasons: Array<{ reason: string; count: number }>;
}

export interface OperatorInsight { items: string[]; generatedAt: string; basedOnCalls: number }

export function buildStaffStats(
  items: StaffOpItem[],
  nameById: Map<string, string>,
  insightByExt: Map<string, OperatorInsight>,
  nameByExt: Map<string, string> = new Map(),
) {
  return [...items]
    .sort((x, y) => num(y.calls) - num(x.calls) || byText(x.key, y.key))
    .map((a) => {
      const stages = (a.stages || [])
        .map((s) => ({ title: s.title, pct: Math.round(num(s.n) ? num(s.sum) / num(s.n) : 0) }))
        .sort((x, y) => x.pct - y.pct || byText(x.title, y.title)); // eng kuchsizi birinchi
      const scored = num(a.scored_calls);
      const avgScore = Math.round(scored ? num(a.score_sum) / scored : 0);
      const topMistakes = (a.mistakes || [])
        .map((m) => ({ label: m.label, count: num(m.count), points_lost: Math.round(num(m.minus) * 10) / 10 }))
        .sort((x, y) => y.points_lost - x.points_lost || y.count - x.count || byText(x.label, y.label))
        .slice(0, 6);
      const lostReasons = (a.lost || [])
        .map((l) => ({ reason: l.reason, count: num(l.count) }))
        .sort((x, y) => y.count - x.count || byText(x.reason, y.reason))
        .slice(0, 6);
      const leads = num(a.leads);
      const closed = num(a.closed);
      const conversion = leads > 0 ? Math.round((closed / leads) * 1000) / 10 : 0;

      // GPT bu yerda CHAQIRILMAYDI (API v2 §0.4, §6.5): ayblar skript
      // bandlari foizidan determinisik, tavsiya esa operator_insights
      // jadvalidan (fon jobi to'ldiradi). Tayyor bo'lmasa — null.
      const faults = deriveFaults(stages);
      const ext = a.key.startsWith('ext:') ? a.key.slice(4) : null;
      const insight = ext ? insightByExt.get(ext) : undefined;
      const extName = (ext || a.operator_ext) ? nameByExt.get(String(ext || a.operator_ext).trim()) : undefined;
      const name = extName || (a.manager_id ? nameById.get(a.manager_id) || 'Xodim' : `Operator ${a.operator_ext}`);
      return {
        key: a.key,
        name,
        calls: num(a.calls),
        minutes: minutesOf(num(a.seconds)),
        scored_calls: scored,
        avg_score: avgScore,          // 0-100 (frontend 10 ballikka bo'ladi)
        stages,
        faults,
        advice: insight?.items ?? null, // null = hali tayyorlanmagan
        advice_generated_at: insight?.generatedAt ?? null,
        advice_based_on_calls: insight?.basedOnCalls ?? null,
        leads,
        invited: num(a.invited),
        closed,
        conversion,                   // lid -> bitim, foizda
        problems: num(a.problems),    // AI muammoli deb belgilagan qo'ng'iroqlar
        top_mistakes: topMistakes,    // qaysi xato necha marta, necha ball yeb ketgan
        lost_reasons: lostReasons,    // bitim nega yo'qolgan
        reasons: (a.reasons || [])
          .map((r) => ({ reason: r.reason, count: num(r.count) }))
          .sort((x, y) => y.count - x.count || byText(x.reason, y.reason)),
      };
    });
}

// ----------------------------------------------------------------------------
// /analytics/analysis-status — calls_analysis_status (perf_06)
// ----------------------------------------------------------------------------

export interface AnalysisStatusRaw {
  total: number; operator_calls: number;
  analyzed: number; analyzed_seconds: number;
  not_analyzed: number; not_analyzed_seconds: number;
  reasons: Array<{ reason: string; count: number; seconds: number }>;
  operators: Array<{ ext: string; analyzed: number; skipped: number; analyzed_seconds: number; limit_reached: boolean }>;
}

export function buildAnalysisStatus(raw: AnalysisStatusRaw, nameByExt: Map<string, string> = new Map()) {
  return {
    total: num(raw.total),                   // BARCHA qo'ng'iroqlar (= daily-summary calls)
    operator_calls: num(raw.operator_calls), // ulardan operator qo'ng'iroqlari
    analyzed: num(raw.analyzed),
    analyzed_minutes: minutesOf(num(raw.analyzed_seconds)),
    not_analyzed: num(raw.not_analyzed),
    not_analyzed_minutes: minutesOf(num(raw.not_analyzed_seconds)),
    reasons: [...(raw.reasons || [])]
      .sort((a, b) => num(b.count) - num(a.count) || byText(a.reason, b.reason))
      .map((r) => ({ reason: r.reason, count: num(r.count), minutes: minutesOf(num(r.seconds)) })),
    operators: [...(raw.operators || [])]
      .sort((a, b) => num(b.analyzed) - num(a.analyzed) || byText(a.ext, b.ext))
      .map((o) => ({
        operator: o.ext === '—' ? 'Aniqlanmagan' : nameByExt.get(String(o.ext).trim()) || `Operator ${o.ext}`,
        analyzed: num(o.analyzed),
        skipped: num(o.skipped),
        analyzed_minutes: minutesOf(num(o.analyzed_seconds)),
        limit_reached: !!o.limit_reached,
      })),
  };
}

// ----------------------------------------------------------------------------
// GET /analytics (root) va GET /api/analyze-call — company_analytics_root (perf_07)
// ----------------------------------------------------------------------------

export interface AnalyticsRootRaw {
  total_calls: number; duration_sum: number;
  /** traffic_avg/sales_avg bazada 2 xonagacha aniq yaxlitlangan (perf_07). */
  conv_n: number; traffic_avg: number; sales_avg: number;
  lost_reasons: Record<string, number> | null;
}

export function buildAnalyticsRoot(raw: AnalyticsRootRaw, now: Date) {
  const totalCalls = num(raw.total_calls);
  const convN = num(raw.conv_n);
  return {
    totalCalls,
    averageDurationSeconds: totalCalls > 0 ? Math.round(num(raw.duration_sum) / totalCalls) : 0,
    averages: {
      traffic_conversion: convN > 0 ? num(raw.traffic_avg) : 0,
      sales_conversion: convN > 0 ? num(raw.sales_avg) : 0,
    },
    lostReasonsSummary: Object.fromEntries(
      Object.entries(raw.lost_reasons || {}).map(([k, v]) => [k, num(v)]),
    ) as Record<string, number>,
    cachedAt: now.toISOString(),
  };
}

// ----------------------------------------------------------------------------
// GET /managers/:id/stats — manager_call_stats (perf_09)
// ----------------------------------------------------------------------------

export interface ManagerStatsRow {
  total_calls: number; kpi_sum: number; duration_sum: number;
  penalty_sum: number; bonus_sum: number; calls_today: number;
}

export function buildManagerStats(manager: Record<string, unknown>, row: ManagerStatsRow | undefined) {
  const totalCalls = num(row?.total_calls);
  const avg = (sum: number) => (totalCalls ? sum / totalCalls : 0);
  return {
    manager,
    total_calls: totalCalls,
    avg_kpi_score: Number(avg(num(row?.kpi_sum)).toFixed(2)),
    avg_duration_sec: Math.round(avg(num(row?.duration_sum))),
    total_penalty: Number(num(row?.penalty_sum).toFixed(2)),
    total_bonus: Number(num(row?.bonus_sum).toFixed(2)),
    daily_call_target: (manager as any).daily_call_target ?? 20,
    calls_today: num(row?.calls_today),
  };
}
