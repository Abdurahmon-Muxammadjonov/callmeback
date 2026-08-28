import { Router, Response } from 'express';
import { supabase, withSchemaReloadRetry, fetchAllRows } from '../lib/supabase';
import { requireAuth, type CompanyAuthedRequest } from '../middleware/companyAuth';

const router = Router();

const VALID_STATUS = ['active', 'inactive', 'on_leave', 'flagged'];
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// XAVFSIZLIK TUZATISHI (production'da aniqlangan CRITICAL xato): bu router
// avval requireAuth'siz va company_id filtrisiz edi — HAR QANDAY kishi
// (login qilmasdan ham) BARCHA kompaniyalarning xodimlari (ism, status,
// kunlik reja va h.k.) ro'yxatini ko'ra, hatto o'chira/o'zgartira olardi.
// Endi: requireAuth majburiy, ro'yxat/o'qish/yozish/o'chirish FAQAT
// chaqiruvchining o'z kompaniyasiga (req.auth.companyId) tegishli
// menejerlar bilan cheklangan.

// GET /managers — operatorlar + har birining qo'ng'iroqlar soni (?platform_id= filtri)
router.get('/', requireAuth, async (req: CompanyAuthedRequest, res: Response) => {
  try {
    const companyId = req.auth!.companyId as string;
    const platformId = typeof req.query.platform_id === 'string' && req.query.platform_id ? req.query.platform_id : null;
    let q = supabase
      .from('managers')
      .select('*, calls(count)')
      .eq('company_id', companyId)
      .order('created_at', { ascending: false });
    if (platformId) q = q.eq('platform_id', platformId);
    const { data, error } = await withSchemaReloadRetry(() => q);
    if (error) return res.status(500).json({ success: false, error: `Database Error: ${error.message}` });
    const mapped = (data || []).map((m: any) => {
      const { calls, ...rest } = m;
      return { ...rest, call_count: Array.isArray(calls) && calls[0] ? Number(calls[0].count) : 0 };
    });
    return res.status(200).json({ success: true, data: mapped });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Failed to list managers.' });
  }
});

// GET /managers/presence — onlayn menejer id'lari (last_seen_at oxirgi 2 daqiqada).
// MUHIM: '/:id' dan OLDIN turishi shart.
const PRESENCE_WINDOW_MS = 120_000;
router.get('/presence', requireAuth, async (req: CompanyAuthedRequest, res: Response) => {
  try {
    const companyId = req.auth!.companyId as string;
    const since = new Date(Date.now() - PRESENCE_WINDOW_MS).toISOString();
    const { data, error } = await supabase.from('managers').select('id').eq('company_id', companyId).gte('last_seen_at', since);
    if (error) return res.status(500).json({ success: false, error: `Database Error: ${error.message}` });
    return res.status(200).json({ success: true, data: (data || []).map((m) => m.id) });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Presence o\'qishda xatolik.' });
  }
});

// Berilgan manager id chaqiruvchining o'z kompaniyasiga tegishli ekanini
// tekshiradi — bo'lmasa null qaytaradi (chaqiruvchi 404 qilib javob beradi,
// "boshqa kompaniyaning manageri mavjud emas" bilan bir xil ko'rinadi —
// mavjudligini ham oshkor qilmaslik uchun).
async function assertOwnManager(id: string, companyId: string): Promise<boolean> {
  const { data } = await supabase.from('managers').select('id').eq('id', id).eq('company_id', companyId).maybeSingle();
  return !!data;
}

// POST /managers/:id/ping — menejer onlayn ekanini bildiradi (heartbeat).
router.post('/:id/ping', requireAuth, async (req: CompanyAuthedRequest, res: Response) => {
  try {
    const companyId = req.auth!.companyId as string;
    const id = String(req.params.id);
    if (!UUID_REGEX.test(id)) return res.status(400).json({ success: false, error: 'id yaroqli UUID bo\'lishi kerak.' });
    if (!(await assertOwnManager(id, companyId))) return res.status(404).json({ success: false, error: 'Manager topilmadi.' });
    const { error } = await supabase.from('managers').update({ last_seen_at: new Date().toISOString() }).eq('id', id);
    if (error) return res.status(500).json({ success: false, error: `Database Error: ${error.message}` });
    return res.status(200).json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Ping xatolik.' });
  }
});

router.post('/', requireAuth, async (req: CompanyAuthedRequest, res: Response) => {
  try {
    const companyId = req.auth!.companyId as string;
    const { name, status, role, platform_id, daily_call_target, pbx_id } = req.body ?? {};
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ success: false, error: '"name" majburiy.' });
    }
    if (status && !VALID_STATUS.includes(status)) {
      return res.status(400).json({ success: false, error: `status quyidagilardan biri bo'lishi kerak: ${VALID_STATUS.join(', ')}` });
    }
    const insertData: Record<string, unknown> = { name, status: status || 'active', company_id: companyId };
    if (role !== undefined) insertData.role = role;
    if (platform_id !== undefined) insertData.platform_id = platform_id;
    if (daily_call_target !== undefined) insertData.daily_call_target = Math.max(0, Math.floor(Number(daily_call_target) || 0));
    if (pbx_id !== undefined) insertData.pbx_id = typeof pbx_id === 'string' ? pbx_id.trim() || null : null;
    const { data, error } = await supabase
      .from('managers')
      .insert(insertData)
      .select('*')
      .single();
    if (error) return res.status(500).json({ success: false, error: `Database Error: ${error.message}` });
    return res.status(201).json({ success: true, data });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Failed to create manager.' });
  }
});

router.get('/:id', requireAuth, async (req: CompanyAuthedRequest, res: Response) => {
  try {
    const companyId = req.auth!.companyId as string;
    const id = String(req.params.id);
    if (!UUID_REGEX.test(id)) return res.status(400).json({ success: false, error: "id yaroqli UUID bo'lishi kerak." });
    const { data, error } = await supabase.from('managers').select('*').eq('id', id).eq('company_id', companyId).maybeSingle();
    if (error) return res.status(500).json({ success: false, error: `Database Error: ${error.message}` });
    if (!data) return res.status(404).json({ success: false, error: 'Manager topilmadi.' });
    return res.status(200).json({ success: true, data });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Failed to get manager.' });
  }
});

router.put('/:id', requireAuth, async (req: CompanyAuthedRequest, res: Response) => {
  try {
    const companyId = req.auth!.companyId as string;
    const id = String(req.params.id);
    if (!UUID_REGEX.test(id)) return res.status(400).json({ success: false, error: "id yaroqli UUID bo'lishi kerak." });
    if (!(await assertOwnManager(id, companyId))) return res.status(404).json({ success: false, error: 'Manager topilmadi.' });
    const { name, status, role, platform_id, daily_call_target, pbx_id } = req.body ?? {};
    const update: Record<string, unknown> = {};
    if (name !== undefined) update.name = name;
    if (status !== undefined) {
      if (!VALID_STATUS.includes(status)) {
        return res.status(400).json({ success: false, error: `status quyidagilardan biri bo'lishi kerak: ${VALID_STATUS.join(', ')}` });
      }
      update.status = status;
    }
    if (role !== undefined) update.role = role;
    if (platform_id !== undefined) update.platform_id = platform_id;
    if (daily_call_target !== undefined) update.daily_call_target = Math.max(0, Math.floor(Number(daily_call_target) || 0));
    if (pbx_id !== undefined) update.pbx_id = typeof pbx_id === 'string' ? pbx_id.trim() || null : null;
    if (Object.keys(update).length === 0) {
      return res.status(400).json({ success: false, error: 'Yangilash uchun maydon berilmadi.' });
    }
    const { data, error } = await supabase.from('managers').update(update).eq('id', id).select('*').maybeSingle();
    if (error) return res.status(500).json({ success: false, error: `Database Error: ${error.message}` });
    if (!data) return res.status(404).json({ success: false, error: 'Manager topilmadi.' });
    return res.status(200).json({ success: true, data });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Failed to update manager.' });
  }
});

router.delete('/:id', requireAuth, async (req: CompanyAuthedRequest, res: Response) => {
  try {
    const companyId = req.auth!.companyId as string;
    const id = String(req.params.id);
    if (!UUID_REGEX.test(id)) return res.status(400).json({ success: false, error: "id yaroqli UUID bo'lishi kerak." });
    if (!(await assertOwnManager(id, companyId))) return res.status(404).json({ success: false, error: 'Manager topilmadi.' });
    const { error } = await supabase.from('managers').delete().eq('id', id);
    if (error) return res.status(500).json({ success: false, error: `Database Error: ${error.message}` });
    return res.status(200).json({ success: true, message: `Manager ${id} o'chirildi.` });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Failed to delete manager.' });
  }
});

router.get('/:id/stats', requireAuth, async (req: CompanyAuthedRequest, res: Response) => {
  try {
    const companyId = req.auth!.companyId as string;
    const id = String(req.params.id);
    if (!UUID_REGEX.test(id)) return res.status(400).json({ success: false, error: "id yaroqli UUID bo'lishi kerak." });

    const { data: manager, error: mErr } = await supabase
      .from('managers').select('id, name, status, role, daily_call_target, last_seen_at, platform_id').eq('id', id).eq('company_id', companyId).maybeSingle();
    if (mErr) return res.status(500).json({ success: false, error: `Database Error: ${mErr.message}` });
    if (!manager) return res.status(404).json({ success: false, error: 'Manager topilmadi.' });

    // Bugungi (UTC 00:00 dan) qo'ng'iroqlar soni — kunlik reja uchun.
    const today = new Date();
    const todayStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())).toISOString();

    let list: Array<{ duration: number | null; kpi_score: number | null; penalty_amount: number | null; bonus_amount: number | null }>;
    let callsToday: number | null;
    try {
      const [rows, { count, error: tErr }] = await Promise.all([
        fetchAllRows<{ duration: number | null; kpi_score: number | null; penalty_amount: number | null; bonus_amount: number | null }>((from, to) =>
          supabase.from('calls').select('duration, kpi_score, penalty_amount, bonus_amount').eq('manager_id', id).range(from, to)),
        supabase.from('calls').select('id', { count: 'exact', head: true }).eq('manager_id', id).gte('created_at', todayStart),
      ]);
      if (tErr) return res.status(500).json({ success: false, error: `Database Error: ${tErr.message}` });
      list = rows;
      callsToday = count;
    } catch (e: any) {
      return res.status(500).json({ success: false, error: `Database Error: ${e?.message || e}` });
    }

    const totalCalls = list.length;
    const sum = (f: (c: any) => number) => list.reduce((a, c) => a + f(c), 0);
    const avg = (f: (c: any) => number) => (totalCalls ? sum(f) / totalCalls : 0);

    return res.status(200).json({
      success: true,
      data: {
        manager,
        total_calls: totalCalls,
        avg_kpi_score: Number(avg((c) => Number(c.kpi_score) || 0).toFixed(2)),
        avg_duration_sec: Math.round(avg((c) => Number(c.duration) || 0)),
        total_penalty: Number(sum((c) => Number(c.penalty_amount) || 0).toFixed(2)),
        total_bonus: Number(sum((c) => Number(c.bonus_amount) || 0).toFixed(2)),
        daily_call_target: (manager as any).daily_call_target ?? 20,
        calls_today: callsToday ?? 0,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Failed to get manager stats.' });
  }
});

export default router;
