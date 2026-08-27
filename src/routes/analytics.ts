import { Router, Request, Response } from 'express';
import { supabase, fetchAllRows } from '../lib/supabase';

const router = Router();
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Berilgan tenant'dagi menejer id'lari (tenant filtri uchun). null = filtr yo'q.
async function managerIdsForTenant(tenantId: string | null): Promise<string[] | null> {
  if (!tenantId) return null;
  const { data, error } = await supabase.from('managers').select('id').eq('tenant_id', tenantId);
  if (error) throw new Error(error.message);
  return (data || []).map((m) => m.id);
}

// GET /analytics
// Frontend root endpoint so'rovlarida umumiy metrikani frontend kutgan formatda qaytaradi.
router.get('/', async (_req: Request, res: Response) => {
  try {
    const [callRows, convRows, lostReasonRows] = await Promise.all([
      fetchAllRows<{ id: string; duration: number | null }>((from, to) =>
        supabase.from('calls').select('id, duration').range(from, to)),
      fetchAllRows<{ traffic_conversion: number | null; sales_conversion: number | null }>((from, to) =>
        supabase.from('conversions').select('traffic_conversion, sales_conversion').range(from, to)),
      fetchAllRows<{ reason_text: string }>((from, to) =>
        supabase.from('lost_reasons').select('reason_text').range(from, to)),
    ]);

    const totalCalls = callRows.length;
    const averageDurationSeconds = totalCalls > 0
      ? Math.round(callRows.reduce((acc, row) => acc + (row.duration || 0), 0) / totalCalls)
      : 0;

    const averages = {
      traffic_conversion: convRows.length > 0
        ? Number((convRows.reduce((acc, row) => acc + Number(row.traffic_conversion || 0), 0) / convRows.length).toFixed(2))
        : 0,
      sales_conversion: convRows.length > 0
        ? Number((convRows.reduce((acc, row) => acc + Number(row.sales_conversion || 0), 0) / convRows.length).toFixed(2))
        : 0,
    };

    const lostReasonsSummary: Record<string, number> = {};
    lostReasonRows.forEach((row) => {
      lostReasonsSummary[row.reason_text] = (lostReasonsSummary[row.reason_text] || 0) + 1;
    });

    return res.status(200).json({
      success: true,
      data: {
        totalCalls,
        averageDurationSeconds,
        averages,
        lostReasonsSummary,
        cachedAt: new Date().toISOString(),
      },
      cached: false,
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: err?.message || 'Analytics root xatosi.',
    });
  }
});

// GET /analytics/overview?period=day|week|month&tenant_id=
// Frontend kutgan ko'rinishda day/week/month PoP statistikani bitta javobda qaytaradi.
// Hisob-kitobning o'zi DB tomonida (supabase/optimize_analytics_aggregates.sql'dagi
// calls_overview_stats, calls_pop_stats bilan bir xil naqsh) — har bir mos qo'ng'iroq
// qatorini Node'ga tortib sum/avg qilish o'rniga bitta so'rovda hisoblanadi, shu sabab
// katta davrlarda (ko'p qo'ng'iroqli oy) ham sekinlashmaydi.
router.get('/overview', async (req: Request, res: Response) => {
  try {
    const tenantId = typeof req.query.tenant_id === 'string' && req.query.tenant_id ? req.query.tenant_id : null;
    if (tenantId && !UUID_REGEX.test(tenantId)) {
      return res.status(400).json({ success: false, error: 'tenant_id yaroqli UUID bo\'lishi kerak.' });
    }

    const managerIds = await managerIdsForTenant(tenantId);

    const { data, error } = await supabase.rpc('calls_overview_stats', { p_manager_ids: managerIds });
    if (error) return res.status(500).json({ success: false, error: `Database Error: ${error.message}` });

    return res.status(200).json({ success: true, data });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Overview hisoblashda xatolik.' });
  }
});

// GET /analytics/daily-plan?manager_id=&date=YYYY-MM-DD
// Kunlik reja (daily_target) vs bajarilgan (o'sha kundagi qo'ng'iroqlar soni).
router.get('/daily-plan', async (req: Request, res: Response) => {
  try {
    const managerId = String(req.query.manager_id || '');
    if (!UUID_REGEX.test(managerId)) {
      return res.status(400).json({ success: false, error: 'manager_id yaroqli UUID bo\'lishi kerak.' });
    }
    const dateStr = typeof req.query.date === 'string' && req.query.date ? req.query.date : new Date().toISOString().slice(0, 10);
    const dayStart = new Date(`${dateStr}T00:00:00.000Z`);
    if (isNaN(dayStart.getTime())) {
      return res.status(400).json({ success: false, error: 'date YYYY-MM-DD formatda bo\'lishi kerak.' });
    }
    const dayEnd = new Date(dayStart);
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

    const [targetRes, achievedRes] = await Promise.all([
      supabase.from('daily_targets').select('daily_target, notes').eq('manager_id', managerId).eq('target_date', dateStr).maybeSingle(),
      supabase.from('calls').select('id', { count: 'exact', head: true }).eq('manager_id', managerId)
        .gte('created_at', dayStart.toISOString()).lt('created_at', dayEnd.toISOString()),
    ]);
    if (targetRes.error) throw new Error(targetRes.error.message);
    if (achievedRes.error) throw new Error(achievedRes.error.message);

    const target = targetRes.data?.daily_target ?? 0;
    const achieved = achievedRes.count ?? 0;
    return res.status(200).json({
      success: true,
      data: {
        manager_id: managerId,
        date: dateStr,
        daily_target: target,
        daily_achieved: achieved,
        remaining: Math.max(0, target - achieved),
        completion_pct: target > 0 ? Number(((achieved / target) * 100).toFixed(1)) : 0,
        notes: targetRes.data?.notes ?? null,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Daily plan o\'qishda xatolik.' });
  }
});

// POST /analytics/daily-plan  { manager_id, target_date?, daily_target, notes? }
// Kunlik rejani belgilash/yangilash (upsert).
router.post('/daily-plan', async (req: Request, res: Response) => {
  try {
    const { manager_id, target_date, daily_target, notes } = req.body ?? {};
    if (!manager_id || !UUID_REGEX.test(String(manager_id))) {
      return res.status(400).json({ success: false, error: 'manager_id yaroqli UUID bo\'lishi kerak.' });
    }
    if (daily_target === undefined || Number(daily_target) < 0) {
      return res.status(400).json({ success: false, error: 'daily_target manfiy bo\'lmagan son bo\'lishi kerak.' });
    }
    const date = target_date || new Date().toISOString().slice(0, 10);
    const { data, error } = await supabase
      .from('daily_targets')
      .upsert(
        { manager_id, target_date: date, daily_target: Math.floor(Number(daily_target)), notes: notes ?? null },
        { onConflict: 'manager_id,target_date' }
      )
      .select('*')
      .single();
    if (error) return res.status(500).json({ success: false, error: `Database Error: ${error.message}` });
    return res.status(200).json({ success: true, data });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Daily plan saqlashda xatolik.' });
  }
});

// GET /analytics/funnel?tenant_id=
// Voronka: har bosqichdagi leadlar soni + drop-off (tushish) foizi + umumiy konversiya.
const FUNNEL_ORDER = ['lead_generated', 'contacted', 'qualified', 'proposal', 'negotiation', 'deal_closed'];
router.get('/funnel', async (req: Request, res: Response) => {
  try {
    const tenantId = typeof req.query.tenant_id === 'string' && req.query.tenant_id ? req.query.tenant_id : null;
    if (tenantId && !UUID_REGEX.test(tenantId)) {
      return res.status(400).json({ success: false, error: 'tenant_id yaroqli UUID bo\'lishi kerak.' });
    }

    let q = supabase.from('leads').select('stage, value');
    if (tenantId) q = q.eq('tenant_id', tenantId);
    const { data, error } = await q;
    if (error) return res.status(500).json({ success: false, error: `Database Error: ${error.message}` });

    const counts: Record<string, number> = {};
    const values: Record<string, number> = {};
    (data || []).forEach((l) => {
      counts[l.stage] = (counts[l.stage] || 0) + 1;
      values[l.stage] = (values[l.stage] || 0) + (Number(l.value) || 0);
    });

    // Bosqichlar + oldingi bosqichdan tushish (drop-off) foizi.
    const stages = FUNNEL_ORDER.map((stage, i) => {
      const count = counts[stage] || 0;
      const prevCount = i === 0 ? count : counts[FUNNEL_ORDER[i - 1]] || 0;
      const dropOffPct = i === 0 ? 0 : prevCount > 0 ? Number((((prevCount - count) / prevCount) * 100).toFixed(1)) : 0;
      return { stage, count, total_value: Number((values[stage] || 0).toFixed(2)), drop_off_pct: dropOffPct };
    });

    const generated = counts['lead_generated'] || 0;
    const closed = counts['deal_closed'] || 0;
    return res.status(200).json({
      success: true,
      data: {
        stages,
        lost: counts['lost'] || 0,
        overall_conversion_pct: generated > 0 ? Number(((closed / generated) * 100).toFixed(1)) : 0,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Funnel hisoblashda xatolik.' });
  }
});

// GET /analytics/pop?platform_id=
// Dinamik Period-over-Period (kunlik/haftalik/oylik) — DB funksiyasidan bitta JSON.
router.get('/pop', async (req: Request, res: Response) => {
  try {
    const platformId = typeof req.query.platform_id === 'string' && req.query.platform_id ? req.query.platform_id : null;
    const { data, error } = await supabase.rpc('calls_pop_stats', { p_platform_id: platformId });
    if (error) return res.status(500).json({ success: false, error: `Database Error: ${error.message}` });
    return res.status(200).json({ success: true, data });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'PoP hisoblashda xatolik.' });
  }
});

export default router;

