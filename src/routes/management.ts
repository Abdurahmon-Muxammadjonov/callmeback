import { Router, Request, Response } from 'express';
import { supabase } from '../lib/supabase';
import { requireAuth, type CompanyAuthedRequest } from '../middleware/companyAuth';
import { relationshipDynamics } from '../lib/analyticsAggregates';
import { reportRpc } from '../lib/reportRpc';
import {
  buildConversionHistory, buildDailyPanel,
  type BucketRow, type ConversionDayRow, type OperatorDailyItem,
} from '../lib/reportBuilders';
import { getCompanySettings } from '../lib/companySettings';
import { addDays, tashkentDay, tashkentDayStart } from '../lib/tashkentTime';

const router = Router();

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
// o'z menejerlari) DB funksiyasiga uzatiladi. supabase/
// tenant_scoped_aggregates.sql hali ishga tushirilmagan bo'lsa (eski imzo),
// xuddi shu tenant chegarasi bilan Node'da hisoblanadi (analyticsFallback.ts) —
// boshqa tenant ma'lumoti hech qachon ko'rsatilmaydi.
//
// TEZLIK (2026-10-12): Node'dagi hisob (14 kunlik barcha qatorni tortish)
// o'rniga calls_bucket_stats (supabase/perf_03) — company_id bo'yicha.
router.get('/relationship-dynamics', requireAuth, async (req: CompanyAuthedRequest, res: Response) => {
  try {
    const companyId = req.auth!.companyId as string;
    const platformId = typeof req.query.platform_id === 'string' && req.query.platform_id ? req.query.platform_id : null;
    // Chegara company_id bo'yicha (analytics/overview bilan bir xil sabab):
    // xodim bog'lanmagan qo'ng'iroqlar ham hisobga kirsin.
    const data = await relationshipDynamics(companyId, platformId);
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
    // Kun chegarasi TOSHKENT bo'yicha (2026-10-12; avval UTC edi).
    const today = tashkentDay(new Date());
    const start = tashkentDayStart(addDays(today, -(days - 1))).toISOString();

    // TEZLIK (2026-10-12): konversiyalar va qo'ng'iroqlar endi Node'ga
    // tortilmaydi — ikkita parallel RPC, kun bo'yicha yig'indi bazada
    // (supabase/perf_10_conversions_daily.sql, perf_03_calls_bucket_stats.sql).
    const [convRows, callRows] = await Promise.all([
      reportRpc<ConversionDayRow[]>('company_conversions_daily', {
        p_company_id: companyId, p_from: start, p_platform_id: platformId,
      }),
      reportRpc<BucketRow[]>('calls_bucket_stats', {
        p_company_id: companyId, p_from: start, p_platform_id: platformId,
      }),
    ]);

    // Har bir kun uchun qator (bo'sh kunlar 0 bilan)
    const out = buildConversionHistory(convRows || [], callRows || [], days, today);

    return res.status(200).json({ success: true, data: out });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Conversion history xatolik.' });
  }
});

// GET /api/management/daily-panel?days=14&platform_id=
// "Boshqaruv paneli" uchun kunlik yig'indilar, soatlar va bugungi xodim
// bo'yicha sonlar — bitta javobda (2026-10-12). Avval frontend 14 kunlik
// barcha qo'ng'iroqni /api/calls'dan ~90 ta ketma-ket so'rov bilan tortib
// o'zi sanardi: sekin va sahifalar surilib son "o'zidan o'zgarardi".
// Tafsilot: lib/reportBuilders.ts -> buildDailyPanel.
router.get('/daily-panel', requireAuth, async (req: CompanyAuthedRequest, res: Response) => {
  try {
    const companyId = req.auth!.companyId as string;
    const platformId = typeof req.query.platform_id === 'string' && req.query.platform_id && req.query.platform_id !== 'live'
      ? req.query.platform_id : null;
    const days = Math.min(31, Math.max(1, parseInt(String(req.query.days || '14'), 10) || 14));
    const today = tashkentDay(new Date());

    const settings = await getCompanySettings(supabase, companyId);
    const longSec = Math.max(1, Number(settings.qualified_call_seconds) || 60);

    const [hourRows, todayItems] = await Promise.all([
      reportRpc<BucketRow[]>('calls_bucket_stats', {
        p_company_id: companyId,
        p_from: tashkentDayStart(addDays(today, -(days - 1))).toISOString(),
        p_to: tashkentDayStart(addDays(today, 1)).toISOString(),
        p_by_hour: true,
        p_long_sec: longSec,
        p_platform_id: platformId,
      }),
      reportRpc<OperatorDailyItem[]>('calls_operator_daily', {
        p_company_id: companyId,
        p_from: tashkentDayStart(today).toISOString(),
      }),
    ]);

    return res.status(200).json({
      success: true,
      data: { window_days: days, long_call_seconds: longSec, ...buildDailyPanel(hourRows || [], todayItems || [], companyId, today, days) },
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Boshqaruv paneli ma\'lumotida xatolik.' });
  }
});

export default router;
