import { Router, Response } from 'express';
import { supabase, fetchAllRows } from '../lib/supabase';
import { requireAuth, type CompanyAuthedRequest } from '../middleware/companyAuth';
import { getCompanyManagerIds } from '../lib/companyScope';
import { popStatsInNode, overviewStatsInNode } from '../lib/analyticsFallback';
import { buildCoaching } from '../lib/coaching';

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
          .select('id, duration, kpi_score, rop_comment, dropped_reason, transcript, manager_id, operator_ext')
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
    const stagesByCall = new Map<string, Array<{ title: string; score: number }>>();
    for (const s of stageRows) {
      stagesByCall.set(s.call_id, [...(stagesByCall.get(s.call_id) || []), { title: s.title, score: Number(s.score) || 0 }]);
    }

    // Operator bo'yicha yig'amiz.
    interface Agg {
      key: string; name: string; calls: number; seconds: number;
      scores: number[]; stages: Map<string, number[]>; mistakes: string[];
      reasons: Map<string, number>;
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
      };
      a.calls += 1;
      a.seconds += Math.max(0, Number(c.duration) || 0);
      if (Number(c.kpi_score) > 0) a.scores.push(Number(c.kpi_score));
      for (const st of stagesByCall.get(c.id) || []) {
        a.stages.set(st.title, [...(a.stages.get(st.title) || []), st.score]);
      }
      // Izohdagi "− X · Band: nima qilmadi" qatorlari — aniq dalil sifatida.
      for (const line of String(c.rop_comment || '').split('\n')) {
        if (line.trim().startsWith('−') && a.mistakes.length < 40) a.mistakes.push(line.trim());
      }
      if (c.dropped_reason) a.reasons.set(c.dropped_reason, (a.reasons.get(c.dropped_reason) || 0) + 1);
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
        const { faults, advice } = await buildCoaching(a.name, {
          calls: a.calls,
          minutes: Math.round((a.seconds / 60) * 10) / 10,
          avgScore,
          scoredCalls: a.scores.length,
          stages,
          mistakes: a.mistakes.slice(0, 12),
          reasons: [...a.reasons.entries()].map(([r, n]) => `${r} (${n} ta)`),
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

    const rows = await fetchAllRows<any>((from, to) =>
      supabase.from('calls')
        .select('created_at, duration, direction, kpi_score, transcript, client_phone, operator_ext, manager_id, new_leads_count, sent_to_dealer_count, closed_deals_count, bad_leads_count, unanswered_count')
        .eq('company_id', companyId).gte('created_at', since).range(from, to));

    interface DayAgg {
      calls: number; seconds: number; analyzed: number; scored: number; scoreSum: number;
      incoming: number; outgoing: number; invited: number; closed: number;
      badLeads: number; unanswered: number; leadPhones: Set<string>; leads: number;
    }
    const byDay = new Map<string, DayAgg>();
    const blank = (): DayAgg => ({
      calls: 0, seconds: 0, analyzed: 0, scored: 0, scoreSum: 0,
      incoming: 0, outgoing: 0, invited: 0, closed: 0,
      badLeads: 0, unanswered: 0, leadPhones: new Set(), leads: 0,
    });

    for (const r of rows) {
      const d = dayKeyTashkent(r.created_at);
      const a = byDay.get(d) || blank();
      a.calls += 1;
      a.seconds += Math.max(0, Number(r.duration) || 0);
      if (r.transcript) a.analyzed += 1;
      if (Number(r.kpi_score) > 0) { a.scored += 1; a.scoreSum += Number(r.kpi_score); }
      // Yo'nalish — PBX bergan haqiqiy qiymat.
      if (r.direction === 'incoming') a.incoming += 1;
      else if (r.direction === 'outgoing') a.outgoing += 1;
      a.invited += Number(r.sent_to_dealer_count) || 0;
      a.closed += Number(r.closed_deals_count) || 0;
      a.badLeads += Number(r.bad_leads_count) || 0;
      a.unanswered += Number(r.unanswered_count) || 0;
      // Lid — mijoz bo'yicha takrorlanmaydi (raqam bo'lmasa qo'ng'iroq bo'yicha).
      if (Number(r.new_leads_count) > 0) {
        const phone = String(r.client_phone || '').trim();
        if (phone) a.leadPhones.add(phone); else a.leads += 1;
      }
      byDay.set(d, a);
    }

    const data = [...byDay.entries()].sort((x, y) => y[0].localeCompare(x[0])).map(([date, a]) => ({
      date,
      calls: a.calls,
      minutes: Math.round((a.seconds / 60) * 10) / 10,
      analyzed: a.analyzed,
      scored: a.scored,
      avg_score: a.scored ? Math.round(a.scoreSum / a.scored) : 0, // 0-100
      incoming: a.incoming,
      outgoing: a.outgoing,
      leads: a.leadPhones.size + a.leads,
      invited: a.invited,
      closed: a.closed,
      bad_leads: a.badLeads,
      unanswered: a.unanswered,
    }));

    return res.status(200).json({ success: true, data });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Kunlik yakun hisoblashda xatolik.' });
  }
});

export default router;
