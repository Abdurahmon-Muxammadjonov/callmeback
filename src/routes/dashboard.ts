import { Router, Response } from 'express';
import { supabase } from '../lib/supabase';
import { reportRpc } from '../lib/reportRpc';
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
    // TEZLIK (2026-10-12): avg_score uchun butun tarixdagi kpi_score'lar
    // (15 000+ qator) fetchAllRows bilan 1000 tadan tortilardi. Endi jami,
    // oylik son va kpi yig'indisi bitta RPC'da (supabase/perf_07_company_totals.sql).
    // Hammasi DB darajasidagi son — PostgREST'ning 1000 qatorlik chegarasiga
    // ta'sirlanmaydi.
    const [totals, activeAgentsRes] = await Promise.all([
      reportRpc<Array<{ total_calls: number; calls_since: number; kpi_sum: number }>>('company_call_totals', {
        p_company_id: companyId,
        p_since: startOfMonthUTC(),
      }),
      supabase.from('managers').select('id', { count: 'exact', head: true }).eq('company_id', companyId).eq('status', 'active'),
    ]);

    if (activeAgentsRes.error) throw new Error(activeAgentsRes.error.message);
    const t = (totals || [])[0];
    const totalCalls = Number(t?.total_calls) || 0;

    // avg_score: yozuv bo'lmasa Postgres AVG() NULL qaytaradi — frontend buni
    // "0" emas, "Hali baho yo'q" deb ko'rsatishi kerak, shu sabab bo'sh
    // bo'lsa qat'iy NULL qaytaramiz (0 emas). Null kpi 0 deb olinib HAMMA
    // qatorga bo'linadi (eski hisob bilan bir xil: avg(coalesce(kpi,0))).
    const avgScore = totalCalls > 0
      ? Number(((Number(t?.kpi_sum) || 0) / totalCalls).toFixed(2))
      : null;

    return res.status(200).json({
      success: true,
      data: {
        total_calls: totalCalls,
        // Bu loyihada "campaigns" tushunchasi hali mavjud emas (faqat
        // managers + calls bor) — shu sabab doim 0. campaigns jadvali
        // qo'shilsa, shu yerga xuddi yuqoridagidek count so'rovi qo'shiladi
        // (supabase/company_branding.sql'dagi izohga qarang).
        total_campaigns: 0,
        avg_score: avgScore,
        calls_this_month: Number(t?.calls_since) || 0,
        active_agents: activeAgentsRes.count ?? 0,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Dashboard stats xatosi.' });
  }
});

export default router;
