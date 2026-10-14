// Hisobot JSON quruvchilari (reportBuilders.ts) — SOF funksiyalar testi.
//
// NEGA: 2026-10-12 dan og'ir sanash Postgres funksiyalarida (perf_*.sql),
// Node faqat ularning natijasidan JSON yig'adi. Bu test JSON SHAKLI va
// yaxlitlash qoidalari eski Node hisobi bilan bir xil qolishini qulflaydi
// (frontend shu maydonlarga tayanadi).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays, buildHourly, buildDailySummary, buildConversionHistory, buildStaffStats, buildDailyMinutes, buildDailyPanel,
  buildRelationshipDynamics, buildPopStats, popRanges, type BucketRow, type StaffOpItem,
} from './reportBuilders';

const bucket = (p: Partial<BucketRow>): BucketRow => ({
  day: '2026-10-12', hour: null, calls: 0, operator_calls: 0, seconds: 0, long_calls: 0,
  with_transcript: 0, analyzed_any: 0, scored: 0, score_sum: 0, low_score: 0,
  kpi_sum: 0, low_any: 0, penalized: 0,
  incoming: 0, outgoing: 0, invited: 0, closed: 0, bad_leads: 0, unanswered: 0,
  lead_phones: 0, leads_no_phone: 0, penalty_sum: 0, bonus_sum: 0, ...p,
});

test('addDays oy va yil chegarasidan to\'g\'ri o\'tadi', () => {
  assert.equal(addDays('2026-10-01', -1), '2026-09-30');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2028-03-01', -1), '2028-02-29');
});

test('hourly: har doim 24 soat, bo\'sh soat nol bilan', () => {
  const h = buildHourly([bucket({ hour: 9, calls: 3, operator_calls: 2, seconds: 125, long_calls: 1, analyzed_any: 2 })]);
  assert.equal(h.length, 24);
  assert.deepEqual(h[9], { hour: 9, calls: 3, operator_calls: 2, long_calls: 1, analyzed: 2, talk_seconds: 125 });
  assert.deepEqual(h[0], { hour: 0, calls: 0, operator_calls: 0, long_calls: 0, analyzed: 0, talk_seconds: 0 });
  // Maydon tartibi ham eski javob bilan bir xil.
  assert.deepEqual(Object.keys(h[0]), ['hour', 'calls', 'operator_calls', 'long_calls', 'analyzed', 'talk_seconds']);
});

test('daily-summary: yangi kun yuqorida, lid = takrorlanmas raqam + raqamsiz', () => {
  const d = buildDailySummary([
    bucket({ day: '2026-10-11', calls: 1 }),
    bucket({ day: '2026-10-12', calls: 4, seconds: 90, scored: 2, score_sum: 101, lead_phones: 2, leads_no_phone: 1, penalty_sum: 10.5 }),
  ]);
  assert.deepEqual(d.map((x) => x.date), ['2026-10-12', '2026-10-11']);
  assert.equal(d[0].minutes, 1.5);
  assert.equal(d[0].avg_score, 51);
  assert.equal(d[0].leads, 3);
  assert.equal(d[0].penalty_sum, 11);
});

test('conversion-history: oynadagi har kun bor, bo\'sh kun nol', () => {
  const out = buildConversionHistory(
    [{ day: '2026-10-11', conv_n: 2, traffic_avg: 54.04, sales_avg: 10 }],
    [{ day: '2026-10-12', calls: 7, operator_calls: 4 }],
    3, '2026-10-12',
  );
  assert.deepEqual(out, [
    { date: '2026-10-10', traffic_conversion: 0, sales_conversion: 0, calls: 0, operator_calls: 0 },
    { date: '2026-10-11', traffic_conversion: 54.04, sales_conversion: 10, calls: 0, operator_calls: 0 },
    { date: '2026-10-12', traffic_conversion: 0, sales_conversion: 0, calls: 7, operator_calls: 4 },
  ]);
});

test('relationship-dynamics: bugun/kecha/hafta/o\'tgan hafta va 7 kunlik spark', () => {
  const [u] = buildRelationshipDynamics([
    { day: '2026-10-12', unanswered: 2, bad_leads: 0 },
    { day: '2026-10-11', unanswered: 3, bad_leads: 0 },
    { day: '2026-10-01', unanswered: 5, bad_leads: 0 },
  ], '2026-10-12') as any[];
  assert.equal(u.today, 2);
  assert.equal(u.yesterday, 3);
  assert.equal(u.week, 5);
  assert.equal(u.lastWeek, 5);
  assert.deepEqual(u.spark, [0, 0, 0, 0, 0, 3, 2]);
});

test('staff-stats: teng qiymatlarda tartib barqaror (har so\'rovda bir xil top-6)', () => {
  const op = (mistakes: StaffOpItem['mistakes']): StaffOpItem => ({
    key: 'ext:101', manager_id: null, operator_ext: '101', calls: 1, seconds: 60, scored_calls: 0, score_sum: 0,
    leads: 0, invited: 0, closed: 0, problems: 0, stages: [], mistakes, lost: [], reasons: [],
  });
  const labels = ['G', 'F', 'E', 'D', 'C', 'B', 'A'].map((label) => ({ label, count: 1, minus: 0 }));
  const a = buildStaffStats([op(labels)], new Map(), new Map())[0];
  const b = buildStaffStats([op([...labels].reverse())], new Map(), new Map())[0];
  assert.deepEqual(a.top_mistakes, b.top_mistakes);
  assert.deepEqual(a.top_mistakes.map((m) => m.label), ['A', 'B', 'C', 'D', 'E', 'F']);
});

test('daily-minutes: calls = barcha, operator_calls/operator_minutes = faqat operator', () => {
  const r = buildDailyMinutes(
    [{ day: '2026-10-12', manager_id: null, operator_ext: '101', calls: 3, seconds: 180 }],
    new Map(),
    [{ day: '2026-10-12', calls: 5, operator_calls: 3, seconds: 300 }],
  );
  assert.deepEqual(r.data[0], {
    date: '2026-10-12', calls: 5, operator_calls: 3, seconds: 300, minutes: 5, operator_minutes: 3,
    operators: [{ name: 'Operator 101', calls: 3, minutes: 3 }],
  });
  assert.deepEqual(r.summary, { days: 1, calls: 5, operator_calls: 3, minutes: 5, operator_minutes: 3 });
});

test('daily-panel: tanlangan kun birinchi, soatlar shu kun, oy boshidan voronka', () => {
  const p = buildDailyPanel(
    [
      bucket({ day: '2026-10-12', calls: 5, operator_calls: 3, long_calls: 2, kpi_sum: 200, low_any: 3, penalized: 1, seconds: 290, bonus_sum: 10.3, penalty_sum: 0.2, lead_phones: 2, leads_no_phone: 1, invited: 1, closed: 1, unanswered: 4 }),
      bucket({ day: '2026-10-10', calls: 2, long_calls: 2 }),
      bucket({ day: '2026-10-01', calls: 9, long_calls: 1, lead_phones: 5 }), // oynadan tashqari, lekin oy boshidan
      bucket({ day: '2026-09-30', calls: 99 }), // boshqa oy — hech qayerga kirmaydi
    ],
    [
      bucket({ day: '2026-10-12', hour: 9, calls: 4 }),
      bucket({ day: '2026-10-12', hour: 15, calls: 1 }),
    ],
    [{ day: '2026-10-12', manager_id: 'm-1', operator_ext: null, calls: 2, seconds: 1 }],
    'company', '2026-10-12', 3,
  );
  assert.equal(p.date, '2026-10-12');
  assert.deepEqual(p.days.map((d) => d.date), ['2026-10-12', '2026-10-11', '2026-10-10']);
  assert.equal(p.days[0].calls, 5);
  assert.equal(p.days[0].short, 3);
  assert.equal(p.days[0].leads, 3);
  assert.equal(p.days[0].unanswered, 4);
  assert.equal(p.days[0].bonus_sum, 10.3);
  assert.equal(p.days[2].calls, 2);
  assert.deepEqual(p.month, { from: '2026-10-01', to: '2026-10-12', calls: 16, long_calls: 5, leads: 8, invited: 1, closed: 1 });
  assert.equal(p.hours[9].calls, 4);
  assert.equal(p.hours.reduce((s, h) => s + h.calls, 0), 5);
  assert.deepEqual(p.today_by_manager, { 'm-1': 2 });
});

test('PoP: 6 ta oyna va eski JSON shakli', () => {
  const now = new Date('2026-10-12T10:00:00Z');
  assert.equal(popRanges(now).length, 6);
  const out: any = buildPopStats([
    { idx: 0, calls: 10, operator_calls: 8, seconds: 600, kpi_sum: 50, kpi_n: 10 },
    { idx: 1, calls: 5, operator_calls: 5, seconds: 300, kpi_sum: 10, kpi_n: 5 },
  ], now);
  assert.deepEqual(out.daily.calls, { current: 10, previous: 5, change_pct: 100 });
  assert.deepEqual(out.daily.operator_calls, { current: 8, previous: 5, change_pct: 60 });
  assert.deepEqual(out.daily.duration_minutes, { current: 10, previous: 5, change_pct: 100 });
  assert.deepEqual(out.daily.avg_kpi, { current: 5, previous: 2, change_pct: 150 });
  assert.deepEqual(out.weekly.calls, { current: 0, previous: 0, change_pct: 0 });
  assert.equal(out.generated_at, now.toISOString());
});
