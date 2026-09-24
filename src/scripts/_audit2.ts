import { config } from 'dotenv';
config({ path: '/Users/macbook/procell-backend/.env.local' });
import { supabase, fetchAllRows } from '../lib/supabase';
const J = '24823352-465e-43ea-913c-9f9d7270b9e9';
const day = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tashkent', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
const hm = (s: number) => `${Math.floor(s / 3600)} soat ${Math.round((s % 3600) / 60)} daq`;
async function main() {
  const rows = await fetchAllRows<any>((f, t) =>
    supabase.from('calls').select('created_at,duration,kpi_score,transcript,operator_ext,manager_id,new_leads_count,sent_to_dealer_count,closed_deals_count,bad_leads_count,unanswered_count,incoming_count,outgoing_count,total_calls,rop_comment')
      .eq('company_id', J).range(f, t));
  const today = day(new Date().toISOString());
  const td = rows.filter((r) => day(r.created_at) === today);
  const sum = (a: any[], k: string) => a.reduce((s, r) => s + (Number(r[k]) || 0), 0);
  const ops = td.filter((r) => r.operator_ext || r.manager_id);
  console.log(`=== BUGUN (${today}, Toshkent) ===`);
  console.log(`qo'ng'iroq: ${td.length} (operatorli: ${ops.length})`);
  console.log(`JAMI GAPLASHUV: ${hm(sum(td, 'duration'))}  |  faqat operatorlar: ${hm(sum(ops, 'duration'))}`);
  console.log(`matn: ${td.filter((r) => r.transcript).length} | ball qo'yilgan: ${td.filter((r) => (r.kpi_score ?? 0) > 0).length}`);
  console.log(`\nAI hisoblagan ko'rsatkichlar (bugun):`);
  for (const k of ['new_leads_count', 'sent_to_dealer_count', 'closed_deals_count', 'bad_leads_count', 'unanswered_count', 'incoming_count', 'outgoing_count', 'total_calls']) {
    console.log(`   ${k.padEnd(22)} ${sum(td, k)}`);
  }
  console.log(`\n=== BARCHA KUNLAR ===`);
  const days = new Map<string, any[]>();
  rows.forEach((r) => { const d = day(r.created_at); days.set(d, [...(days.get(d) || []), r]); });
  for (const [d, list] of [...days.entries()].sort()) {
    console.log(`${d}: ${String(list.length).padStart(3)} qo'ng'iroq | ${hm(sum(list, 'duration'))} | lid ${sum(list, 'new_leads_count')} | markazga ${sum(list, 'sent_to_dealer_count')} | yopilgan ${sum(list, 'closed_deals_count')}`);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error('XATO:', e.message); process.exit(1); });
