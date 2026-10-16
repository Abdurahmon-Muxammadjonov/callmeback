// ============================================================================
// OPERATOR NOMI — BITTA MANBA (2026-10-16)
//
// Foydalanuvchi talabi: "Xodimlarni boshqarish"da xodimning ismi
// o'zgartirilsa (masalan Operator 110 -> "Jahon"), u HAMMA panelda —
// Analitika, Operatorlar, Xodimlar statistikasi, Audio yozuvlar, Boshqaruv,
// Solishtirish, Tahlil holati va xodimning o'z kabinetida — shu ism bilan
// ko'rinsin.
//
// UTel operatorlari managers jadvalida yo'q (virtual, lib/virtualOperators.ts)
// va nomi ichki raqamdan "Operator 110" deb yasalardi. Endi akkaunt
// (users.operator_ext) bog'langan raqam uchun users.name ishlatiladi; akkaunti
// yo'q raqam eski "Operator 110" ko'rinishida qoladi.
//
// Kesh: kompaniya bo'yicha 30 soniya (har hisobot so'rovida qo'shimcha DB
// so'rovi bo'lmasin). /users orqali ism yoki raqam o'zgarsa kesh DARHOL
// tozalanadi (invalidateOperatorNames) — o'zgarish shu zahoti ko'rinadi.
// ============================================================================

import { supabase } from './supabase';

const TTL_MS = 30_000;
const cache = new Map<string, { at: number; names: Map<string, string> }>();

export async function operatorNamesByExt(companyId: string | null | undefined): Promise<Map<string, string>> {
  if (!companyId) return new Map();
  const hit = cache.get(companyId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.names;
  const { data, error } = await supabase
    .from('users')
    .select('name, operator_ext')
    .eq('company_id', companyId)
    .not('operator_ext', 'is', null);
  // Xato bo'lsa hisobot yiqilmasin — "Operator N" ko'rinishida qoladi.
  const names = new Map<string, string>();
  if (!error) {
    for (const u of (data || []) as Array<{ name: string | null; operator_ext: string | null }>) {
      const ext = String(u.operator_ext ?? '').trim();
      const name = String(u.name ?? '').trim();
      if (ext && name) names.set(ext, name);
    }
  }
  cache.set(companyId, { at: Date.now(), names });
  return names;
}

export function invalidateOperatorNames(companyId: string | null | undefined): void {
  if (companyId) cache.delete(companyId);
}

/** Ko'rsatiladigan nom: akkaunt ismi > xodim (managers) nomi > "Operator <raqam>". */
export function operatorLabel(
  ext: string | null | undefined,
  nameByExt: Map<string, string> | undefined,
  fallback?: string | null,
): string {
  const e = String(ext ?? '').trim();
  return (e && nameByExt?.get(e)) || fallback || (e ? `Operator ${e}` : 'Noma\'lum');
}
