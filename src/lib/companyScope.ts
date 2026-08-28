import { supabase } from './supabase';

// Ko'p joyda (analytics.ts, management.ts) kerak: "shu kompaniyaga tegishli
// menejerlar id ro'yxati" — legacy calls_overview_stats/calls_pop_stats/
// calls_relationship_dynamics RPC'lari to'g'ridan-to'g'ri company_id emas,
// p_manager_ids uuid[] orqali filtrlaydi (RPC'lar `calls` jadvalini to'g'ridan
// -to'g'ri o'qiydi, company_id ustuniga ega bo'lsa ham eski qatorlar uchun
// manager_id orqali filtrlash ishonchliroq — legacy PBX pipeline'idan kelgan
// calls.company_id=NULL bo'lgan qatorlarni ham manager_id orqali to'g'ri
// tenant'ga bog'lab bo'ladi, agar manager o'zi company_id'ga ega bo'lsa).
export async function getCompanyManagerIds(companyId: string): Promise<string[]> {
  const { data, error } = await supabase.from('managers').select('id').eq('company_id', companyId);
  if (error) throw new Error(error.message);
  return (data || []).map((m) => m.id);
}
