import { config } from 'dotenv';
config({ path: '/Users/macbook/procell-backend/.env.local' });
import { supabase } from '../lib/supabase';
const JAMALS = '24823352-465e-43ea-913c-9f9d7270b9e9';
async function main() {
  const { data } = await supabase.from('calls').select('status,transcript,kpi_score,duration')
    .eq('company_id', JAMALS).ilike('audio_url', '%utel%').limit(2000);
  const r = data || [];
  const withTr = r.filter((x) => x.transcript).length;
  const kpi = r.filter((x) => (x.kpi_score ?? 0) > 0).length;
  const proc = r.filter((x) => x.status === 'processing').length;
  const notDone = r.filter((x) => x.status !== 'done').length;
  const silent = r.filter((x) => x.status === 'done' && !x.transcript).length;
  const tashkent = new Date(Date.now() + 5 * 3600_000).toISOString().slice(11, 16);
  console.log(`Toshkent ${tashkent} | jami:${r.length} | matn:${withTr} ball:${kpi} jim:${silent} | ishlanmoqda:${proc} tugallanmagan:${notDone}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error('XATO:', e.message); process.exit(1); });
