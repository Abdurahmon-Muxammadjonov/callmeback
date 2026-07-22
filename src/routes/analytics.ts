import { Router, Request, Response } from 'express';
import { supabase } from '../lib/supabase';

const router = Router();
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Period = 'day' | 'week' | 'month';

interface Range {
  curStart: Date;
  curEnd: Date;
  prevStart: Date;
  prevEnd: Date;
}

// Joriy va oldingi davr chegaralari (UTC): bugun↔kecha, shu hafta↔o'tgan hafta, shu oy↔o'tgan oy.
function periodRanges(period: Period): Range {
  const now = new Date();
  const startOfToday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  if (period === 'week') {
    const isoDow = (startOfToday.getUTCDay() + 6) % 7; // 0 = Dushanba
    const curStart = new Date(startOfToday);
    curStart.setUTCDate(curStart.getUTCDate() - isoDow);
    const prevStart = new Date(curStart);
    prevStart.setUTCDate(prevStart.getUTCDate() - 7);
    return { curStart, curEnd: now, prevStart, prevEnd: curStart };
  }
  if (period === 'month') {
    const curStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const prevStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    return { curStart, curEnd: now, prevStart, prevEnd: curStart };
  }
  // day
  const curStart = startOfToday;
  const prevStart = new Date(curStart);
  prevStart.setUTCDate(prevStart.getUTCDate() - 1);
  return { curStart, curEnd: now, prevStart, prevEnd: curStart };
}

// Period-over-period o'zgarish foizi (oldingi 0 bo'lsa xavfsiz).
function pctChange(current: number, previous: number): number {
  if (previous === 0) return current > 0 ? 100 : 0;
  return Number((((current - previous) / previous) * 100).toFixed(1));
}

// Berilgan tenant'dagi menejer id'lari (tenant filtri uchun). null = filtr yo'q.
async function managerIdsForTenant(tenantId: string | null): Promise<string[] | null> {
  if (!tenantId) return null;
  const { data, error } = await supabase.from('managers').select('id').eq('tenant_id', tenantId);
  if (error) throw new Error(error.message);
  return (data || []).map((m) => m.id);
}

interface CallAgg {
  total_calls: number;
  avg_kpi_score: number;
  avg_duration_sec: number;
  total_duration_sec: number;
  total_penalty: number;
  total_bonus: number;
}

// GET /analytics
// Frontend root endpoint so'rovlarida umumiy metrikani frontend kutgan formatda qaytaradi.
router.get('/', async (_req: Request, res: Response) => {
  try {
    const [callsRes, conversionsRes, lostReasonsRes] = await Promise.all([
      supabase.from('calls').select('id, duration'),
      supabase.from('conversions').select('traffic_conversion, sales_conversion'),
      supabase.from('lost_reasons').select('reason_text'),
    ]);

    if (callsRes.error) throw new Error(callsRes.error.message);
    if (conversionsRes.error) throw new Error(conversionsRes.error.message);
    if (lostReasonsRes.error) throw new Error(lostReasonsRes.error.message);

    const totalCalls = callsRes.data?.length || 0;
    const averageDurationSeconds = totalCalls > 0
      ? Math.round((callsRes.data?.reduce((acc, row) => acc + (row.duration || 0), 0) || 0) / totalCalls)
      : 0;

    const convRows = conversionsRes.data || [];
    const averages = {
      traffic_conversion: convRows.length > 0
        ? Number((convRows.reduce((acc, row) => acc + Number(row.traffic_conversion || 0), 0) / convRows.length).toFixed(2))
        : 0,
      sales_conversion: convRows.length > 0
        ? Number((convRows.reduce((acc, row) => acc + Number(row.sales_conversion || 0), 0) / convRows.length).toFixed(2))
        : 0,
    };

    const lostReasonsSummary: Record<string, number> = {};
    (lostReasonsRes.data || []).forEach((row) => {
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

// Bitta davr uchun qo'ng'iroq-asosli metrikalar.
async function aggregateCalls(start: Date, end: Date, managerIds: string[] | null): Promise<CallAgg> {
  let q = supabase
    .from('calls')
    .select('kpi_score, duration, penalty_amount, bonus_amount')
    .gte('created_at', start.toISOString())
    .lt('created_at', end.toISOString());
  if (managerIds) {
    if (managerIds.length === 0) return { total_calls: 0, avg_kpi_score: 0, avg_duration_sec: 0, total_duration_sec: 0, total_penalty: 0, total_bonus: 0 };
    q = q.in('manager_id', managerIds);
  }
  const { data, error } = await q;
  if (error) throw new Error(error.message);

  const rows = data || [];
  const n = rows.length;
  const sum = (f: (r: any) => number) => rows.reduce((a, r) => a + (Number(f(r)) || 0), 0);
  const totalDurationSec = Math.round(sum((r) => r.duration));
  return {
    total_calls: n,
    avg_kpi_score: n ? Number((sum((r) => r.kpi_score) / n).toFixed(2)) : 0,
    avg_duration_sec: n ? Math.round(sum((r) => r.duration) / n) : 0,
    total_duration_sec: totalDurationSec,
    total_penalty: Number(sum((r) => r.penalty_amount).toFixed(2)),
    total_bonus: Number(sum((r) => r.bonus_amount).toFixed(2)),
  };
}

// GET /analytics/overview?period=day|week|month&tenant_id=
// Frontend kutgan ko'rinishda day/week/month PoP statistikani bitta javobda qaytaradi.
router.get('/overview', async (req: Request, res: Response) => {
  try {
    const tenantId = typeof req.query.tenant_id === 'string' && req.query.tenant_id ? req.query.tenant_id : null;
    if (tenantId && !UUID_REGEX.test(tenantId)) {
      return res.status(400).json({ success: false, error: 'tenant_id yaroqli UUID bo\'lishi kerak.' });
    }

    const managerIds = await managerIdsForTenant(tenantId);

    const summarizePeriod = async (period: Period) => {
      const { curStart, curEnd, prevStart, prevEnd } = periodRanges(period);
      const [current, previous] = await Promise.all([
        aggregateCalls(curStart, curEnd, managerIds),
        aggregateCalls(prevStart, prevEnd, managerIds),
      ]);

      const currentDurationMinutes = Number((current.total_duration_sec / 60).toFixed(1));
      const previousDurationMinutes = Number((previous.total_duration_sec / 60).toFixed(1));

      return {
        calls: {
          current: current.total_calls,
          previous: previous.total_calls,
          change_pct: pctChange(current.total_calls, previous.total_calls),
        },
        duration_minutes: {
          current: currentDurationMinutes,
          previous: previousDurationMinutes,
          change_pct: pctChange(currentDurationMinutes, previousDurationMinutes),
        },
        avg_kpi: {
          current: current.avg_kpi_score,
          previous: previous.avg_kpi_score,
          change_pct: pctChange(current.avg_kpi_score, previous.avg_kpi_score),
        },
      };
    };

    const [daily, weekly, monthly] = await Promise.all([
      summarizePeriod('day'),
      summarizePeriod('week'),
      summarizePeriod('month'),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        daily,
        weekly,
        monthly,
        generated_at: new Date().toISOString(),
      },
    });
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

