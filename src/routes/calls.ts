import { Router, Response } from 'express';
import { supabase } from '../lib/supabase';
import { requireAuth, type CompanyAuthedRequest } from '../middleware/companyAuth';

const router = Router();
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// XAVFSIZLIK TUZATISHI (production'da aniqlangan CRITICAL xato): bu router
// avval requireAuth'siz va company_id filtrisiz edi — HAR QANDAY kishi
// (login qilmasdan ham) /api/calls'ga so'rov yuborib BARCHA kompaniyalarning
// qo'ng'iroqlarini (jumladan audio_url — chaqiruv audiosi!) ko'ra olardi.
// Endi: requireAuth majburiy, va har bir so'rov FAQAT chaqiruvchining
// o'z kompaniyasiga (req.auth.companyId) tegishli qatorlarni qaytaradi.
// Eski (multi-tenant'dan oldingi) PBX pipeline'idan kelgan qatorlar
// company_id=NULL bilan saqlangan — ular endi HECH KIMGA ko'rinmaydi
// (bu to'g'ri: hech qanday haqiqiy tenant'ga tegishli emas).
router.get('/', requireAuth, async (req: CompanyAuthedRequest, res: Response) => {
  try {
    const companyId = req.auth!.companyId as string;
    const managerId = typeof req.query.manager_id === 'string' ? req.query.manager_id : undefined;
    const platformId = typeof req.query.platform_id === 'string' && req.query.platform_id ? req.query.platform_id : undefined;
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || '50'), 10) || 50));

    if (managerId && !UUID_REGEX.test(managerId)) {
      return res.status(400).json({ success: false, error: "manager_id yaroqli UUID bo'lishi kerak." });
    }

    let query = supabase
      .from('calls')
      .select('id, manager_id, platform_id, audio_url, duration, kpi_score, penalty_amount, bonus_amount, rop_comment, status, created_at, incoming_count, outgoing_count, unanswered_count, bad_leads_count, new_leads_count, sent_to_dealer_count, closed_deals_count')
      .eq('company_id', companyId)
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

router.get('/:id', requireAuth, async (req: CompanyAuthedRequest, res: Response) => {
  try {
    const companyId = req.auth!.companyId as string;
    const id = String(req.params.id);
    if (!UUID_REGEX.test(id)) return res.status(400).json({ success: false, error: "id yaroqli UUID bo'lishi kerak." });

    // .eq('company_id', ...) shu yerda ham SHART — aks holda boshqa
    // kompaniyaning to'g'ri UUID'sini bilgan (yoki taxmin qilgan) kishi
    // shu endpoint orqali baribir ko'ra olar edi.
    const { data: call, error: cErr } = await supabase.from('calls').select('*').eq('id', id).eq('company_id', companyId).maybeSingle();
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
