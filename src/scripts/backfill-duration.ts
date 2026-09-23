// Davomiyligi 0 bo'lib qolgan qo'ng'iroqlarni audio faylidan o'lchab to'ldiradi.
// Ishlatish: npx tsx src/scripts/backfill-duration.ts
import { config } from 'dotenv';
config({ path: '/Users/macbook/procell-backend/.env.local' });
import { supabase, fetchAllRows } from '../lib/supabase';
import { probeWavDurationSec } from '../lib/audioDuration';

async function main() {
  const rows = await fetchAllRows<{ id: string; audio_url: string; duration: number | null }>((f, t) =>
    supabase.from('calls').select('id, audio_url, duration')
      .ilike('audio_url', '%utel%').or('duration.is.null,duration.eq.0').range(f, t));
  console.log(`davomiyligi yo'q qo'ng'iroqlar: ${rows.length}`);

  let ok = 0, fail = 0;
  const CONC = 12;
  for (let i = 0; i < rows.length; i += CONC) {
    const chunk = rows.slice(i, i + CONC);
    await Promise.all(chunk.map(async (r) => {
      const sec = await probeWavDurationSec(r.audio_url);
      if (sec && sec > 0) {
        await supabase.from('calls').update({ duration: sec }).eq('id', r.id);
        ok++;
      } else fail++;
    }));
    if ((i / CONC) % 5 === 0) console.log(`  ${i + chunk.length}/${rows.length} — to'ldirildi: ${ok}, aniqlanmadi: ${fail}`);
  }
  console.log(`TUGADI — to'ldirildi: ${ok}, aniqlanmadi: ${fail}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error('XATO:', e.message); process.exit(1); });
