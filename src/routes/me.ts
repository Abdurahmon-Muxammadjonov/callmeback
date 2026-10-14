import { Router, Response } from 'express';
import { supabase } from '../lib/supabase';
import { requireAuth, type CompanyAuthedRequest } from '../middleware/companyAuth';
import { addDays, dayBounds, tashkentDay } from '../lib/tashkentTime';
import { reportRpc } from '../lib/reportRpc';
import { getCompanySettings } from '../lib/companySettings';
import { operatorExtOf } from '../lib/operatorScope';
import {
  buildStaffStats, buildOperatorDay,
  type StaffOpItem, type OperatorDayItem, type OperatorInsight,
} from '../lib/reportBuilders';

// ============================================================================
// /api/me — XODIM (operator) KABINETI, 2026-10-15.
//
// Foydalanuvchi talabi: har bir menejer o'z akkauntiga kirganda o'z
// skriptlarini ("qanday gaplashish kerak"), o'z audiolari va tahlilini,
// yaxshi ishlashi uchun maslahat va yechimlarni ko'rsin.
//
// Hamma javob FAQAT tokendagi foydalanuvchi va uning ichki raqami
// (users.operator_ext) bo'yicha — mijozdan kelgan id/raqamga ishonilmaydi.
// Raqamlar direktor ko'radigan hisobotlar bilan BIR manbadan
// (calls_staff_day_stats, calls_operator_day_stats) — farq qilmaydi.
// O'z qo'ng'iroqlari ro'yxati va audiosi — /api/calls (xodim tokeni bilan
// avtomatik o'z raqamiga cheklanadi, lib/operatorScope.ts).
// ============================================================================

const router = Router();
router.use(requireAuth);

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// GET /api/me/operator — kim ekanim va qaysi operatorga bog'langanman.
router.get('/operator', async (req: CompanyAuthedRequest, res: Response) => {
  try {
    const { data: user, error } = await supabase
      .from('users')
      .select('id, name, email, phone, role, operator_ext, shift_start, shift_end')
      .eq('id', req.auth!.userId)
      .eq('company_id', req.auth!.companyId)
      .maybeSingle();
    if (error) return res.status(500).json({ success: false, error: `Database Error: ${error.message}` });
    if (!user) return res.status(404).json({ success: false, error: 'User topilmadi.' });
    const ext = String((user as any).operator_ext ?? '').trim() || null;
    return res.status(200).json({ success: true, data: { ...user, operator_ext: ext } });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Xatolik.' });
  }
});

// GET /api/me/summary?date=YYYY-MM-DD — o'sha kungi natijam: qo'ng'iroqlar,
// uzun suhbatlar/norma, ball, skript bandlari, eng ko'p xatolar, yo'qotilgan
// bitim sabablari, AI maslahatlari (operator_insights).
router.get('/summary', async (req: CompanyAuthedRequest, res: Response) => {
  try {
    const companyId = req.auth!.companyId as string;
    const date = typeof req.query.date === 'string' && DAY_RE.test(req.query.date) ? req.query.date : tashkentDay(new Date());
    const ext = await operatorExtOf(req.auth!.userId, companyId);
    if (!ext) return res.status(200).json({ success: true, date, linked: false, data: null });

    const from = dayBounds(date).from;
    const to = dayBounds(addDays(date, 1)).from;
    const settings = await getCompanySettings(supabase, companyId);
    const longSec = Math.max(1, Number(settings.qualified_call_seconds) || 60);
    const [staffItems, opItems, insight] = await Promise.all([
      reportRpc<StaffOpItem[]>('calls_staff_day_stats', { p_company_id: companyId, p_from: from, p_to: to }),
      reportRpc<OperatorDayItem[]>('calls_operator_day_stats', { p_company_id: companyId, p_from: from, p_to: to, p_long_sec: longSec }),
      supabase.from('operator_insights')
        .select('operator_ext, items_uz, generated_at, based_on_calls')
        .eq('company_id', companyId)
        .eq('operator_ext', ext)
        .maybeSingle()
        .then((r) => r, () => ({ data: null, error: null })),
    ]);

    const insightByExt = new Map<string, OperatorInsight>();
    const row: any = (insight as any)?.data;
    if (row && Array.isArray(row.items_uz)) {
      const items = row.items_uz.filter((x: unknown): x is string => typeof x === 'string' && x.trim() !== '');
      if (items.length) insightByExt.set(ext, { items, generatedAt: row.generated_at, basedOnCalls: Number(row.based_on_calls) || 0 });
    }
    const mine = (items: Array<{ key: string }>) => items.filter((i) => i.key === `ext:${ext}` || i.key === ext);
    const staff = buildStaffStats(mine(staffItems || []) as StaffOpItem[], new Map(), insightByExt)[0] ?? null;
    const day = buildOperatorDay(mine(opItems || []) as OperatorDayItem[], new Map())[0] ?? null;
    // Kun bo'sh bo'lsa ham tayyorlangan maslahat ko'rinsin (u kunga bog'liq emas).
    const advice = insightByExt.get(ext) ?? null;

    return res.status(200).json({
      success: true,
      date,
      linked: true,
      data: {
        ext,
        norm: Number(settings.min_qualified_calls_day) || null, // kunlik uzun suhbat normasi
        long_sec: longSec,
        day,
        staff,
        advice: advice ? { items: advice.items, generated_at: advice.generatedAt, based_on_calls: advice.basedOnCalls } : null,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Xatolik.' });
  }
});

// GET /api/me/guide — "qanday gaplashish kerak": kompaniyaning aktiv
// baholash mezonlari (skript bosqichlari, AI aynan shular bo'yicha baholaydi)
// va menga biriktirilgan skriptlar (user_scripts).
router.get('/guide', async (req: CompanyAuthedRequest, res: Response) => {
  try {
    const companyId = req.auth!.companyId as string;
    const [criteria, scripts] = await Promise.all([
      supabase.from('criteria')
        .select('id, title, description, category, type, weight, penalty_amount')
        .eq('company_id', companyId)
        .eq('is_active', true)
        .order('category', { ascending: true })
        .order('title', { ascending: true }),
      supabase.from('user_scripts')
        .select('id, title, enabled')
        .eq('user_id', req.auth!.userId)
        .order('created_at', { ascending: true }),
    ]);
    if (criteria.error) return res.status(500).json({ success: false, error: `Database Error: ${criteria.error.message}` });
    return res.status(200).json({
      success: true,
      data: { criteria: criteria.data || [], scripts: (scripts.data || []).filter((s: any) => s.enabled !== false) },
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Xatolik.' });
  }
});

export default router;
