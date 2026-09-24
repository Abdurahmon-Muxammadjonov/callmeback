import { config } from 'dotenv';
config({ path: '/Users/macbook/procell-backend/.env.local' });
import { supabase, fetchAllRows } from '../lib/supabase';
const J = '24823352-465e-43ea-913c-9f9d7270b9e9';
const day = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
async function main() {
  const target = process.argv[2] || '2026-09-24';
  const rows = (await fetchAllRows<any>((f, t) =>
    supabase.from('calls').select('created_at,duration,transcript,kpi_score,dropped_reason,status')
      .eq('company_id', J).range(f, t))).filter((r) => day(r.created_at) === target);

  const noTr = rows.filter((r) => !r.transcript);
  const tr = rows.filter((r) => r.transcript);
  console.log(`=== ${target}: jami ${rows.length} ===\n`);

  console.log(`1) MATNSIZ: ${noTr.length} ta — davomiyligi bo'yicha:`);
  const b: Record<string, number> = { '0-5s': 0, '6-10s': 0, '11-20s': 0, '21-60s': 0, '60s+': 0 };
  noTr.forEach((r) => { const d = Number(r.duration) || 0;
    b[d <= 5 ? '0-5s' : d <= 10 ? '6-10s' : d <= 20 ? '11-20s' : d <= 60 ? '21-60s' : '60s+']++; });
  Object.entries(b).forEach(([k, v]) => console.log(`     ${k.padEnd(8)} ${v}`));

  console.log(`\n2) MATNI BOR: ${tr.length} ta, shundan ball qo'yilgan: ${tr.filter((r) => (r.kpi_score ?? 0) > 0).length}`);
  const noKpi = tr.filter((r) => !(Number(r.kpi_score) > 0));
  const lb: Record<string, number> = { '1-50 belgi': 0, '51-120': 0, '121-250': 0, '251-500': 0, '500+': 0 };
  noKpi.forEach((r) => { const n = String(r.transcript).length;
    lb[n <= 50 ? '1-50 belgi' : n <= 120 ? '51-120' : n <= 250 ? '121-250' : n <= 500 ? '251-500' : '500+']++; });
  console.log(`   ballsizlar (${noKpi.length} ta) — matn uzunligi bo'yicha:`);
  Object.entries(lb).forEach(([k, v]) => console.log(`     ${k.padEnd(12)} ${v}`));

  console.log('\n3) Ballsizlarning sababi (dropped_reason):');
  const rs: Record<string, number> = {};
  noKpi.forEach((r) => { const k = String(r.dropped_reason || '(yozilmagan)'); rs[k] = (rs[k] || 0) + 1; });
  Object.entries(rs).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`     ${String(v).padStart(4)}  ${k}`));

  const long = noKpi.filter((r) => String(r.transcript).length > 250);
  console.log(`\n4) MUAMMO BO'LSA SHU: 250 belgidan uzun, lekin ballsiz — ${long.length} ta`);
  long.slice(0, 3).forEach((r) => console.log(`     ${r.duration}s | ${String(r.transcript).length} belgi | sabab: ${r.dropped_reason}`));
}
main().then(() => process.exit(0)).catch((e) => { console.error('XATO:', e.message); process.exit(1); });
