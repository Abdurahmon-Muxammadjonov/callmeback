// Sotuv skriptini kompaniyaning "Mezonlar" bo'limiga yozadi.
// Shundan keyin skript dashboardda ko'rinadi VA tahrirlansa, AI baholashi
// ham o'zgaradi (routes/analyze-call.ts -> splitScriptCriteria).
// Ishlatish: npx tsx src/scripts/seed-script-criteria.ts
import { config } from 'dotenv';
config({ path: '/Users/macbook/procell-backend/.env.local' });
import { supabase } from '../lib/supabase';
import { FRESH_LEAD_SCRIPT, REACTIVATION_SCRIPT } from '../lib/evaluationScript';

const COMPANY = process.env.SEED_COMPANY_ID || '24823352-465e-43ea-913c-9f9d7270b9e9';

async function main() {
  const rows = [
    ...FRESH_LEAD_SCRIPT.map((st) => ({ st, category: 'Skript: Yangi lid' })),
    ...REACTIVATION_SCRIPT.map((st) => ({ st, category: 'Skript: Eski baza' })),
  ].map(({ st, category }) => ({
    company_id: COMPANY,
    title: st.title,
    description: st.checks.map((c) => `- ${c}`).join('\n'),
    category,
    weight: st.points,
    penalty_amount: 0,
    is_active: true,
    type: 'Majburiy' as const,
  }));

  const { data: existing } = await supabase.from('criteria').select('id, title, category')
    .eq('company_id', COMPANY).ilike('category', 'Skript%');
  const have = new Map((existing || []).map((e: any) => [`${e.category}::${e.title}`, e.id]));

  let added = 0, updated = 0;
  for (const r of rows) {
    const key = `${r.category}::${r.title}`;
    const id = have.get(key);
    if (id) {
      await supabase.from('criteria').update({ description: r.description, weight: r.weight, is_active: true }).eq('id', id);
      updated++;
    } else {
      const { error } = await supabase.from('criteria').insert(r);
      if (error) console.warn(`  xato (${r.title}):`, error.message);
      else added++;
    }
  }
  console.log(`Skript mezonlari: ${added} ta qo'shildi, ${updated} ta yangilandi`);

  const { data: all } = await supabase.from('criteria').select('category').eq('company_id', COMPANY);
  const cats = new Map<string, number>();
  (all || []).forEach((c: any) => cats.set(String(c.category), (cats.get(String(c.category)) || 0) + 1));
  console.log('Kompaniya mezon kategoriyalari:', [...cats.entries()].map(([c, n]) => `${c} (${n})`).join(' | '));
}
main().then(() => process.exit(0)).catch((e) => { console.error('XATO:', e.message); process.exit(1); });
