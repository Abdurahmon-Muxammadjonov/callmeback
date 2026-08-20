import type { SupabaseClient } from '@supabase/supabase-js';

// Bo'lim kalitlari — kelajakda yangi bo'lim qo'shilsa shu ro'yxatga bitta
// qator qo'shish kifoya, boshqa hech narsa o'zgarmaydi.
export const LOCKABLE_SECTIONS = ['call_analytics', 'reports', 'campaigns'] as const;
export type LockableSection = typeof LOCKABLE_SECTIONS[number];

// dashboard va webhook_integration company_sections'da UMUMAN saqlanmaydi —
// har doim ochiq (spec: "excluded from this table entirely").
export const ALWAYS_UNLOCKED_SECTIONS = ['dashboard', 'webhook_integration'] as const;

export function isLockableSection(key: string): key is LockableSection {
  return (LOCKABLE_SECTIONS as readonly string[]).includes(key);
}

// Telegram bot xabarlarida (kod har bir bo'lim nomi bilan yuboriladi — tarif
// prompt 3-band) va boshqa foydalanuvchiga ko'rinadigan joylarda ishlatiladi.
export const SECTION_LABELS: Record<LockableSection, string> = {
  call_analytics: "Qo'ng'iroqlar tahlili",
  reports: 'Hisobotlar',
  campaigns: 'Kampaniyalar',
};

/**
 * Bitta bo'lim ochiqmi (AI-gating va boshqa joylarda ishlatish uchun).
 * `company_sections`da qator yo'qligi = qulflangan (default TRUE) — shu
 * sabab "topilmadi" ham "locked" deb hisoblanadi, xato emas.
 */
export async function isSectionUnlocked(
  supabase: SupabaseClient,
  companyId: string,
  sectionKey: string,
): Promise<boolean> {
  if ((ALWAYS_UNLOCKED_SECTIONS as readonly string[]).includes(sectionKey)) return true;

  const { data } = await supabase
    .from('company_sections')
    .select('is_locked')
    .eq('company_id', companyId)
    .eq('section_key', sectionKey)
    .maybeSingle();

  if (!data) return false; // qator yo'q = hali qulflangan (default holat)
  return data.is_locked === false;
}
