import { Router, Response } from 'express';
import { supabase, fetchAllRows } from '../lib/supabase';
import { requireAuth, type CompanyAuthedRequest } from '../middleware/companyAuth';

const router = Router();

function startOfMonthUTC(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

// ============================================================================
// GET /dashboard/stats — HAR bir son company_id bo'yicha filtrlangan
// ============================================================================
router.get('/stats', requireAuth, async (req: CompanyAuthedRequest, res: Response) => {
  const companyId = req.auth!.companyId as string;

  try {
    const [totalCallsRes, callsThisMonthRes, activeAgentsRes, kpiRows] = await Promise.all([
      // count:'exact', head:true — real DB-darajasidagi son, PostgREST'ning
      // 1000-qatorlik standart javob chegarasiga umuman ta'sirlanmaydi
      // (avvalgi /analytics buggida bo'lgani kabi — bu yerda o'sha xato
      // TAKRORLANMAGAN, boshidanoq to'g'ri yozilgan).
      supabase.from('calls').select('id', { count: 'exact', head: true }).eq('company_id', companyId),
      supabase.from('calls').select('id', { count: 'exact', head: true }).eq('company_id', companyId).gte('created_at', startOfMonthUTC()),
      supabase.from('managers').select('id', { count: 'exact', head: true }).eq('company_id', companyId).eq('status', 'active'),
      // avg_score uchun haqiqiy qiymatlar kerak — fetchAllRows bilan (1000
      // qatordan katta bo'lsa ham to'g'ri hisoblansin, xuddi /analytics
      // tuzatilgandagi kabi).
      fetchAllRows<{ kpi_score: number | null }>((from, to) =>
        supabase.from('calls').select('kpi_score').eq('company_id', companyId).range(from, to)),
    ]);

    if (totalCallsRes.error) throw new Error(totalCallsRes.error.message);
    if (callsThisMonthRes.error) throw new Error(callsThisMonthRes.error.message);
    if (activeAgentsRes.error) throw new Error(activeAgentsRes.error.message);

    // avg_score: yozuv bo'lmasa Postgres AVG() NULL qaytaradi — frontend buni
    // "0" emas, "Hali baho yo'q" deb ko'rsatishi kerak, shu sabab bo'sh
    // bo'lsa qat'iy NULL qaytaramiz (0 emas).
    const avgScore = kpiRows.length > 0
      ? Number((kpiRows.reduce((sum, r) => sum + (Number(r.kpi_score) || 0), 0) / kpiRows.length).toFixed(2))
      : null;

    return res.status(200).json({
      success: true,
      data: {
        total_calls: totalCallsRes.count ?? 0,
        // Bu loyihada "campaigns" tushunchasi hali mavjud emas (faqat
        // managers + calls bor) — shu sabab doim 0. campaigns jadvali
        // qo'shilsa, shu yerga xuddi yuqoridagidek count so'rovi qo'shiladi
        // (supabase/company_branding.sql'dagi izohga qarang).
        total_campaigns: 0,
        avg_score: avgScore,
        calls_this_month: callsThisMonthRes.count ?? 0,
        active_agents: activeAgentsRes.count ?? 0,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Dashboard stats xatosi.' });
  }
});

export default router;
