// ============================================================================
// Mavjud xodim akkauntlariga shifrlangan parol nusxasini yozish (2026-10-16).
//
// create-operator-accounts.ts "12345678" bilan ochgan akkauntlar uchun: parol
// HAQIQATAN o'sha ekani bcrypt bilan tekshiriladi (direktor almashtirgan
// parolga tegilmaydi), keyin password_enc yoziladi — "Xodimlarni boshqarish"da
// parol ko'rinadi. supabase/staff_02_user_password_enc.sql AVVAL ishga
// tushirilgan bo'lishi va WEBHOOK_SECRET_ENC_KEY production qiymati bo'lishi shart.
//
//   npx tsx src/scripts/backfill-password-enc.ts --company=<uuid> [--password=12345678] [--apply]
// ============================================================================

import '../env';
import bcrypt from 'bcryptjs';
import { supabase } from '../lib/supabase';
import { encryptPassword } from '../lib/passwordVault';

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);

async function main() {
  const companyId = arg('company');
  const password = arg('password') ?? '12345678';
  const apply = process.argv.includes('--apply');
  if (!companyId) throw new Error('--company=<uuid> kerak.');
  if (!encryptPassword('test')) throw new Error('WEBHOOK_SECRET_ENC_KEY yo\'q yoki noto\'g\'ri.');
  const { data, error } = await supabase
    .from('users').select('id, name, email, password_hash, password_enc').eq('company_id', companyId).eq('role', 'user');
  if (error) throw new Error(error.message);
  let n = 0;
  for (const u of data || []) {
    if ((u as any).password_enc) { console.log(`  ${u.email} — allaqachon bor`); continue; }
    const ok = !!(u as any).password_hash && bcrypt.compareSync(password, (u as any).password_hash);
    if (!ok) { console.log(`  ${u.email} — parol boshqa (direktor almashtirgan), tegilmadi`); continue; }
    if (apply) {
      const { error: e } = await supabase.from('users').update({ password_enc: encryptPassword(password) }).eq('id', u.id);
      if (e) { console.log(`  ${u.email} — XATO: ${e.message}`); continue; }
    }
    n += 1;
    console.log(`  ${u.email} — ${apply ? 'yozildi ✓' : 'yoziladi'}`);
  }
  console.log(`\n${apply ? 'Yozildi' : 'Sinov, yoziladi'}: ${n} ta.`);
}
main().then(() => process.exit(0), (e) => { console.error(e?.message || e); process.exit(1); });
