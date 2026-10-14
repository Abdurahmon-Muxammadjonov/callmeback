import { supabase } from './supabase';

// ============================================================================
// HISOBOT RPC'LARI (2026-10-12).
//
// Hisobot endpointlari endi qatorlarni Node'ga tortmaydi (avval fetchAllRows
// 1000 tadan KETMA-KET o'qir edi — 30 kunlik hisobot 40+ so'rov, o'nlab
// soniya). Sanash Postgres funksiyalarida (supabase/perf_*.sql), bu yerda
// faqat bitta chaqiruv.
//
// Funksiya bazada hali yaratilmagan bo'lsa (SQL fayl ishga tushirilmagan),
// PostgREST PGRST202 qaytaradi — shunda qaysi faylni ishga tushirish
// kerakligini aniq aytadigan xato beramiz (500 javobda ko'rinadi).
// Node'dagi zaxira hisob ATAYLAB yo'q: u yana minglab qatorni tortardi.
// ============================================================================

const SQL_FILE = {
  calls_range_stats: 'perf_02_calls_range_stats.sql',
  calls_bucket_stats: 'perf_03_calls_bucket_stats.sql',
  calls_operator_daily: 'perf_04_calls_operator_daily.sql',
  calls_staff_day_stats: 'perf_05_calls_staff_day_stats.sql',
  calls_analysis_status: 'perf_06_calls_analysis_status.sql',
  company_call_totals: 'perf_07_company_totals.sql',
  company_analytics_root: 'perf_07_company_totals.sql',
  company_virtual_operators: 'perf_08_virtual_operators.sql',
  manager_call_stats: 'perf_09_manager_call_stats.sql',
  company_conversions_daily: 'perf_10_conversions_daily.sql',
  calls_operator_day_stats: 'perf_13_calls_operator_day_stats.sql',
} as const;

export type ReportFn = keyof typeof SQL_FILE;

export function isMissingFunctionError(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return error.code === 'PGRST202' || /could not find the function|no matches were found/i.test(error.message || '');
}

export async function reportRpc<T>(fn: ReportFn, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) {
    if (isMissingFunctionError(error)) {
      throw new Error(
        `${fn}() bazada topilmadi — Supabase SQL Editor'da supabase/perf_01_report_helpers.sql ` +
        `va supabase/${SQL_FILE[fn]} ni ishga tushiring.`,
      );
    }
    throw new Error(error.message);
  }
  return data as T;
}
