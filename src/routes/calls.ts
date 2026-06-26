import { Router, Request, Response } from 'express';
import { supabase } from '../lib/supabase';

const router = Router();
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get('/', async (req: Request, res: Response) => {
  try {
    const managerId = typeof req.query.manager_id === 'string' ? req.query.manager_id : undefined;
    const platformId = typeof req.query.platform_id === 'string' && req.query.platform_id ? req.query.platform_id : undefined;
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || '50'), 10) || 50));

    if (managerId && !UUID_REGEX.test(managerId)) {
      return res.status(400).json({ success: false, error: "manager_id yaroqli UUID bo'lishi kerak." });
    }

    let query = supabase
      .from('calls')
      .select('id, manager_id, platform_id, audio_url, duration, kpi_score, penalty_amount, bonus_amount, rop_comment, status, created_at')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (managerId) query = query.eq('manager_id', managerId);
    if (platformId) query = query.eq('platform_id', platformId);

    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, error: `Database Error: ${error.message}` });
    return res.status(200).json({ success: true, count: data?.length || 0, data });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Failed to list calls.' });
  }
});

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    if (!UUID_REGEX.test(id)) return res.status(400).json({ success: false, error: "id yaroqli UUID bo'lishi kerak." });

    const { data: call, error: cErr } = await supabase.from('calls').select('*').eq('id', id).maybeSingle();
    if (cErr) return res.status(500).json({ success: false, error: `Database Error: ${cErr.message}` });
    if (!call) return res.status(404).json({ success: false, error: "Qo'ng'iroq topilmadi." });

    const [{ data: conversions }, { data: lostReasons }, { data: criteriaScores }] = await Promise.all([
      supabase.from('conversions').select('*').eq('call_id', id).maybeSingle(),
      supabase.from('lost_reasons').select('*').eq('call_id', id),
      supabase.from('call_criteria_scores').select('title, category, score').eq('call_id', id),
    ]);

    return res.status(200).json({
      success: true,
      data: {
        ...call,
        conversions,
        lost_reasons: lostReasons || [],
        criteria_scores: criteriaScores || [],
      },
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Failed to get call.' });
  }
});

export default router;
