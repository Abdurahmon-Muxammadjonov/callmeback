import { Router, Request, Response } from 'express';
import { supabase } from '../lib/supabase';

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
router.get('/relationship-dynamics', async (req: Request, res: Response) => {
  try {
    const platformId = typeof req.query.platform_id === 'string' && req.query.platform_id ? req.query.platform_id : null;
    const todayStart = startOfTodayUTC();
    const windowStart = daysAgo(todayStart, 13); // 14 kun (spark + lastWeek uchun yetarli)

    let q = supabase
      .from('calls')
      .select('created_at, unanswered_count, bad_leads_count')
      .gte('created_at', windowStart.toISOString());
    if (platformId) q = q.eq('platform_id', platformId);
    const { data, error } = await q;
    if (error) return res.status(500).json({ success: false, error: `Database Error: ${error.message}` });

    const rows = data || [];
    const inRange = (r: any, from: Date, to: Date) => {
      const t = new Date(r.created_at).getTime();
      return t >= from.getTime() && t < to.getTime();
    };
    const sumField = (rs: any[], f: string) => rs.reduce((a, r) => a + (Number(r[f]) || 0), 0);

    const yStart = daysAgo(todayStart, 1);
    const weekStart = daysAgo(todayStart, 6); // so'nggi 7 kun (bugun ham)
    const lastWeekStart = daysAgo(todayStart, 13);
    const now = new Date();

    const buildSpark = (field: string): number[] =>
      Array.from({ length: 7 }, (_, i) => {
        const from = daysAgo(todayStart, 6 - i);
        const to = daysAgo(todayStart, 5 - i);
        return sumField(rows.filter((r) => inRange(r, from, to)), field);
      });

    const metric = (key: string, label: string, field: string) => ({
      key,
      label,
      today: sumField(rows.filter((r) => inRange(r, todayStart, now)), field),
      yesterday: sumField(rows.filter((r) => inRange(r, yStart, todayStart)), field),
      week: sumField(rows.filter((r) => inRange(r, weekStart, now)), field),
      lastWeek: sumField(rows.filter((r) => inRange(r, lastWeekStart, weekStart)), field),
      spark: buildSpark(field),
      lowerIsBetter: true,
    });

    return res.status(200).json({
      success: true,
      data: [
        metric('unanswered', 'Javobsiz qoldirilgan', 'unanswered_count'),
        metric('bad_leads', 'Sifatsiz lidlar', 'bad_leads_count'),
      ],
    });
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

    // Konversiyalar (calls bilan join — platforma filtri uchun)
    let cq = supabase
      .from('conversions')
      .select('traffic_conversion, sales_conversion, created_at, calls!inner(platform_id)')
      .gte('created_at', start.toISOString());
    if (platformId) cq = cq.eq('calls.platform_id', platformId);

    // Kunlik qo'ng'iroqlar soni
    let kq = supabase.from('calls').select('created_at').gte('created_at', start.toISOString());
    if (platformId) kq = kq.eq('platform_id', platformId);

    const [convRes, callsRes] = await Promise.all([cq, kq]);
    if (convRes.error) return res.status(500).json({ success: false, error: `Database Error: ${convRes.error.message}` });
    if (callsRes.error) return res.status(500).json({ success: false, error: `Database Error: ${callsRes.error.message}` });

    // Kun bo'yicha guruhlash
    const agg: Record<string, { t: number; s: number; n: number }> = {};
    (convRes.data || []).forEach((c: any) => {
      const k = dayKey(new Date(c.created_at));
      (agg[k] ||= { t: 0, s: 0, n: 0 });
      agg[k].t += Number(c.traffic_conversion) || 0;
      agg[k].s += Number(c.sales_conversion) || 0;
      agg[k].n += 1;
    });
    const callsPerDay: Record<string, number> = {};
    (callsRes.data || []).forEach((c: any) => {
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
