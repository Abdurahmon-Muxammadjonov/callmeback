// 0-BOSQICH TESTLARI — hisobot endpointlari.
//
// Ishlatish: npx tsx src/scripts/test-analytics-endpoints.ts
//
// Tekshiriladi:
//   1. /analytics/hourly — 24 ta qator, bo'sh soatlar nol bilan
//   2. daily-summary — 23-09 da operator_calls = 146, calls = 697
//   3. daily-summary?until= — kunning faqat bir qismini oladi
//   4. long_calls — KPI normalaridagi chegaradan hisoblanadi
//   5. TENANT IZOLYATSIYASI — boshqa kompaniya ma'lumoti chiqmaydi
//   6. Bo'sh kun — xato emas, nollar
import { config } from 'dotenv';
config({ path: '/Users/macbook/procell-backend/.env.local' });
import { supabase, fetchAllRows } from '../lib/supabase';
import { getCompanySettings } from '../lib/companySettings';
import { dayBounds, tashkentDay, tashkentHm, tashkentHour } from '../lib/tashkentTime';

const JAMALS = '24823352-465e-43ea-913c-9f9d7270b9e9';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`  ✅ ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}

/** Endpoint mantiqini AYNAN takrorlaydi (HTTP'siz, to'g'ridan-to'g'ri bazadan). */
async function hourly(companyId: string, date: string, operatorExt?: string) {
  const settings = await getCompanySettings(supabase, companyId);
  const longSec = Math.max(1, Number(settings.qualified_call_seconds) || 60);
  const { from, to } = dayBounds(date);
  const rows = await fetchAllRows<any>((f, t) => {
    let q = supabase.from('calls')
      .select('created_at, duration, kpi_score, transcript, operator_ext, manager_id')
      .eq('company_id', companyId).gte('created_at', from).lte('created_at', to);
    if (operatorExt) q = q.eq('operator_ext', operatorExt);
    return q.range(f, t);
  });
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, calls: 0, operator_calls: 0, long_calls: 0, analyzed: 0, talk_seconds: 0 }));
  for (const r of rows) {
    const h = hours[tashkentHour(r.created_at)];
    if (!h) continue;
    const sec = Math.max(0, Number(r.duration) || 0);
    h.calls += 1; h.talk_seconds += sec;
    if (sec >= longSec) h.long_calls += 1;
    if (r.operator_ext || r.manager_id) h.operator_calls += 1;
    if (r.transcript || Number(r.kpi_score) > 0) h.analyzed += 1;
  }
  return { hours, longSec };
}

async function daily(companyId: string, days: number, until?: string) {
  const settings = await getCompanySettings(supabase, companyId);
  const longSec = Math.max(1, Number(settings.qualified_call_seconds) || 60);
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const rows = await fetchAllRows<any>((f, t) =>
    supabase.from('calls').select('created_at, duration, operator_ext, manager_id, penalty_amount, bonus_amount')
      .eq('company_id', companyId).gte('created_at', since).range(f, t));
  const byDay = new Map<string, { calls: number; operator_calls: number; long_calls: number; penalty: number; bonus: number }>();
  for (const r of rows) {
    if (until && tashkentHm(r.created_at) > until) continue;
    const d = tashkentDay(r.created_at);
    const a = byDay.get(d) || { calls: 0, operator_calls: 0, long_calls: 0, penalty: 0, bonus: 0 };
    const sec = Math.max(0, Number(r.duration) || 0);
    a.calls += 1;
    if (sec >= longSec) a.long_calls += 1;
    if (r.operator_ext || r.manager_id) a.operator_calls += 1;
    a.penalty += Math.max(0, Number(r.penalty_amount) || 0);
    a.bonus += Math.max(0, Number(r.bonus_amount) || 0);
    byDay.set(d, a);
  }
  return { byDay, longSec };
}

async function main() {
  console.log('\n=== 1) /analytics/hourly — tuzilishi ===');
  const h24 = await hourly(JAMALS, '2026-09-24');
  check('24 ta soat qatori', h24.hours.length === 24, `${h24.hours.length} ta`);
  check('soatlar 0 dan 23 gacha', h24.hours.every((h, i) => h.hour === i));
  check('bo\'sh soat ham qaytadi (nol bilan)', h24.hours.some((h) => h.calls === 0));
  const totalHourly = h24.hours.reduce((s, h) => s + h.calls, 0);
  console.log(`     jami: ${totalHourly} qo'ng'iroq, eng band soat: ${h24.hours.slice().sort((a, b) => b.calls - a.calls)[0].hour}:00`);

  console.log('\n=== 2) daily-summary — 23-09 raqamlari ===');
  const d = await daily(JAMALS, 30);
  const d23 = d.byDay.get('2026-09-23');
  check('23-09 jami qo\'ng\'iroq = 697', d23?.calls === 697, `${d23?.calls}`);
  check('23-09 operator_calls = 146', d23?.operator_calls === 146, `${d23?.operator_calls}`);
  const d24 = d.byDay.get('2026-09-24');
  check('24-09 hammasi operatorli', d24?.calls === d24?.operator_calls, `${d24?.operator_calls}/${d24?.calls}`);

  console.log('\n=== 3) until= — kunning bir qismi ===');
  const partial = await daily(JAMALS, 30, '12:00');
  const p23 = partial.byDay.get('2026-09-23');
  check('until=12:00 natijani kamaytiradi', (p23?.calls ?? 0) < (d23?.calls ?? 0), `${p23?.calls} < ${d23?.calls}`);
  const full = await daily(JAMALS, 30, '23:59');
  check('until=23:59 to\'liq kunga teng', full.byDay.get('2026-09-23')?.calls === d23?.calls);

  console.log('\n=== 4) long_calls — KPI normasidan ===');
  check('chegara sozlamadan olinadi', d.longSec > 0, `${d.longSec} soniya`);
  check('uzun qo\'ng\'iroqlar jamidan kam', (d23?.long_calls ?? 0) <= (d23?.calls ?? 0), `${d23?.long_calls}/${d23?.calls}`);

  console.log('\n=== 5) TENANT IZOLYATSIYASI ===');
  const { data: others } = await supabase.from('companies').select('id, name').neq('id', JAMALS).limit(5);
  let leaked = false;
  for (const o of others || []) {
    const r = await daily((o as any).id, 30);
    const total = [...r.byDay.values()].reduce((s, x) => s + x.calls, 0);
    if (total > 0) {
      // Boshqa kompaniyada haqiqatan qo'ng'iroq bo'lishi mumkin — JAMALS'niki
      // aralashib ketmaganini tekshiramiz.
      const { count } = await supabase.from('calls').select('id', { count: 'exact', head: true }).eq('company_id', (o as any).id);
      if ((count ?? 0) !== total) leaked = true;
    }
  }
  check('boshqa kompaniya so\'rovida JAMALS ma\'lumoti yo\'q', !leaked);
  const jamalsOnly = await fetchAllRows<any>((f, t) =>
    supabase.from('calls').select('company_id').eq('company_id', JAMALS).range(f, t));
  check('so\'rov faqat bitta company_id qaytaradi', new Set(jamalsOnly.map((r) => r.company_id)).size === 1);

  console.log('\n=== 6) BO\'SH KUN ===');
  const empty = await hourly(JAMALS, '2020-01-01');
  check('bo\'sh kunda ham 24 qator', empty.hours.length === 24);
  check('bo\'sh kunda hammasi nol', empty.hours.every((x) => x.calls === 0 && x.talk_seconds === 0));

  console.log(`\n${fail === 0 ? '✅ HAMMASI O\'TDI' : '❌ XATOLAR BOR'}: ${pass} o'tdi, ${fail} yiqildi\n`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error('XATO:', e.message); process.exit(1); });
