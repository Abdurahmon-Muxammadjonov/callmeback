import { Router, Response } from 'express';
import { supabase } from '../lib/supabase';
import { requireAuth, type CompanyAuthedRequest } from '../middleware/companyAuth';

const router = Router();
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// MULTI-TENANT (2026-09-20): baholash mezonlari (criteria) endi HAR
// KOMPANIYAGA alohida. Avval bu router requireAuth'siz va company_id
// filtrisiz edi — barcha kompaniyalar bitta umumiy mezonlar ro'yxatini
// ko'rar/tahrirlar edi. Endi: requireAuth majburiy, har bir so'rov FAQAT
// chaqiruvchining o'z kompaniyasiga (req.auth.companyId) tegishli
// mezonlar bilan ishlaydi. Yangi kompaniya 0 mezon bilan boshlaydi va
// o'zi qo'shib oladi (supabase/pbx_per_company.sql — criteria.company_id).
// Eski (company_id=NULL) global mezonlar legacy bo'lib, hech kimga
// ko'rinmaydi.

router.get('/', requireAuth, async (req: CompanyAuthedRequest, res: Response) => {
  try {
    const companyId = req.auth!.companyId as string;
    let query = supabase.from('criteria').select('*').eq('company_id', companyId).order('created_at', { ascending: false });
    if (req.query.active === 'true') query = query.eq('is_active', true);
    const { data, error } = await query;
    if (error) return res.status(500).json({ success: false, error: `Database Error: ${error.message}` });
    return res.status(200).json({ success: true, data });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Failed to list criteria.' });
  }
});

router.post('/', requireAuth, async (req: CompanyAuthedRequest, res: Response) => {
  try {
    const companyId = req.auth!.companyId as string;
    const { title, description, penalty_amount, is_active, category, weight, type } = req.body ?? {};
    if (!title || !description) {
      return res.status(400).json({ success: false, error: 'title va description majburiy.' });
    }
    const { data, error } = await supabase
      .from('criteria')
      .insert({
        company_id: companyId,
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

router.put('/:id', requireAuth, async (req: CompanyAuthedRequest, res: Response) => {
  try {
    const companyId = req.auth!.companyId as string;
    const id = String(req.params.id);
    if (!UUID_REGEX.test(id)) return res.status(400).json({ success: false, error: "id yaroqli UUID bo'lishi kerak." });
    // Boshqa kompaniyaning mezonini tahrirlab bo'lmasligi uchun avval egalikni tekshiramiz.
    const { data: owned } = await supabase.from('criteria').select('id').eq('id', id).eq('company_id', companyId).maybeSingle();
    if (!owned) return res.status(404).json({ success: false, error: 'Qoida topilmadi.' });

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
    const { data, error } = await supabase.from('criteria').update(update).eq('id', id).eq('company_id', companyId).select('*').maybeSingle();
    if (error) return res.status(500).json({ success: false, error: `Database Error: ${error.message}` });
    if (!data) return res.status(404).json({ success: false, error: 'Qoida topilmadi.' });
    return res.status(200).json({ success: true, data });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Failed to update criterion.' });
  }
});

router.delete('/:id', requireAuth, async (req: CompanyAuthedRequest, res: Response) => {
  try {
    const companyId = req.auth!.companyId as string;
    const id = String(req.params.id);
    if (!UUID_REGEX.test(id)) return res.status(400).json({ success: false, error: "id yaroqli UUID bo'lishi kerak." });
    // .eq('company_id', ...) — boshqa kompaniyaning mezonini o'chirib bo'lmaydi.
    const { error, count } = await supabase.from('criteria').delete({ count: 'exact' }).eq('id', id).eq('company_id', companyId);
    if (error) return res.status(500).json({ success: false, error: `Database Error: ${error.message}` });
    if (!count) return res.status(404).json({ success: false, error: 'Qoida topilmadi.' });
    return res.status(200).json({ success: true, message: `Qoida ${id} o'chirildi.` });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Failed to delete criterion.' });
  }
});

export default router;
