import { Router, Response } from 'express';
import { supabase, fetchAllRows } from '../lib/supabase';
import { requireAuth, type CompanyAuthedRequest } from '../middleware/companyAuth';
import { getCompanyManagerIds } from '../lib/companyScope';
import { popStatsInNode, overviewStatsInNode } from '../lib/analyticsFallback';
import { buildCoaching } from '../lib/coaching';
import { getCompanySettings } from '../lib/companySettings';
import { dayBounds, isHhMm, tashkentDay, tashkentHm, tashkentHour } from '../lib/tashkentTime';

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
router.get('/', requireAuth, async (req: CompanyAuthedRequest, res: Response) => {
  try {
    const companyId = req.auth!.companyId as string;
    const [callRows, convRows, lostReasonRows] = await Promise.all([
      fetchAllRows<{ id: string; duration: number | null }>((from, to) =>
        supabase.from('calls').select('id, duration').eq('company_id', companyId).range(from, to)),
      // conversions/lost_reasons'da company_id yo'q (call_id orqali calls'ga
      // bog'langan) — calls!inner(...) bilan join qilib, join qilingan
      // qatorning company_id'sini filtrlaymiz (management.ts'dagi
      // /conversion-history'da ham xuddi shu naqsh ishlatilgan).
      fetchAllRows<{ traffic_conversion: number | null; sales_conversion: number | null }>((from, to) =>
        supabase.from('conversions').select('traffic_conversion, sales_conversion, calls!inner(company_id)').eq('calls.company_id', companyId).range(from, to)),
      fetchAllRows<{ reason_text: string }>((from, to) =>
        supabase.from('lost_reasons').select('reason_text, calls!inner(company_id)').eq('calls.company_id', companyId).range(from, to)),
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
    // DB funksiyasi (calls_overview_stats) manager_id massivi bo'yicha
    // filtrlaydi — xodim bog'lanmagan qo'ng'iroqlarni TASHLAB yuboradi.
    // Endi qo'ng'iroq xodim yaratmasdan yoziladi (operator raqami
    // calls.pbx_id'da), shu sabab chegara company_id bo'yicha Node'da
    // hisoblanadi: yangi audiolar darhol ko'rinadi.
    const data = await overviewStatsInNode(companyId);
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
    // qo'ng'iroqlar ham kirsin). Oyna ~2 oy va 3 ustun — Node'da arzon.
    const data = await popStatsInNode(companyId);
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
const TASHKENT_TZ = 'Asia/Tashkent';
const dayKeyTashkent = (iso: string): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TASHKENT_TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(iso));

router.get('/daily-minutes', requireAuth, async (req: CompanyAuthedRequest, res: Response) => {
  try {
    const companyId = req.auth!.companyId as string;
    const days = Math.min(90, Math.max(1, parseInt(String(req.query.days || '30'), 10) || 30));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const [calls, managers] = await Promise.all([
      fetchAllRows<{ created_at: string; duration: number | null; manager_id: string | null; operator_ext: string | null }>((from, to) =>
        supabase
          .from('calls')
          .select('created_at, duration, manager_id, operator_ext')
          .eq('company_id', companyId)
          .gte('created_at', since)
          // FAQAT OPERATOR QO'NG'IROQLARI (foydalanuvchi talabi 2026-09-23):
          // egasi aniqlanmagan ("noma'lum") audiolar hisobga OLINMAYDI —
          // hisobotda faqat kim gaplashgani aniq bo'lgan qo'ng'iroqlar turadi.
          .or('operator_ext.not.is.null,manager_id.not.is.null')
          .range(from, to)),
      supabase.from('managers').select('id, name, pbx_id').eq('company_id', companyId),
    ]);

    const nameById = new Map<string, string>();
    for (const m of managers.data || []) nameById.set(m.id, m.name);

    // kun -> { calls, seconds, operatorlar }
    const byDay = new Map<string, { calls: number; seconds: number; ops: Map<string, { name: string; calls: number; seconds: number }> }>();
    for (const c of calls) {
      const day = dayKeyTashkent(c.created_at);
      const entry = byDay.get(day) || { calls: 0, seconds: 0, ops: new Map() };
      const sec = Math.max(0, Number(c.duration) || 0);
      entry.calls += 1;
      entry.seconds += sec;

      const opKey = c.manager_id || (c.operator_ext ? `ext:${c.operator_ext}` : 'ext:—');
      const opName = c.manager_id
        ? nameById.get(c.manager_id) || 'Xodim'
        : c.operator_ext
          ? `Operator ${c.operator_ext}`
          : 'Noma\'lum';
      const op = entry.ops.get(opKey) || { name: opName, calls: 0, seconds: 0 };
      op.calls += 1;
      op.seconds += sec;
      entry.ops.set(opKey, op);

      byDay.set(day, entry);
    }

    const data = [...byDay.entries()]
      .sort((a, b) => b[0].localeCompare(a[0])) // yangi kun yuqorida
      .map(([date, v]) => ({
        date,
        calls: v.calls,
        seconds: v.seconds,
        minutes: Math.round((v.seconds / 60) * 10) / 10,
        operators: [...v.ops.values()]
          .sort((a, b) => b.seconds - a.seconds)
          .map((o) => ({ name: o.name, calls: o.calls, minutes: Math.round((o.seconds / 60) * 10) / 10 })),
      }));

    const totalSeconds = data.reduce((s, d) => s + d.seconds, 0);
    return res.status(200).json({
      success: true,
      data,
      summary: {
        days: data.length,
        calls: data.reduce((s, d) => s + d.calls, 0),
        minutes: Math.round((totalSeconds / 60) * 10) / 10,
      },
    });
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
// Kun TOSHKENT vaqti bo'yicha; kun tugagach (23:00) raqamlar o'zgarmaydi.
// Natija 30 daqiqaga keshlanadi — har sahifa ochilganda GPT chaqirilmasin.
// ============================================================================
// ============================================================================
// HISOBOT KESHI (2026-09-25)
//
// daily-summary va hourly agregatsiyani Node'da bajaradi, ya'ni kunlik
// qatorlarni bazadan tortadi. Kuniga 1300+ qo'ng'iroq kelayotgani uchun
// 30 kunlik so'rov 3000+ qator bo'lib qoldi (o'lchandi: ~3.2 s), va
// dashboard bir sahifada bir necha marta chaqiradi.
//
// Shu sabab natija QISQA muddat keshlanadi. Ma'lumot sekin o'zgaradi
// (qo'ng'iroq tahlili 20-30 soniya davom etadi), sahifalar esa har
// 20-60 soniyada o'zi yangilanadi — shuning uchun 60 soniyalik kesh
// ko'rinishni eskirtirmaydi.
//
// Kesh kaliti KOMPANIYA bilan boshlanadi — boshqa tenant ma'lumoti
// hech qachon boshqasiga ko'rinmaydi.
// ============================================================================
const reportCache = new Map<string, { at: number; body: unknown }>();
const REPORT_TTL_MS = 60_000;

function cachedReport(key: string): unknown | null {
  const hit = reportCache.get(key);
  if (hit && Date.now() - hit.at < REPORT_TTL_MS) return hit.body;
  if (hit) reportCache.delete(key);
  return null;
}

function putReport(key: string, body: unknown): unknown {
  reportCache.set(key, { at: Date.now(), body });
  // Kesh cheksiz o'smasin (ko'p kompaniya + ko'p sana).
  if (reportCache.size > 200) {
    const oldest = [...reportCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) reportCache.delete(oldest[0]);
  }
  return body;
}

const staffStatsCache = new Map<string, { at: number; data: unknown }>();
const STAFF_STATS_TTL_MS = 30 * 60 * 1000;

router.get('/staff-stats', requireAuth, async (req: CompanyAuthedRequest, res: Response) => {
  try {
    const companyId = req.auth!.companyId as string;
    const today = dayKeyTashkent(new Date().toISOString());
    const date = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
      ? req.query.date
      : today;

    const cacheKey = `${companyId}::${date}`;
    const hit = staffStatsCache.get(cacheKey);
    if (hit && Date.now() - hit.at < STAFF_STATS_TTL_MS) {
      return res.status(200).json({ success: true, date, data: hit.data, cached: true });
    }

    // Kun chegarasi: Toshkent kuni -> UTC oraliq (UTC+5).
    const from = new Date(`${date}T00:00:00+05:00`).toISOString();
    const to = new Date(`${date}T23:59:59.999+05:00`).toISOString();

    const [calls, managers] = await Promise.all([
      fetchAllRows<any>((f, t) =>
        supabase.from('calls')
          .select('id, duration, kpi_score, rop_comment, dropped_reason, transcript, manager_id, operator_ext, new_leads_count, sent_to_dealer_count, closed_deals_count, is_problem')
          .eq('company_id', companyId).gte('created_at', from).lte('created_at', to)
          .or('operator_ext.not.is.null,manager_id.not.is.null')
          .range(f, t)),
      supabase.from('managers').select('id, name').eq('company_id', companyId),
    ]);

    const nameById = new Map<string, string>();
    for (const m of managers.data || []) nameById.set(m.id, m.name);

    // Skript bandlari bo'yicha ballar (call_criteria_scores) — bo'laklab olamiz.
    const ids = calls.map((c) => c.id);
    const stageRows: Array<{ call_id: string; title: string; score: number }> = [];
    for (let i = 0; i < ids.length; i += 200) {
      const { data } = await supabase.from('call_criteria_scores')
        .select('call_id, title, score').in('call_id', ids.slice(i, i + 200));
      stageRows.push(...((data || []) as any[]));
    }
    // Bitim yo'qolgan sabablar — "kim qaysi xato tufayli mijozni yo'qotyapti".
    const lostRows: Array<{ call_id: string; reason_text: string }> = [];
    for (let i = 0; i < ids.length; i += 200) {
      const { data } = await supabase.from('lost_reasons')
        .select('call_id, reason_text').in('call_id', ids.slice(i, i + 200));
      lostRows.push(...((data || []) as any[]));
    }
    const lostByCall = new Map<string, string[]>();
    for (const l of lostRows) {
      lostByCall.set(l.call_id, [...(lostByCall.get(l.call_id) || []), l.reason_text]);
    }

    const stagesByCall = new Map<string, Array<{ title: string; score: number }>>();
    for (const s of stageRows) {
      stagesByCall.set(s.call_id, [...(stagesByCall.get(s.call_id) || []), { title: s.title, score: Number(s.score) || 0 }]);
    }

    // Operator bo'yicha yig'amiz.
    interface Agg {
      key: string; name: string; calls: number; seconds: number;
      scores: number[]; stages: Map<string, number[]>; mistakes: string[];
      reasons: Map<string, number>;
      // Konversiya va yo'qotish tahlili uchun (talab 2026-09-27).
      leads: number; invited: number; closed: number; problems: number;
      /** Xato matni -> {necha marta, jami necha ball yo'qotilgan} */
      mistakeAgg: Map<string, { count: number; minus: number }>;
      /** Bitim yo'qolgan sabablar (lost_reasons jadvalidan). */
      lostAgg: Map<string, number>;
      callIds: string[];
    }
    const byOp = new Map<string, Agg>();
    for (const c of calls) {
      const key = c.manager_id || `ext:${c.operator_ext}`;
      const name = c.manager_id ? nameById.get(c.manager_id) || 'Xodim' : `Operator ${c.operator_ext}`;
      const a: Agg = byOp.get(key) || {
        key, name, calls: 0, seconds: 0,
        scores: [] as number[],
        stages: new Map<string, number[]>(),
        mistakes: [] as string[],
        reasons: new Map<string, number>(),
        leads: 0, invited: 0, closed: 0, problems: 0,
        mistakeAgg: new Map<string, { count: number; minus: number }>(),
        lostAgg: new Map<string, number>(),
        callIds: [] as string[],
      };
      a.calls += 1;
      a.seconds += Math.max(0, Number(c.duration) || 0);
      if (Number(c.kpi_score) > 0) a.scores.push(Number(c.kpi_score));
      for (const st of stagesByCall.get(c.id) || []) {
        a.stages.set(st.title, [...(a.stages.get(st.title) || []), st.score]);
      }
      a.leads += Number(c.new_leads_count) || 0;
      a.invited += Number(c.sent_to_dealer_count) || 0;
      a.closed += Number(c.closed_deals_count) || 0;
      if (c.is_problem) a.problems += 1;
      a.callIds.push(c.id);

      // Izohdagi "− X · Band: nima qilmadi" qatorlari — aniq dalil sifatida.
      // Bir vaqtda XATOLARNI YIG'AMIZ: qaysi xato necha marta uchragan va
      // jami necha ball yo'qotilgan (talab 2026-09-27: "kim qaysi xatolar
      // tufayli mijozlarni yo'qotyapti").
      for (const line of String(c.rop_comment || '').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('−')) continue;
        if (a.mistakes.length < 40) a.mistakes.push(trimmed);
        const m = trimmed.match(/^−\s*([\d.]+)\s*·\s*([^:]+):/);
        if (m) {
          const label = m[2].trim();
          const cur = a.mistakeAgg.get(label) || { count: 0, minus: 0 };
          cur.count += 1;
          cur.minus += Number(m[1]) || 0;
          a.mistakeAgg.set(label, cur);
        }
      }
      if (c.dropped_reason) a.reasons.set(c.dropped_reason, (a.reasons.get(c.dropped_reason) || 0) + 1);
      for (const reason of lostByCall.get(c.id) || []) {
        a.lostAgg.set(reason, (a.lostAgg.get(reason) || 0) + 1);
      }

      byOp.set(key, a);
    }

    const avg = (arr: number[]) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0);

    const result = await Promise.all([...byOp.values()]
      .sort((x, y) => y.calls - x.calls)
      .map(async (a) => {
        const stages = [...a.stages.entries()]
          .map(([title, arr]) => ({ title, pct: Math.round(avg(arr)) }))
          .sort((x, y) => x.pct - y.pct); // eng kuchsizi birinchi
        const avgScore = Math.round(avg(a.scores));
        const topMistakes = [...a.mistakeAgg.entries()]
          .map(([label, v]) => ({ label, count: v.count, points_lost: Math.round(v.minus * 10) / 10 }))
          .sort((x, y) => y.points_lost - x.points_lost)
          .slice(0, 6);
        const lostReasons = [...a.lostAgg.entries()]
          .map(([reason, count]) => ({ reason, count }))
          .sort((x, y) => y.count - x.count)
          .slice(0, 6);
        const conversion = a.leads > 0 ? Math.round((a.closed / a.leads) * 1000) / 10 : 0;

        const { faults, advice } = await buildCoaching(a.name, {
          calls: a.calls,
          minutes: Math.round((a.seconds / 60) * 10) / 10,
          avgScore,
          scoredCalls: a.scores.length,
          stages,
          mistakes: a.mistakes.slice(0, 12),
          reasons: [...a.reasons.entries()].map(([r, n]) => `${r} (${n} ta)`),
          topMistakes,
          lostReasons,
          leads: a.leads,
          invited: a.invited,
          closed: a.closed,
          conversion,
        });
        return {
          key: a.key,
          name: a.name,
          calls: a.calls,
          minutes: Math.round((a.seconds / 60) * 10) / 10,
          scored_calls: a.scores.length,
          avg_score: avgScore,          // 0-100 (frontend 10 ballikka bo'ladi)
          stages,
          faults,
          advice,
          // Konversiya va yo'qotish tahlili (talab 2026-09-27)
          leads: a.leads,
          invited: a.invited,
          closed: a.closed,
          conversion,                   // lid -> bitim, foizda
          problems: a.problems,         // AI muammoli deb belgilagan qo'ng'iroqlar
          top_mistakes: topMistakes,    // qaysi xato necha marta, necha ball yeb ketgan
          lost_reasons: lostReasons,    // bitim nega yo'qolgan
          reasons: [...a.reasons.entries()].sort((x, y) => y[1] - x[1]).map(([reason, count]) => ({ reason, count })),
        };
      }));

    staffStatsCache.set(cacheKey, { at: Date.now(), data: result });
    return res.status(200).json({ success: true, date, data: result, cached: false });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Xodimlar statistikasida xatolik.' });
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
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    // "until=HH:MM" — kunning FAQAT shu vaqtgacha bo'lgan qismi. Delta shu
    // bilan hisoblanadi: bugun 10:17 da bo'lsa, kecha ham 10:17 gacha
    // olinadi. Aks holda kun boshida har doim "-100%" chiqardi.
    const until = isHhMm(req.query.until) ? (req.query.until as string) : null;

    const cacheKey = `daily:${companyId}:${days}:${until ?? ''}`;
    const cached = cachedReport(cacheKey);
    if (cached) return res.status(200).json(cached);

    // Uzun qo'ng'iroq chegarasi — "KPI normalari"dan (standart 60 s).
    const settings = await getCompanySettings(supabase, companyId);
    const longSec = Math.max(1, Number(settings.qualified_call_seconds) || 60);

    const rows = await fetchAllRows<any>((from, to) =>
      supabase.from('calls')
        .select('created_at, duration, direction, kpi_score, transcript, client_phone, operator_ext, manager_id, new_leads_count, sent_to_dealer_count, closed_deals_count, bad_leads_count, unanswered_count, penalty_amount, bonus_amount')
        .eq('company_id', companyId).gte('created_at', since).range(from, to));

    interface DayAgg {
      calls: number; seconds: number; analyzed: number; scored: number; scoreSum: number;
      incoming: number; outgoing: number; invited: number; closed: number;
      badLeads: number; unanswered: number; leadPhones: Set<string>; leads: number;
      lowScore: number; longCalls: number; operatorCalls: number;
      penalty: number; bonus: number;
    }
    const blank = (): DayAgg => ({
      calls: 0, seconds: 0, analyzed: 0, scored: 0, scoreSum: 0,
      incoming: 0, outgoing: 0, invited: 0, closed: 0,
      badLeads: 0, unanswered: 0, leadPhones: new Set(), leads: 0,
      lowScore: 0, longCalls: 0, operatorCalls: 0, penalty: 0, bonus: 0,
    });

    const byDay = new Map<string, DayAgg>();
    for (const r of rows) {
      if (until && tashkentHm(r.created_at) > until) continue;
      const d = tashkentDay(r.created_at);
      const a = byDay.get(d) || blank();
      const sec = Math.max(0, Number(r.duration) || 0);
      a.calls += 1;
      a.seconds += sec;
      if (sec >= longSec) a.longCalls += 1;
      if (r.operator_ext || r.manager_id) a.operatorCalls += 1;
      a.penalty += Math.max(0, Number(r.penalty_amount) || 0);
      a.bonus += Math.max(0, Number(r.bonus_amount) || 0);
      if (r.transcript) a.analyzed += 1;
      if (Number(r.kpi_score) > 0) {
        a.scored += 1;
        a.scoreSum += Number(r.kpi_score);
        if (Number(r.kpi_score) < 50) a.lowScore += 1; // 10 ballikda 5 dan past
      }
      if (r.direction === 'incoming') a.incoming += 1;
      else if (r.direction === 'outgoing') a.outgoing += 1;
      a.invited += Number(r.sent_to_dealer_count) || 0;
      a.closed += Number(r.closed_deals_count) || 0;
      a.badLeads += Number(r.bad_leads_count) || 0;
      a.unanswered += Number(r.unanswered_count) || 0;
      if (Number(r.new_leads_count) > 0) {
        const phone = String(r.client_phone || '').trim();
        if (phone) a.leadPhones.add(phone); else a.leads += 1;
      }
      byDay.set(d, a);
    }

    const data = [...byDay.entries()].sort((x, y) => y[0].localeCompare(x[0])).map(([date, a]) => ({
      date,
      calls: a.calls,
      operator_calls: a.operatorCalls,
      minutes: Math.round((a.seconds / 60) * 10) / 10,
      analyzed: a.analyzed,
      scored: a.scored,
      avg_score: a.scored ? Math.round(a.scoreSum / a.scored) : 0, // 0-100
      low_score: a.lowScore,
      long_calls: a.longCalls,
      incoming: a.incoming,
      outgoing: a.outgoing,
      leads: a.leadPhones.size + a.leads,
      invited: a.invited,
      closed: a.closed,
      bad_leads: a.badLeads,
      unanswered: a.unanswered,
      penalty_sum: Math.round(a.penalty),
      bonus_sum: Math.round(a.bonus),
    }));

    return res.status(200).json(putReport(cacheKey, { success: true, data, long_call_seconds: longSec, until }));
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

    const cacheKey = `hourly:${companyId}:${date}:${operatorExt ?? ''}`;
    const cached = cachedReport(cacheKey);
    if (cached) return res.status(200).json(cached);

    const settings = await getCompanySettings(supabase, companyId);
    const longSec = Math.max(1, Number(settings.qualified_call_seconds) || 60);
    const { from, to } = dayBounds(date);

    const rows = await fetchAllRows<any>((f, t) => {
      let q = supabase.from('calls')
        .select('created_at, duration, kpi_score, transcript, operator_ext, manager_id')
        .eq('company_id', companyId).gte('created_at', from).lte('created_at', to);
      if (operatorExt) q = q.eq('operator_ext', operatorExt);
      return q.range(f, t);
    });

    const hours = Array.from({ length: 24 }, (_, hour) => ({
      hour, calls: 0, operator_calls: 0, long_calls: 0, analyzed: 0, talk_seconds: 0,
    }));

    for (const r of rows) {
      const h = hours[tashkentHour(r.created_at)];
      if (!h) continue;
      const sec = Math.max(0, Number(r.duration) || 0);
      h.calls += 1;
      h.talk_seconds += sec;
      if (sec >= longSec) h.long_calls += 1;
      if (r.operator_ext || r.manager_id) h.operator_calls += 1;
      if (r.transcript || Number(r.kpi_score) > 0) h.analyzed += 1;
    }

    return res.status(200).json(putReport(cacheKey, { success: true, date, long_call_seconds: longSec, data: hours }));
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Soatlik kesimni hisoblashda xatolik.' });
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
// Kun TOSHKENT vaqti bo'yicha; kun tugagach (23:00) raqamlar o'zgarmaydi.
// Natija 30 daqiqaga keshlanadi — har sahifa ochilganda GPT chaqirilmasin.
// ============================================================================
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
      : dayKeyTashkent(new Date().toISOString());
    const from = new Date(`${date}T00:00:00+05:00`).toISOString();
    const to = new Date(`${date}T23:59:59.999+05:00`).toISOString();

    const cacheKey = `status:${companyId}:${date}`;
    const cached = cachedReport(cacheKey);
    if (cached) return res.status(200).json(cached);

    const rows = await fetchAllRows<any>((f, t) =>
      supabase.from('calls')
        .select('id, created_at, duration, kpi_score, dropped_reason, operator_ext, transcript')
        .eq('company_id', companyId).gte('created_at', from).lte('created_at', to).range(f, t));

    const analyzed = rows.filter((r) => Number(r.kpi_score) > 0);
    const notAnalyzed = rows.filter((r) => !(Number(r.kpi_score) > 0));

    const reasons = new Map<string, { count: number; seconds: number }>();
    for (const r of notAnalyzed) {
      const key = String(r.dropped_reason || 'Sabab yozilmagan');
      const cur = reasons.get(key) || { count: 0, seconds: 0 };
      cur.count += 1;
      cur.seconds += Math.max(0, Number(r.duration) || 0);
      reasons.set(key, cur);
    }

    // Operatorlar kesimi — kim limitga yetgani ko'rinsin.
    const byOp = new Map<string, { analyzed: number; skipped: number; analyzedSec: number; limitHit: boolean }>();
    for (const r of rows) {
      const ext = String(r.operator_ext || '—');
      const a = byOp.get(ext) || { analyzed: 0, skipped: 0, analyzedSec: 0, limitHit: false };
      if (Number(r.kpi_score) > 0) { a.analyzed += 1; a.analyzedSec += Math.max(0, Number(r.duration) || 0); }
      else a.skipped += 1;
      if (r.dropped_reason === 'Kunlik limitdan oshdi') a.limitHit = true;
      byOp.set(ext, a);
    }

    const sec = (list: any[]) => list.reduce((s, r) => s + Math.max(0, Number(r.duration) || 0), 0);

    return res.status(200).json(putReport(cacheKey, {
      success: true,
      date,
      data: {
        total: rows.length,
        analyzed: analyzed.length,
        analyzed_minutes: Math.round((sec(analyzed) / 60) * 10) / 10,
        not_analyzed: notAnalyzed.length,
        not_analyzed_minutes: Math.round((sec(notAnalyzed) / 60) * 10) / 10,
        reasons: [...reasons.entries()]
          .sort((a, b) => b[1].count - a[1].count)
          .map(([reason, v]) => ({ reason, count: v.count, minutes: Math.round((v.seconds / 60) * 10) / 10 })),
        operators: [...byOp.entries()]
          .sort((a, b) => b[1].analyzed - a[1].analyzed)
          .map(([ext, v]) => ({
            operator: ext === '—' ? 'Aniqlanmagan' : `Operator ${ext}`,
            analyzed: v.analyzed,
            skipped: v.skipped,
            analyzed_minutes: Math.round((v.analyzedSec / 60) * 10) / 10,
            limit_reached: v.limitHit,
          })),
      },
    }));
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Tahlil holatini hisoblashda xatolik.' });
  }
});

export default router;
