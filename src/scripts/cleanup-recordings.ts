import '../env';
import { supabase } from '../lib/supabase';

// Bir martalik tozalash: "recordings" bucket'idagi PBX audio nusxalarini
// o'chiradi va calls.audio_url'ni PBX'dagi asl havolaga qaytaradi.
//
// Nega kerak: 2026-09-06 gacha har bir qo'ng'iroq audiosi Supabase Storage'ga
// nusxalanardi va hech qachon o'chirilmasdi — storage kvotasi to'lib, butun
// loyiha bloklandi (HTTP 402). Kod endi nusxa olmaydi (crm.ts,
// sync-pbx-history.ts), lekin ESKI fayllar hali joy egallab turibdi — ularni
// shu skript tozalaydi.
//
// XAVFSIZLIK: faqat audio_source_url'i BOR qatorlar tegiladi — ya'ni audiosi
// PBX'da ham bor bo'lganlar. Qo'lda yuklangan (manba havolasi yo'q) audiolar
// TEGILMAYDI, aks holda ular butunlay yo'qolardi.
//
// Ishlatish:
//   npx tsx src/scripts/cleanup-recordings.ts          -> faqat ko'rsatadi (dry run)
//   npx tsx src/scripts/cleanup-recordings.ts --yes     -> haqiqatda o'chiradi

const BUCKET = 'recordings';
const PAGE = 500;
const APPLY = process.argv.includes('--yes');

interface CallRow {
  id: string;
  audio_url: string | null;
  audio_source_url: string | null;
  audio_storage_path: string | null;
}

async function fetchDeletableCalls(): Promise<CallRow[]> {
  const rows: CallRow[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('calls')
      .select('id, audio_url, audio_source_url, audio_storage_path')
      .not('audio_storage_path', 'is', null)
      .not('audio_source_url', 'is', null)
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`calls o'qib bo'lmadi: ${error.message}`);
    if (!data || data.length === 0) break;
    rows.push(...(data as CallRow[]));
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

async function main(): Promise<void> {
  const calls = await fetchDeletableCalls();
  console.log(`Tozalanadigan qator: ${calls.length} ta (audio PBX'da ham bor).`);
  if (calls.length === 0) return;

  if (!APPLY) {
    console.log('DRY RUN — hech narsa o\'chirilmadi. Haqiqatda o\'chirish uchun: --yes');
    console.log('Namuna:', calls.slice(0, 3).map((c) => c.audio_storage_path));
    return;
  }

  let removed = 0;
  let updated = 0;
  for (let i = 0; i < calls.length; i += 100) {
    const chunk = calls.slice(i, i + 100);

    const paths = chunk.map((c) => c.audio_storage_path).filter((p): p is string => !!p);
    const { error: rmError } = await supabase.storage.from(BUCKET).remove(paths);
    if (rmError) {
      console.error(`Storage o'chirishda xato (${i}):`, rmError.message);
    } else {
      removed += paths.length;
    }

    // audio_url endi PBX havolasiga ishora qilsin — /api/calls javobida u
    // imzolangan proxy havolasiga aylantiriladi (src/routes/calls.ts).
    for (const call of chunk) {
      const { error: upError } = await supabase
        .from('calls')
        .update({ audio_url: call.audio_source_url, audio_storage_url: null, audio_storage_path: null })
        .eq('id', call.id);
      if (upError) console.error(`calls yangilashda xato (${call.id}):`, upError.message);
      else updated += 1;
    }

    console.log(`... ${Math.min(i + 100, calls.length)}/${calls.length}`);
  }

  console.log(`Tugadi. O'chirilgan fayl: ${removed}, yangilangan qator: ${updated}.`);
}

main().catch((e) => {
  console.error('Tozalash xatosi:', e?.message || e);
  process.exit(1);
});
