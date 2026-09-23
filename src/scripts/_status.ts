import { config } from 'dotenv';
config({ path: '/Users/macbook/procell-backend/.env.local' });
import { supabase } from '../lib/supabase';

const JAMALS = '24823352-465e-43ea-913c-9f9d7270b9e9';

async function main() {
  const { data } = await supabase.from('calls').select('status,transcript,kpi_score,error')
    .eq('company_id', JAMALS).limit(2000);
  const rows = data || [];
  const c = { done: 0, failed: 0, processing: 0, other: 0 } as Record<string, number>;
  let tr = 0, kpi = 0, tooBig = 0, rate = 0;
  for (const r of rows) {
    const s = String(r.status || 'other');
    c[s in c ? s : 'other'] += 1;
    if (r.transcript) tr++;
    if (r.kpi_score != null && r.kpi_score > 0) kpi++;
    const e = String(r.error || '');
    if (e.includes('AUDIO_TOO_LARGE') || e.includes('413')) tooBig++;
    if (e.includes('429')) rate++;
  }
  console.log(`${new Date().toISOString().slice(11, 19)} | jami:${rows.length} done:${c.done} failed:${c.failed} processing:${c.processing} | matn:${tr} KPI:${kpi} | katta-fayl:${tooBig} 429:${rate}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error('XATO:', e.message); process.exit(1); });
