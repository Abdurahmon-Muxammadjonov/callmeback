import { reportRpc } from './reportRpc';
import {
  popRanges, rangesArg, buildPopStats, buildRelationshipDynamics, addDays,
  type RangeStatRow, type BucketRow,
} from './reportBuilders';

// ============================================================================
// /analytics/pop, /analytics/overview va /api/management/relationship-dynamics
// uchun yig'indilar.
//
// TEZLIK (2026-10-12): avval bu yerda analyticsFallback.ts turardi —
// kompaniyaning oxirgi ~2 oylik BARCHA qatorini fetchAllRows bilan tortib
// (kuniga 1300+ qo'ng'iroq => 40+ ketma-ket so'rov) Node'da sanardi. Endi
// hisob bazada (supabase/perf_02, perf_03), bu yerda faqat bitta RPC va
// JSON yig'ish (reportBuilders.ts). JSON shakli o'zgarmagan.
//
// TENANT CHEGARASI: calls.company_id (xodimga biriktirilmagan qo'ng'iroqlar
// ham kirsin — 2026-09-23 dan qo'ng'iroq xodim yaratmasdan yoziladi).
// ============================================================================

export async function popStats(companyId: string): Promise<Record<string, unknown>> {
  const now = new Date();
  const rows = await reportRpc<RangeStatRow[]>('calls_range_stats', {
    p_company_id: companyId,
    p_ranges: rangesArg(popRanges(now)),
  });
  return buildPopStats(rows || [], now);
}

/** /analytics/overview — PoP bilan aynan bir xil shakl. */
export async function overviewStats(companyId: string): Promise<Record<string, unknown>> {
  return popStats(companyId);
}

export async function relationshipDynamics(companyId: string, platformId: string | null): Promise<unknown[]> {
  const today = new Date().toISOString().slice(0, 10); // UTC kuni
  const rows = await reportRpc<BucketRow[]>('calls_bucket_stats', {
    p_company_id: companyId,
    p_from: `${addDays(today, -13)}T00:00:00Z`,
    p_tz: 'UTC',
    p_platform_id: platformId,
  });
  return buildRelationshipDynamics(rows || [], today);
}
