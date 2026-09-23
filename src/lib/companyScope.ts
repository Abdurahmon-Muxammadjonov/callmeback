import { supabase } from './supabase';

// Ko'p joyda (analytics.ts, management.ts) kerak: "shu kompaniyaga tegishli
// menejerlar id ro'yxati" — calls_overview_stats/calls_pop_stats/
// calls_relationship_dynamics RPC'lari p_manager_ids uuid[] orqali filtrlaydi.
//
// OPTIMALLASH (2026-09-23): Analitika sahifasi bir zumda bir necha
// endpoint chaqiradi (overview + pop + management), har biri shu funksiyani
// chaqirar va har chaqiruv alohida Supabase so'rovi (~0.6s) edi — ular
// yig'ilib sahifani sekinlashtirar edi. Endi natija kompaniya bo'yicha
// qisqa muddat (60s) keshlanadi: ketma-ket va tez-tez qayta chaqiruvlar
// bitta so'rovga tushadi. Yangi xodim/qo'ng'iroq qo'shilishi 60s ichida
// aks etmasligi mumkin — analitika uchun bu maqbul (real-time shart emas).
const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { at: number; ids: string[] }>();

export async function getCompanyManagerIds(companyId: string): Promise<string[]> {
  const hit = cache.get(companyId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.ids;

  const { data, error } = await supabase.from('managers').select('id').eq('company_id', companyId);
  if (error) throw new Error(error.message);
  const ids = (data || []).map((m) => m.id);
  cache.set(companyId, { at: Date.now(), ids });
  return ids;
}

// Xodim qo'shil/o'chirilganda (managers.ts) chaqiriladi — kesh eskirmasin.
export function invalidateCompanyManagerIds(companyId: string): void {
  cache.delete(companyId);
}
