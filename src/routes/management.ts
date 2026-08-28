import { Router, Request, Response } from 'express';
import { supabase, fetchAllRows } from '../lib/supabase';
import { requireAuth, type CompanyAuthedRequest } from '../middleware/companyAuth';
import { getCompanyManagerIds } from '../lib/companyScope';

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

// GET /api/management/platforms — mavjud platformalar ro'yxati.
// DIQQAT: bu jadval kompaniyaga tegishli MA'LUMOT emas — reklama
// kanallarining umumiy (nom/rang/ikonka) ro'yxati, barcha tenant'lar
// uchun bir xil va maxfiy emas — shu sabab requireAuth talab qilinmaydi
// (boshqa xavfsizlik tuzatishlaridan farqli o'laroq).
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
// Hisob-kitob DB tomonida (supabase/optimize_analytics_aggregates.sql +
// supabase/tenant_scoped_aggregates.sql'dagi calls_relationship_dynamics).
//
// XAVFSIZLIK TUZATISHI (production'da aniqlangan CRITICAL xato): avval
// requireAuth'siz va tenant filtrisiz edi — HAR QANDAY kishi boshqa
// kompaniyalarning agregatlangan qo'ng'iroq dinamikasini ko'ra olardi.
// Endi requireAuth majburiy va p_manager_ids (chaqiruvchi kompaniyaning
// o'z menejerlari) DB funksiyasiga uzatiladi — supabase/
// tenant_scoped_aggregates.sql ishga tushirilgunga qadar bu funksiya
// eski (p_manager_ids'siz) imzoda bo'lsa, chaqiruv xato bilan qaytadi —
// bu ATAYLAB shunday: aniq xato, jim-jimgina boshqa tenant ma'lumotini
// ko'rsatishdan YAXSHIROQ.
router.get('/relationship-dynamics', requireAuth, async (req: CompanyAuthedRequest, res: Response) => {
  try {
    const companyId = req.auth!.companyId as string;
    const platformId = typeof req.query.platform_id === 'string' && req.query.platform_id ? req.query.platform_id : null;
    const managerIds = await getCompanyManagerIds(companyId);

    const { data, error } = await supabase.rpc('calls_relationship_dynamics', { p_platform_id: platformId, p_manager_ids: managerIds });
    if (error) return res.status(500).json({ success: false, error: `Database Error: ${error.message}` });

    return res.status(200).json({ success: true, data });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Relationship dynamics xatolik.' });
  }
});

// GET /api/management/conversion-history?platform_id=&days=14
// Kunlik trafik/sotuv konversiyasi tarixi + o'sha kungi qo'ng'iroqlar soni.
// XAVFSIZLIK TUZATISHI: requireAuth + calls.company_id bo'yicha filtr
// qo'shildi (calls!inner(...) join'i allaqachon platform_id uchun
// ishlatilgan edi — endi company_id ham shu joinga qo'shildi, yangi SQL
// shart emas).
router.get('/conversion-history', requireAuth, async (req: CompanyAuthedRequest, res: Response) => {
  try {
    const companyId = req.auth!.companyId as string;
    const platformId = typeof req.query.platform_id === 'string' && req.query.platform_id ? req.query.platform_id : null;
    const days = Math.min(90, Math.max(1, parseInt(String(req.query.days || '14'), 10) || 14));
    const todayStart = startOfTodayUTC();
    const start = daysAgo(todayStart, days - 1);

    // Konversiyalar (calls bilan join — platforma VA kompaniya filtri uchun) —
    // sahifalab, 1000 qatorlik standart chegaradan oshsa ham hammasi yig'ib
    // olinishi uchun.
    const convRows = await fetchAllRows<{ traffic_conversion: number | null; sales_conversion: number | null; created_at: string }>((from, to) => {
      let cq = supabase
        .from('conversions')
        .select('traffic_conversion, sales_conversion, created_at, calls!inner(platform_id, company_id)')
        .eq('calls.company_id', companyId)
        .gte('created_at', start.toISOString())
        .range(from, to);
      if (platformId) cq = cq.eq('calls.platform_id', platformId);
      return cq;
    });

    // Kunlik qo'ng'iroqlar soni
    const callRows = await fetchAllRows<{ created_at: string }>((from, to) => {
      let kq = supabase.from('calls').select('created_at').eq('company_id', companyId).gte('created_at', start.toISOString()).range(from, to);
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
