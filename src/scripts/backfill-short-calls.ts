// Ball qo'yilmagan (suhbatsiz yoki juda qisqa) qo'ng'iroqlarga SABAB yozadi.
// Har bir qo'ng'iroqda yo ball, yo sabab bo'lishi kerak.
// Ishlatish: npx tsx src/scripts/backfill-short-calls.ts
import { config } from 'dotenv';
config({ path: '/Users/macbook/procell-backend/.env.local' });
import { supabase, fetchAllRows } from '../lib/supabase';
import { classifyShortCall } from '../lib/openaiAnalyzer';

const JAMALS = process.env.BACKFILL_COMPANY_ID || '24823352-465e-43ea-913c-9f9d7270b9e9';

async function main() {
  const rows = await fetchAllRows<any>((f, t) =>
    supabase.from('calls').select('id, transcript, duration, kpi_score, rop_comment')
      .eq('company_id', JAMALS).eq('status', 'done').range(f, t));

  const need = rows.filter((r) =>
    !(Number(r.kpi_score) > 0) && !String(r.rop_comment || '').startsWith('(Baholanmadi)'));
  console.log(`sabab yozilishi kerak: ${need.length} ta`);

  let done = 0;
  const CONC = 6;
  for (let i = 0; i < need.length; i += CONC) {
    await Promise.all(need.slice(i, i + CONC).map(async (r) => {
      const { category, note } = await classifyShortCall(String(r.transcript || ''), Number(r.duration) || 0);
      await supabase.from('calls').update({
        rop_comment: `(Baholanmadi) ${category}. ${note}`,
        dropped_reason: category,
        summary: note,
      }).eq('id', r.id);
      done++;
    }));
    if (i % 60 === 0) console.log(`  ${done}/${need.length}`);
  }
  console.log(`TUGADI: ${done} ta qo'ng'iroqqa sabab yozildi`);
}
main().then(() => process.exit(0)).catch((e) => { console.error('XATO:', e.message); process.exit(1); });
