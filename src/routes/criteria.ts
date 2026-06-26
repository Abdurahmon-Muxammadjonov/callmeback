import { Router, Request, Response } from 'express';
import { supabase } from '../lib/supabase';

const router = Router();
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get('/', async (req: Request, res: Response) => {
  try {
    let query = supabase.from('criteria').select('*').order('created_at', { ascending: false });
    if (req.query.active === 'true') query = query.eq('is_active', true);
    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, error: `Database Error: ${error.message}` });
    return res.status(200).json({ success: true, data });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Failed to list criteria.' });
  }
});

router.post('/', async (req: Request, res: Response) => {
  try {
    const { title, description, penalty_amount, is_active, category, weight, type } = req.body ?? {};
    if (!title || !description) {
      return res.status(400).json({ success: false, error: 'title va description majburiy.' });
    }
    const { data, error } = await supabase
      .from('criteria')
      .insert({
        title,
        description,
        penalty_amount: penalty_amount !== undefined && penalty_amount !== null ? Number(penalty_amount) : 0,
        is_active: is_active === undefined ? true : !!is_active,
        category: category?.trim() || null,
        weight: weight != null ? Number(weight) : 0,
        type: ['Majburiy', 'Jarima', 'Bonus'].includes(type) ? type : 'Majburiy',
      })
      .select('*')
      .single();
    if (error) return res.status(500).json({ success: false, error: `Database Error: ${error.message}` });
    return res.status(201).json({ success: true, data });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Failed to create criterion.' });
  }
});

router.put('/:id', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    if (!UUID_REGEX.test(id)) return res.status(400).json({ success: false, error: "id yaroqli UUID bo'lishi kerak." });
    const { title, description, penalty_amount, is_active, category, weight, type } = req.body ?? {};
    const update: Record<string, unknown> = {};
    if (title !== undefined) update.title = title;
    if (description !== undefined) update.description = description;
    if (penalty_amount !== undefined) update.penalty_amount = Number(penalty_amount);
    if (is_active !== undefined) update.is_active = !!is_active;
    if (category !== undefined) update.category = category?.trim() || null;
    if (weight !== undefined) update.weight = Number(weight);
    if (type !== undefined && ['Majburiy', 'Jarima', 'Bonus'].includes(type)) update.type = type;
    if (Object.keys(update).length === 0) {
      return res.status(400).json({ success: false, error: 'Yangilash uchun maydon berilmadi.' });
    }
    const { data, error } = await supabase.from('criteria').update(update).eq('id', id).select('*').maybeSingle();
    if (error) return res.status(500).json({ success: false, error: `Database Error: ${error.message}` });
    if (!data) return res.status(404).json({ success: false, error: 'Qoida topilmadi.' });
    return res.status(200).json({ success: true, data });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Failed to update criterion.' });
  }
});

router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    if (!UUID_REGEX.test(id)) return res.status(400).json({ success: false, error: "id yaroqli UUID bo'lishi kerak." });
    const { error } = await supabase.from('criteria').delete().eq('id', id);
    if (error) return res.status(500).json({ success: false, error: `Database Error: ${error.message}` });
    return res.status(200).json({ success: true, message: `Qoida ${id} o'chirildi.` });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Failed to delete criterion.' });
  }
});

export default router;
