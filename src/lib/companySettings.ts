import type { SupabaseClient } from '@supabase/supabase-js';

// "Analitika" sahifasidagi KPI ogohlantirish banneri va xodim kartalaridagi
// "NORMA OSTIDA" belgisi, shuningdek backendning o'z jarima/flag mantig'i
// (evaluateManagerKpi, src/routes/analyze-call.ts) shu qiymatlarga tayanadi —
// bitta joyda saqlab, ikkalasi ham SHU YERDAN o'qiydi (dublikat const bo'lmasin).
export interface CompanySettings {
  qualified_call_seconds: number;
  min_qualified_calls_day: number;
  min_qualified_calls_week: number;
  min_qualified_calls_month: number;
  min_efficiency_score: number;
}

export const DEFAULT_COMPANY_SETTINGS: CompanySettings = {
  qualified_call_seconds: 60,
  min_qualified_calls_day: 40,
  min_qualified_calls_week: 160,
  min_qualified_calls_month: 640,
  min_efficiency_score: 50,
};

export const COMPANY_SETTINGS_COLUMNS = Object.keys(DEFAULT_COMPANY_SETTINGS) as Array<keyof CompanySettings>;

// company_id=null (hali kompaniyaga bog'lanmagan menejer/eski PBX pipeline) yoki
// company_settings qatori hali yaratilmagan bo'lsa — standart qiymatlar bilan
// ishlaydi, xato bermaydi (insert/seed qadami shart emas).
export async function getCompanySettings(
  supabase: SupabaseClient,
  companyId: string | null | undefined,
): Promise<CompanySettings> {
  if (!companyId) return DEFAULT_COMPANY_SETTINGS;

  const { data, error } = await supabase
    .from('company_settings')
    .select(COMPANY_SETTINGS_COLUMNS.join(', '))
    .eq('company_id', companyId)
    .maybeSingle();

  if (error || !data) return DEFAULT_COMPANY_SETTINGS;
  return data as unknown as CompanySettings;
}
