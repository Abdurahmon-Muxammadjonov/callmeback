import { Router, Response } from 'express';
import { supabase } from '../lib/supabase';
import { requireAuth, type CompanyAuthedRequest } from '../middleware/companyAuth';
import { getCompanyManagerIds } from '../lib/companyScope';
import { popStats, overviewStats } from '../lib/analyticsAggregates';
import { getCompanySettings } from '../lib/companySettings';
import { addDays, dayBounds, isHhMm, tashkentDay, tashkentDayStart } from '../lib/tashkentTime';
import { reportRpc } from '../lib/reportRpc';
import {
  buildAnalyticsRoot, buildDailySummary, buildHourly, buildDailyMinutes, buildStaffStats,
  buildAnalysisStatus, buildOperatorDay,
  type OperatorDayItem,
  type AnalyticsRootRaw, type BucketRow, type OperatorDailyItem, type StaffOpItem,
  type AnalysisStatusRaw, type OperatorInsight,
} from '../lib/reportBuilders';

const router = Router();
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// XAVFSIZLIK TUZATISHI (production'da aniqlangan CRITICAL xato): bu butun
// router avval requireAuth'siz va HECH QANDAY tenant filtrisiz edi (ba'zi
// endpoint'lar ixtiyoriy ?tenant_id= query parametriga tayanardi — ya'ni
// MIJOZNING O'ZI so'ragan parametrga ishonardi, aslida tekshirilmasdan!).
// Natijada har qanday kishi (login qilmasdan ham) BARCHA kompaniyalarning
// qo'ng'iroq statistikasini, konversiya tarixini va h.k.ni ko'ra olardi.
// Endi: requireAuth majburiy, va tenant chegarasi HAR DOIM serverda
// req.auth.companyId'dan hisoblanadi — mijozdan kelgan tenant_id/platform_id
// FAQAT qo'shimcha (ixtiyoriy) filtr sifatida qabul qilinadi, hech qachon
// yagona chegara sifatida emas.

// GET /analytics
// Frontend root endpoint so'rovlarida umumiy metrikani frontend kutgan formatda qaytaradi.
// TEZLIK (2026-10-12): calls/conversions/lost_reasons endi Node'ga
// tortilmaydi — bitta RPC (supabase/perf_07_company_totals.sql).
router.get('/', requireAuth, async (req: CompanyAuthedRequest, res: Response) => {
  try {
    const companyId = req.auth!.companyId as string;
    const raw = await reportRpc<AnalyticsRootRaw>('company_analytics_root', { p_company_id: companyId });
    return res.status(200).json({
      success: true,
      data: buildAnalyticsRoot(raw, new Date()),
      cached: false,
    });
  } catch (err: any) {
    return res.status(500).json({
      success: false,
      error: err?.message || 'Analytics root xatosi.',
    });
  }
});

// GET /analytics/overview?period=day|week|month
// Frontend kutgan ko'rinishda day/week/month PoP statistikani bitta javobda qaytaradi.
// Hisob-kitobning o'zi DB tomonida (supabase/optimize_analytics_aggregates.sql'dagi
// calls_overview_stats, calls_pop_stats bilan bir xil naqsh) — har bir mos qo'ng'iroq
// qatorini Node'ga tortib sum/avg qilish o'rniga bitta so'rovda hisoblanadi, shu sabab
// katta davrlarda (ko'p qo'ng'iroqli oy) ham sekinlashmaydi.
router.get('/overview', requireAuth, async (req: CompanyAuthedRequest, res: Response) => {
  try {
    const companyId = req.auth!.companyId as string;
    // DIQQAT: avval mijoz yuborgan ?tenant_id= query parametriga ishonilardi —
    // bu tekshirilmagan holda BOSHQA kompaniyaning statistikasini so'rash
    // imkonini berardi. Endi tenant chegarasi FAQAT autentifikatsiya
        // qilingan req.auth.companyId'dan hisoblanadi.
    // Eski calls_overview_stats manager_id massivi bo'yicha filtrlaydi —
    // xodim bog'lanmagan qo'ng'iroqlarni TASHLAB yuboradi. Shu sabab
    // chegara company_id bo'yicha (calls_range_stats, perf_02).
    const data = await overviewStats(companyId);
    return res.status(200).json({ success: true, data });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Overview hisoblashda xatolik.' });
  }
});

// GET /analytics/daily-plan?manager_id=&date=YYYY-MM-DD
// Kunlik reja (daily_target) vs bajarilgan (o'sha kundagi qo'ng'iroqlar soni).
router.get('/daily-plan', requireAuth, async (req: CompanyAuthedRequest, res: Response) => {
  try {
    const companyId = req.auth!.companyId as string;
    const managerId = String(req.query.manager_id || '');
    if (!UUID_REGEX.test(managerId)) {
      return res.status(400).json({ success: false, error: 'manager_id yaroqli UUID bo\'lishi kerak.' });
    }
    const { data: managerRow } = await supabase.from('managers').select('id').eq('id', managerId).eq('company_id', companyId).maybeSingle();
    if (!managerRow) return res.status(404).json({ success: false, error: 'Manager topilmadi.' });

    // Kun TOSHKENT bo'yicha (2026-10-12; avval UTC edi — 00:00–05:00
    // dagi qo'ng'iroqlar kechagi rejaga yozilardi).
    const dateStr = typeof req.query.date === 'string' && req.query.date ? req.query.date : tashkentDay(new Date());
    const dayStart = /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? tashkentDayStart(dateStr) : new Date(NaN);
    if (isNaN(dayStart.getTime())) {
      return res.status(400).json({ success: false, error: 'date YYYY-MM-DD formatda bo\'lishi kerak.' });
    }
    const dayEnd = tashkentDayStart(addDays(dateStr, 1));

    const [targetRes, achievedRes] = await Promise.all([
      supabase.from('daily_targets').select('daily_target, notes').eq('manager_id', managerId).eq('target_date', dateStr).maybeSingle(),
      supabase.from('calls').select('id', { count: 'exact', head: true })
        .eq('company_id', companyId).eq('manager_id', managerId)
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
router.post('/daily-plan', requireAuth, async (req: CompanyAuthedRequest, res: Response) => {
  try {
    const companyId = req.auth!.companyId as string;
    const { manager_id, target_date, daily_target, notes } = req.body ?? {};
    if (!manager_id || !UUID_REGEX.test(String(manager_id))) {
      return res.status(400).json({ success: false, error: 'manager_id yaroqli UUID bo\'lishi kerak.' });
    }
    const { data: managerRow } = await supabase.from('managers').select('id').eq('id', manager_id).eq('company_id', companyId).maybeSingle();
    if (!managerRow) return res.status(404).json({ success: false, error: 'Manager topilmadi.' });
    if (daily_target === undefined || Number(daily_target) < 0) {
      return res.status(400).json({ success: false, error: 'daily_target manfiy bo\'lmagan son bo\'lishi kerak.' });
    }
    const date = target_date || tashkentDay(new Date()); // Toshkent kuni
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

// GET /analytics/funnel
// Voronka: har bosqichdagi leadlar soni + drop-off (tushish) foizi + umumiy konversiya.
// DIQQAT: leads.tenant_id public.tenant_platforms(id)'ga ishora qiladi — bu
// bizning company multi-tenantligimizdan BUTUNLAY ALOHIDA, eski/orphan
// tushuncha, shu sabab tenant chegarasi sifatida ISHLATILMAYDI. Buning
// o'rniga leads.manager_id kompaniyaning o'z menejerlari ro'yxatiga
// (getCompanyManagerIds) tegishli bo'lishi bo'yicha filtrlanadi.
const FUNNEL_ORDER = ['lead_generated', 'contacted', 'qualified', 'proposal', 'negotiation', 'deal_closed'];
router.get('/funnel', requireAuth, async (req: CompanyAuthedRequest, res: Response) => {
  try {
    const companyId = req.auth!.companyId as string;
    const managerIds = await getCompanyManagerIds(companyId);

    let q = supabase.from('leads').select('stage, value');
    q = managerIds.length > 0 ? q.in('manager_id', managerIds) : q.eq('manager_id', '00000000-0000-0000-0000-000000000000');
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
router.get('/pop', requireAuth, async (req: CompanyAuthedRequest, res: Response) => {
  try {
    const companyId = req.auth!.companyId as string;
    // Overview bilan bir xil sabab: tenant chegarasi company_id (xodimsiz
    // qo'ng'iroqlar ham kirsin). Hisob bazada (calls_range_stats, perf_02).
    const data = await popStats(companyId);
    return res.status(200).json({ success: true, data });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'PoP hisoblashda xatolik.' });
  }
});

// GET /analytics/daily-minutes?days=30
// KUNLIK GAPLASHUV DAQIQALARI — "Solishtirish paneli" uchun (foydalanuvchi
// talabi 2026-09-23: "1 kunda necha minut umumiy gaplashganini hamma
// audionikini yozsin, 3 soniyami 40 soniyami farqi yo'q").
//
// Qo'ng'iroq tahlil qilinganmi, matni bormi, qisqami — farqi yo'q,
// hammasining davomiyligi qo'shiladi. LEKIN egasi aniqlanmagan
// (operatorsiz) qo'ng'iroqlar hisobga olinmaydi.
//
// Kun chegarasi TOSHKENT vaqti bo'yicha (ish kuni 09:00-23:00 shu
// mintaqada) — UTC bo'yicha bo'lsa, kechki qo'ng'iroqlar ertangi kunga
// tushib ketardi.
//
// TEZLIK (2026-10-12): kun x operator guruhlash bazada
// (supabase/perf_04_calls_operator_daily.sql) — qatorlar Node'ga tortilmaydi.
router.get('/daily-minutes', requireAuth, async (req: CompanyAuthedRequest, res: Response) => {
  try {
    const companyId = req.auth!.companyId as string;
    const days = Math.min(90, Math.max(1, parseInt(String(req.query.days || '30'), 10) || 30));
    // Oyna = bugun + oldingi (days-1) TO'LIQ Toshkent kuni (daily-summary bilan bir xil).
    const since = tashkentDayStart(addDays(tashkentDay(new Date()), -(days - 1))).toISOString();

    const [items, dayRows, managers] = await Promise.all([
      // Operator kesimi — FAQAT egasi aniq qo'ng'iroqlar (foydalanuvchi
      // talabi 2026-09-23): "noma'lum" audiolar operatorlar ro'yxatiga kirmaydi.
      reportRpc<OperatorDailyItem[]>('calls_operator_daily', { p_company_id: companyId, p_from: since }),
      // Kunlik jami (calls / operator_calls) — boshqa endpointlar bilan bir xil manba.
      reportRpc<BucketRow[]>('calls_bucket_stats', { p_company_id: companyId, p_from: since }),
      supabase.from('managers').select('id, name, pbx_id').eq('company_id', companyId),
    ]);

    const nameById = new Map<string, string>();
    for (const m of managers.data || []) nameById.set(m.id, m.name);

    const { data, summary } = buildDailyMinutes(items || [], nameById, dayRows || []);
    return res.status(200).json({ success: true, data, summary });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Kunlik daqiqalarni hisoblashda xatolik.' });
  }
});

// ============================================================================
// GET /analytics/staff-stats?date=YYYY-MM-DD
// XODIMLAR STATISTIKASI — har bir operatorning kunlik ko'rsatkichi, kuchsiz
// tomonlari (AYB) va ularni tuzatish uchun TAVSIYA.
//
// Maqsad (foydalanuvchi talabi 2026-09-24): "sotuvchining aybini topib,
// sotuvga yordam berish". Shuning uchun har operator uchun:
//   - kunlik ball (10 ballik), qo'ng'iroq soni, gaplashgan vaqti
//   - skript bandlari bo'yicha o'rtacha foiz (eng kuchsizi birinchi)
//   - qisqa "Ayblar" ro'yxati va "Tavsiya" ro'yxati (GPT yozadi, lekin
//     FAQAT haqiqiy raqamlar va o'sha kunning xato qatorlari asosida)
//
// Kun TOSHKENT vaqti bo'yicha. Raqamlar har so'rovda yangi (kesh yo'q);
// AI tavsiyasi fon jobidan (operator_insights) o'qiladi, GPT chaqirilmaydi.
// ============================================================================
// ============================================================================
// KESH YO'Q (2026-10-12).
//
// Avval daily-summary/hourly/analysis-status 60 s, staff-stats 30 daqiqa
// PROCESS XOTIRASIDA keshlanardi. Railway'da bir nechta replika (yoki
// restart) bo'lsa har biri o'z keshidan har xil vaqtdagi sonni berardi —
// sahifa yangilanganda kunlik son "sakrardi". Hisob endi bazada bitta
// RPC (tez), shuning uchun raqamlar HAR DOIM yangi o'qiladi.
// staff-stats'dagi AI tavsiyasi baribir operator_insights jadvalidan
// (fon jobi yozadi) — u GET'da hisoblanmaydi.
// ============================================================================

router.get('/staff-stats', requireAuth, async (req: CompanyAuthedRequest, res: Response) => {
  try {
    const companyId = req.auth!.companyId as string;
    const today = tashkentDay(new Date());
    const date = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
      ? req.query.date
      : today;

    // Kun chegarasi: Toshkent kuni -> UTC oraliq [kun boshi, keyingi kun boshi).
    const { from } = dayBounds(date);
    const to = dayBounds(addDays(date, 1)).from;

    // TEZLIK (2026-10-12): avval kunning operator qo'ng'iroqlari TRANSKRIPT
    // matni bilan (ishlatilmasa ham) tortilar, keyin call_criteria_scores va
    // lost_reasons 200 talik bo'laklarda KETMA-KET so'ralardi. Endi hammasi
    // bitta SQL join/aggregate (supabase/perf_05_calls_staff_day_stats.sql).
    //
    // AI tavsiyalari fon jobida tayyorlanadi va SHU YERDA faqat o'qiladi
    // (API v2 §6.5). Jadval hali yaratilmagan bo'lsa ham so'rov yiqilmaydi —
    // xato yutib yuboriladi va advice: null qaytadi.
    const [items, managers, insights] = await Promise.all([
      reportRpc<StaffOpItem[]>('calls_staff_day_stats', { p_company_id: companyId, p_from: from, p_to: to }),
      supabase.from('managers').select('id, name').eq('company_id', companyId),
      supabase.from('operator_insights')
        .select('operator_ext, items_uz, generated_at, based_on_calls')
        .eq('company_id', companyId)
        .then((r) => r, () => ({ data: null, error: null })),
    ]);

    const insightByExt = new Map<string, OperatorInsight>();
    for (const row of ((insights as any)?.data || []) as any[]) {
      const list = Array.isArray(row.items_uz)
        ? row.items_uz.filter((x: unknown): x is string => typeof x === 'string' && x.trim() !== '')
        : [];
      if (!list.length) continue;
      insightByExt.set(String(row.operator_ext), {
        items: list,
        generatedAt: row.generated_at,
        basedOnCalls: Number(row.based_on_calls) || 0,
      });
    }

    const nameById = new Map<string, string>();
    for (const m of managers.data || []) nameById.set(m.id, m.name);

    // Ayblar (deriveFaults) determinisik, tavsiya operator_insights'dan;
    // javobda advice_generated_at — UI "qachon tayyorlangan"ni ko'rsatadi.
    const result = buildStaffStats(items || [], nameById, insightByExt);

    return res.status(200).json({ success: true, date, data: result, cached: false });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Xodimlar statistikasida xatolik.' });
  }
});

// ============================================================================
// GET /analytics/operators?date=YYYY-MM-DD
// Bir kunning OPERATOR KESIMI (2026-10-14): Analitika "Jamoa samaradorligi",
// norma banneri, Solishtirish "kim o'sdi", Boshqaruv "Intizom". Avval
// frontend kunning barcha qo'ng'iroqlarini /api/calls'dan sahifalab tortib
// o'zi sanardi (sekin, son sakrardi). Hisob: supabase/perf_13.
// Javob shakli frontenddagi OperatorDay bilan bir xil.
// ============================================================================
router.get('/operators', requireAuth, async (req: CompanyAuthedRequest, res: Response) => {
  try {
    const companyId = req.auth!.companyId as string;
    const today = tashkentDay(new Date());
    const asked = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date) ? req.query.date : today;
    const date = asked > today ? today : asked;
    const settings = await getCompanySettings(supabase, companyId);
    const longSec = Math.max(1, Number(settings.qualified_call_seconds) || 60);
    const [items, managers] = await Promise.all([
      reportRpc<OperatorDayItem[]>('calls_operator_day_stats', {
        p_company_id: companyId,
        p_from: dayBounds(date).from,
        p_to: dayBounds(addDays(date, 1)).from,
        p_long_sec: longSec,
      }),
      supabase.from('managers').select('id, name').eq('company_id', companyId),
    ]);
    const nameById = new Map<string, string>();
    for (const m of managers.data || []) nameById.set(m.id, m.name);
    return res.status(200).json({
      success: true,
      date,
      long_call_seconds: longSec,
      data: buildOperatorDay(items || [], nameById),
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Operator kesimida xatolik.' });
  }
});

// ============================================================================
// GET /analytics/days
// "📅 Sana" kalendari uchun (2026-10-14): kompaniyaning BIRINCHI qo'ng'iroq
// kunidan bugungacha qo'ng'iroq bo'lgan har bir Toshkent kuni va soni.
// Kalendar shu kundan oldingi va kelajakdagi kunlarni o'chiradi, qo'ng'iroq
// bo'lgan kunlarni belgilaydi. Hisob calls_bucket_stats (perf_03) orqali —
// kunlik son boshqa hisobotlar bilan bir xil ta'rifda.
// DIQQAT: PostgREST javobi 1000 qatorgacha — ~2.7 yillik tarix (yangi kunlar
// birinchi keladi, eng eskilari kesiladi).
// ============================================================================
router.get('/days', requireAuth, async (req: CompanyAuthedRequest, res: Response) => {
  try {
    const companyId = req.auth!.companyId as string;
    const rows = await reportRpc<BucketRow[]>('calls_bucket_stats', {
      p_company_id: companyId,
      p_from: '2000-01-01T00:00:00Z',
    });
    const today = tashkentDay(new Date());
    const days = (rows || [])
      .filter((r) => r.day <= today)
      .map((r) => ({ date: r.day, calls: Number(r.calls) || 0 }))
      .sort((x, y) => x.date.localeCompare(y.date));
    return res.status(200).json({
      success: true,
      data: { first_day: days[0]?.date ?? null, today, days },
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Kunlar ro\'yxatida xatolik.' });
  }
});

// ============================================================================
// GET /analytics/daily-summary?days=30
// KUNLIK YAKUNIY KO'RSATKICHLAR — dashboardning asosiy raqamlari shu yerdan.
//
// NEGA (2026-09-24): frontend analitikani /api/calls ro'yxatidan hisoblardi,
// u esa ko'pi bilan 200 qator qaytaradi. Kuniga 1300 qo'ng'iroq kelganda
// oyna ichida faqat OXIRGI 200 tasi qolar va yangi qo'ng'iroq kelgani sari
// eski qatorlar tushib ketib, ko'rsatkichlar KAMAYIB borardi ("ertalab 5
// edi, hozir 2"). Endi hisob serverda, BARCHA qatorlar bo'yicha.
//
// Kiruvchi/chiquvchi AI taxminidan emas, PBX bergan haqiqiy "direction"
// maydonidan olinadi (AI transkriptdan taxmin qilar va chiquvchilarni
// kiruvchi deb ko'rsatardi).
//
// Lidlar mijoz raqami bo'yicha TAKRORLANMAYDI: bitta mijoz kuni bo'yi
// besh marta gaplashsa ham — bitta lid.
// ============================================================================
router.get('/daily-summary', requireAuth, async (req: CompanyAuthedRequest, res: Response) => {
  try {
    const companyId = req.auth!.companyId as string;
    const days = Math.min(120, Math.max(1, parseInt(String(req.query.days || '30'), 10) || 30));
    // OYNA TOSHKENT KUNI BOSHIDAN (2026-10-12): bugun + oldingi (days-1)
    // to'liq kun. Avval since = hozir - days*24h edi (suriluvchi oyna):
    // eng eski kun yarim kesilib, vaqt o'tgani sari soni KAMAYIB borardi.
    const since = tashkentDayStart(addDays(tashkentDay(new Date()), -(days - 1))).toISOString();

    // "until=HH:MM" — kunning FAQAT shu vaqtgacha bo'lgan qismi. Delta shu
    // bilan hisoblanadi: bugun 10:17 da bo'lsa, kecha ham 10:17 gacha
    // olinadi. Aks holda kun boshida har doim "-100%" chiqardi.
    const until = isHhMm(req.query.until) ? (req.query.until as string) : null;

    // Uzun qo'ng'iroq chegarasi — "KPI normalari"dan (standart 60 s).
    const settings = await getCompanySettings(supabase, companyId);
    const longSec = Math.max(1, Number(settings.qualified_call_seconds) || 60);

    // TEZLIK (2026-10-12): kun bo'yicha yig'indilar bazada
    // (supabase/perf_03_calls_bucket_stats.sql). Avval 30 kunlik 40 000 qator
    // 1000 tadan ketma-ket tortilardi.
    const rows = await reportRpc<BucketRow[]>('calls_bucket_stats', {
      p_company_id: companyId,
      p_from: since,
      p_until: until,
      p_long_sec: longSec,
    });
    const data = buildDailySummary(rows || []);

    return res.status(200).json({ success: true, data, long_call_seconds: longSec, until });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Kunlik yakun hisoblashda xatolik.' });
  }
});

// ============================================================================
// GET /analytics/hourly?date=YYYY-MM-DD[&operator_ext=]
// SOATLIK KESIM — 0 dan 23 gacha HAR BIR soat uchun qator (qo'ng'iroq
// bo'lmagan soat ham nol bilan qaytadi).
//
// Uchta blok shu ma'lumotdan ishlaydi: Boshqaruv panelidagi "Vaqt
// intervallari", Solishtirish panelidagi "Soatlar bo'yicha" grafigi va
// kun ichidagi taqsimotni ko'rish. Kun va soat Asia/Tashkent bo'yicha.
// ============================================================================
router.get('/hourly', requireAuth, async (req: CompanyAuthedRequest, res: Response) => {
  try {
    const companyId = req.auth!.companyId as string;
    const date = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
      ? req.query.date
      : tashkentDay(new Date());
    const operatorExt = typeof req.query.operator_ext === 'string' && req.query.operator_ext.trim()
      ? req.query.operator_ext.trim()
      : null;

    const settings = await getCompanySettings(supabase, companyId);
    const longSec = Math.max(1, Number(settings.qualified_call_seconds) || 60);
    const { from } = dayBounds(date);

    // TEZLIK (2026-10-12): soat bo'yicha yig'indilar bazada (perf_03).
    // Kun oxiri endi [kun boshi, keyingi kun boshi) — avval 23:59:59.999 edi.
    const rows = await reportRpc<BucketRow[]>('calls_bucket_stats', {
      p_company_id: companyId,
      p_from: from,
      p_to: dayBounds(addDays(date, 1)).from,
      p_by_hour: true,
      p_long_sec: longSec,
      p_operator_ext: operatorExt,
    });
    const hours = buildHourly(rows || []);

    return res.status(200).json({ success: true, date, long_call_seconds: longSec, data: hours });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Soatlik kesimni hisoblashda xatolik.' });
  }
});

// ============================================================================
// GET /analytics/analysis-status?date=YYYY-MM-DD
// TAHLIL HOLATI — nechta qo'ng'iroq tahlil qilindi, nechtasi qilinmadi va
// NEGA. Foydalanuvchi talabi 2026-09-25.
//
// Tahlil qilingan = ball qo'yilgan (haqiqiy sotuv suhbati baholangan).
// Qilinmagan = qolgani; sababi dropped_reason'da ("Javobsiz", "Kunlik
// limitdan oshdi", "Aloqa sifati yomon", "Sotuv suhbati emas" ...).
// ============================================================================
router.get('/analysis-status', requireAuth, async (req: CompanyAuthedRequest, res: Response) => {
  try {
    const companyId = req.auth!.companyId as string;
    const date = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
      ? req.query.date
      : tashkentDay(new Date());
    const { from } = dayBounds(date);
    const to = dayBounds(addDays(date, 1)).from;

    // TEZLIK (2026-10-12): sanash bazada (supabase/perf_06_calls_analysis_status.sql);
    // transkript matni endi umuman o'qilmaydi.
    const raw = await reportRpc<AnalysisStatusRaw>('calls_analysis_status', {
      p_company_id: companyId, p_from: from, p_to: to,
    });

    return res.status(200).json({
      success: true,
      date,
      data: buildAnalysisStatus(raw),
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Tahlil holatini hisoblashda xatolik.' });
  }
});

export default router;
