// ============================================================================
// TELEFONIYA OPERATORLARIGA AKKAUNT OCHISH (2026-10-15).
//
// Foydalanuvchi talabi: telefondan (UTel) kelgan har bir menejerga o'z nomi
// bilan akkaunt ochilsin, parol hammasida "12345678", ish vaqti 09:00–20:00,
// email vaqtinchalik (operator<raqam>@<domain>) — direktor keyin "Xodimlarni
// boshqarish"da o'zi almashtiradi. Akkaunt operatorga
// users.operator_ext orqali bog'lanadi (supabase/staff_01_user_operator_ext.sql
// AVVAL ishga tushirilgan bo'lishi shart) — xodim kirganda faqat o'z
// qo'ng'iroqlari, tahlili, skriptlari va maslahatlarini ko'radi.
//
// Operatorlar: kompaniyaning haqiqiy managers qatorlari (pbx_id bilan) +
// qo'ng'iroqlardagi "virtual" operatorlar (lib/virtualOperators.ts).
// Allaqachon akkaunti bor raqam (operator_ext) yoki band email — tegilmaydi.
//
// Ishlatish (Supabase kalitlari bilan):
//   npx tsx src/scripts/create-operator-accounts.ts --company=<uuid>            # sinov: nima qilinishini ko'rsatadi
//   npx tsx src/scripts/create-operator-accounts.ts --company=<uuid> --apply    # bazaga yozadi
//   [--password=12345678] [--domain=procell.uz] [--shift=09:00-20:00]  (login: operator<raqam>@<domain>)
// ============================================================================

import '../env';
import bcrypt from 'bcryptjs';
import { supabase } from '../lib/supabase';
import { listVirtualOperators } from '../lib/virtualOperators';

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

async function main() {
  const companyId = arg('company');
  const apply = process.argv.includes('--apply');
  const password = arg('password') ?? '12345678';
  const domain = (arg('domain') ?? 'procell.uz').replace(/^@/, '');
  const [shiftStart, shiftEnd] = (arg('shift') ?? '09:00-20:00').split('-');
  if (!/^\d{2}:\d{2}$/.test(shiftStart || '') || !/^\d{2}:\d{2}$/.test(shiftEnd || '')) throw new Error('--shift=HH:MM-HH:MM bo\'lsin.');
  if (!companyId) throw new Error('--company=<uuid> kerak.');

  const [{ data: real, error: mErr }, virtual, { data: users, error: uErr }] = await Promise.all([
    supabase.from('managers').select('id, name, pbx_id').eq('company_id', companyId),
    listVirtualOperators(companyId),
    supabase.from('users').select('id, email, operator_ext').eq('company_id', companyId),
  ]);
  if (mErr) throw new Error(mErr.message);
  if (uErr) throw new Error(`users o'qilmadi (staff_01 SQL ishga tushirilganmi?): ${uErr.message}`);

  // Raqam -> nom (haqiqiy xodim nomi ustun, aks holda "Operator 105").
  const byExt = new Map<string, string>();
  for (const v of virtual) byExt.set(String(v.pbx_id).trim(), v.name);
  for (const m of real || []) {
    const ext = String((m as any).pbx_id ?? '').trim();
    if (/^\d{1,8}$/.test(ext)) byExt.set(ext, m.name);
  }
  const taken = new Set((users || []).map((u: any) => String(u.operator_ext ?? '').trim()).filter(Boolean));

  const exts = [...byExt.keys()].filter((e) => /^\d{1,8}$/.test(e)).sort((a, b) => Number(a) - Number(b));
  const hash = bcrypt.hashSync(password, 10);
  let created = 0;
  console.log(`${exts.length} ta operator topildi. ${apply ? 'YOZILADI' : 'SINOV (--apply berilmagan, hech narsa yozilmaydi)'}\n`);
  for (const ext of exts) {
    const name = byExt.get(ext)!;
    const email = `operator${ext}@${domain}`;
    if (taken.has(ext)) {
      console.log(`  ${ext.padEnd(6)} ${name.padEnd(24)} — akkaunti bor, o'tkazildi`);
      continue;
    }
    if (!apply) {
      console.log(`  ${ext.padEnd(6)} ${name.padEnd(24)} → ${email}`);
      continue;
    }
    const { error } = await supabase.from('users').insert({
      name, email, role: 'user', company_id: companyId, operator_ext: ext, password_hash: hash,
      shift_start: shiftStart, shift_end: shiftEnd,
    });
    if (error) {
      console.log(`  ${ext.padEnd(6)} ${name.padEnd(24)} — XATO: ${error.code === '23505' ? 'email yoki raqam band' : error.message}`);
      continue;
    }
    created += 1;
    console.log(`  ${ext.padEnd(6)} ${name.padEnd(24)} → ${email}  ✓`);
  }
  console.log(`\n${apply ? `Ochildi: ${created} ta akkaunt.` : 'Sinov tugadi.'} Parol: ${password}, ish vaqti: ${shiftStart}–${shiftEnd}`);
}

main().then(() => process.exit(0), (e) => { console.error(e?.message || e); process.exit(1); });
