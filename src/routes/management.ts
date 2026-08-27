import { Router, Request, Response } from 'express';
import { supabase, fetchAllRows } from '../lib/supabase';

const router = Router();

// Sana kaliti (UTC, YYYY-MM-DD)
const dayKey = (d: Date) => d.toISOString().slice(0, 10);
function startOfTodayUTC(): Date {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
}
function daysAgo(base: Date, n: number): Date {
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

// GET /api/management/platforms — mavjud platformalar ro'yxati
router.get('/platforms', async (_req: Request, res: Response) => {
  try {
    const { data, error } = await supabase
      .from('platforms')
      .select('id, name, tagline, initials, accent')
      .order('created_at', { ascending: true });
    if (error) return res.status(500).json({ success: false, error: `Database Error: ${error.message}` });
    return res.status(200).json({ success: true, data: data || [] });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Platforms o\'qishda xatolik.' });
  }
});

// GET /api/management/relationship-dynamics?platform_id=
// "Sabablarsiz munosabatlar" — javobsiz va bad-lead metrikalarining vaqt dinamikasi.
// Hisob-kitob DB tomonida (supabase/optimize_analytics_aggregates.sql'dagi
// calls_relationship_dynamics) — 14 kunlik oynadagi har bir qo'ng'iroq qatorini
// Node'ga tortib JS'da kun bo'yicha filtrlash o'rniga, bitta so'rovda kunlik
// jamlangan holda qaytadi (faol platformada bu son katta bo'lsa ham sekinlashmaydi).
router.get('/relationship-dynamics', async (req: Request, res: Response) => {
  try {
    const platformId = typeof req.query.platform_id === 'string' && req.query.platform_id ? req.query.platform_id : null;

    const { data, error } = await supabase.rpc('calls_relationship_dynamics', { p_platform_id: platformId });
    if (error) return res.status(500).json({ success: false, error: `Database Error: ${error.message}` });

    return res.status(200).json({ success: true, data });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Relationship dynamics xatolik.' });
  }
});

// GET /api/management/conversion-history?platform_id=&days=14
// Kunlik trafik/sotuv konversiyasi tarixi + o'sha kungi qo'ng'iroqlar soni.
router.get('/conversion-history', async (req: Request, res: Response) => {
  try {
    const platformId = typeof req.query.platform_id === 'string' && req.query.platform_id ? req.query.platform_id : null;
    const days = Math.min(90, Math.max(1, parseInt(String(req.query.days || '14'), 10) || 14));
    const todayStart = startOfTodayUTC();
    const start = daysAgo(todayStart, days - 1);

    // Konversiyalar (calls bilan join — platforma filtri uchun) — sahifalab, 1000
    // qatorlik standart chegaradan oshsa ham hammasi yig'ib olinishi uchun.
    const convRows = await fetchAllRows<{ traffic_conversion: number | null; sales_conversion: number | null; created_at: string }>((from, to) => {
      let cq = supabase
        .from('conversions')
        .select('traffic_conversion, sales_conversion, created_at, calls!inner(platform_id)')
        .gte('created_at', start.toISOString())
        .range(from, to);
      if (platformId) cq = cq.eq('calls.platform_id', platformId);
      return cq;
    });

    // Kunlik qo'ng'iroqlar soni
    const callRows = await fetchAllRows<{ created_at: string }>((from, to) => {
      let kq = supabase.from('calls').select('created_at').gte('created_at', start.toISOString()).range(from, to);
      if (platformId) kq = kq.eq('platform_id', platformId);
      return kq;
    });

    // Kun bo'yicha guruhlash
    const agg: Record<string, { t: number; s: number; n: number }> = {};
    convRows.forEach((c) => {
      const k = dayKey(new Date(c.created_at));
      (agg[k] ||= { t: 0, s: 0, n: 0 });
      agg[k].t += Number(c.traffic_conversion) || 0;
      agg[k].s += Number(c.sales_conversion) || 0;
      agg[k].n += 1;
    });
    const callsPerDay: Record<string, number> = {};
    callRows.forEach((c) => {
      const k = dayKey(new Date(c.created_at));
      callsPerDay[k] = (callsPerDay[k] || 0) + 1;
    });

    // Har bir kun uchun qator (bo'sh kunlar 0 bilan)
    const out = Array.from({ length: days }, (_, i) => {
      const date = dayKey(daysAgo(todayStart, days - 1 - i));
      const a = agg[date];
      return {
        date,
        traffic_conversion: a && a.n ? Number((a.t / a.n).toFixed(2)) : 0,
        sales_conversion: a && a.n ? Number((a.s / a.n).toFixed(2)) : 0,
        calls: callsPerDay[date] || 0,
      };
    });

    return res.status(200).json({ success: true, data: out });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Conversion history xatolik.' });
  }
});

export default router;
