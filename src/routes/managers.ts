import { Router, Request, Response } from 'express';
import { supabase } from '../lib/supabase';

const router = Router();

const VALID_STATUS = ['active', 'inactive', 'on_leave', 'flagged'];
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /managers — operatorlar + har birining qo'ng'iroqlar soni (?platform_id= filtri)
router.get('/', async (req: Request, res: Response) => {
  try {
    const platformId = typeof req.query.platform_id === 'string' && req.query.platform_id ? req.query.platform_id : null;
    let q = supabase
      .from('managers')
      .select('*, calls(count)')
      .order('created_at', { ascending: false });
    if (platformId) q = q.eq('platform_id', platformId);
    const { data, error } = await q;
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
router.get('/presence', async (_req: Request, res: Response) => {
  try {
    const since = new Date(Date.now() - PRESENCE_WINDOW_MS).toISOString();
    const { data, error } = await supabase.from('managers').select('id').gte('last_seen_at', since);
    if (error) return res.status(500).json({ success: false, error: `Database Error: ${error.message}` });
    return res.status(200).json({ success: true, data: (data || []).map((m) => m.id) });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Presence o\'qishda xatolik.' });
  }
});

// POST /managers/:id/ping — menejer onlayn ekanini bildiradi (heartbeat).
router.post('/:id/ping', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    if (!UUID_REGEX.test(id)) return res.status(400).json({ success: false, error: 'id yaroqli UUID bo\'lishi kerak.' });
    const { error } = await supabase.from('managers').update({ last_seen_at: new Date().toISOString() }).eq('id', id);
    if (error) return res.status(500).json({ success: false, error: `Database Error: ${error.message}` });
    return res.status(200).json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Ping xatolik.' });
  }
});

router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, status, role, platform_id, daily_call_target } = req.body ?? {};
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ success: false, error: '"name" majburiy.' });
    }
    if (status && !VALID_STATUS.includes(status)) {
      return res.status(400).json({ success: false, error: `status quyidagilardan biri bo'lishi kerak: ${VALID_STATUS.join(', ')}` });
    }
    const insertData: Record<string, unknown> = { name, status: status || 'active' };
    if (role !== undefined) insertData.role = role;
    if (platform_id !== undefined) insertData.platform_id = platform_id;
    if (daily_call_target !== undefined) insertData.daily_call_target = Math.max(0, Math.floor(Number(daily_call_target) || 0));
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

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    if (!UUID_REGEX.test(id)) return res.status(400).json({ success: false, error: "id yaroqli UUID bo'lishi kerak." });
    const { data, error } = await supabase.from('managers').select('*').eq('id', id).maybeSingle();
    if (error) return res.status(500).json({ success: false, error: `Database Error: ${error.message}` });
    if (!data) return res.status(404).json({ success: false, error: 'Manager topilmadi.' });
    return res.status(200).json({ success: true, data });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Failed to get manager.' });
  }
});

router.put('/:id', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    if (!UUID_REGEX.test(id)) return res.status(400).json({ success: false, error: "id yaroqli UUID bo'lishi kerak." });
    const { name, status, role, platform_id, daily_call_target } = req.body ?? {};
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

router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    if (!UUID_REGEX.test(id)) return res.status(400).json({ success: false, error: "id yaroqli UUID bo'lishi kerak." });
    const { error } = await supabase.from('managers').delete().eq('id', id);
    if (error) return res.status(500).json({ success: false, error: `Database Error: ${error.message}` });
    return res.status(200).json({ success: true, message: `Manager ${id} o'chirildi.` });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Failed to delete manager.' });
  }
});

router.get('/:id/stats', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    if (!UUID_REGEX.test(id)) return res.status(400).json({ success: false, error: "id yaroqli UUID bo'lishi kerak." });

    const { data: manager, error: mErr } = await supabase
      .from('managers').select('id, name, status, role, daily_call_target, last_seen_at, platform_id').eq('id', id).maybeSingle();
    if (mErr) return res.status(500).json({ success: false, error: `Database Error: ${mErr.message}` });
    if (!manager) return res.status(404).json({ success: false, error: 'Manager topilmadi.' });

    // Bugungi (UTC 00:00 dan) qo'ng'iroqlar soni — kunlik reja uchun.
    const today = new Date();
    const todayStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())).toISOString();

    const [{ data: calls, error: cErr }, { count: callsToday, error: tErr }] = await Promise.all([
      supabase.from('calls').select('id, duration, kpi_score, penalty_amount, bonus_amount, created_at').eq('manager_id', id),
      supabase.from('calls').select('id', { count: 'exact', head: true }).eq('manager_id', id).gte('created_at', todayStart),
    ]);
    if (cErr) return res.status(500).json({ success: false, error: `Database Error: ${cErr.message}` });
    if (tErr) return res.status(500).json({ success: false, error: `Database Error: ${tErr.message}` });

    const list = calls || [];
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
