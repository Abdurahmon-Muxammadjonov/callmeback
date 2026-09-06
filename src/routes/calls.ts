import { Router, Request, Response } from 'express';
import { Readable } from 'node:stream';
import { supabase } from '../lib/supabase';
import { requireAuth, type CompanyAuthedRequest } from '../middleware/companyAuth';
import { signAudioToken, verifyAudioToken, pbxAuthHeaders, isSupabaseStorageUrl } from '../lib/audioAccess';

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

// ---------------------------------------------------------------------------
// Audio havolasi (2026-09-06): audio endi Supabase Storage'ga nusxalanmaydi,
// calls.audio_url PBX'dagi asl havolaga ishora qiladi — u esa API kalitsiz
// ochilmaydi. Shu sabab javobda audio_url o'rniga shu backend'dagi imzolangan
// proxy havolasi qaytariladi: brauzerdagi <audio> tegi uni to'g'ridan-to'g'ri
// eshita oladi (maxfiy sarlavha kerak emas, token havolaning ichida).
//
// Eski qatorlarda (Storage nusxasi bo'lganlar) audio_url o'zgarishsiz qoladi.
// ---------------------------------------------------------------------------
function publicOrigin(req: Request): string {
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim() || req.protocol || 'https';
  const host = req.get('host') || '';
  return `${proto}://${host}`;
}

function withPlayableAudioUrl<T extends { id: string; audio_url?: string | null }>(
  row: T,
  companyId: string,
  req: Request,
): T {
  const url = row.audio_url || '';
  if (!url || isSupabaseStorageUrl(url)) return row;
  const token = signAudioToken(row.id, companyId);
  if (!token) return row;
  return { ...row, audio_url: `${publicOrigin(req)}/api/calls/${row.id}/audio?t=${encodeURIComponent(token)}` };
}

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
    const rows = (data || []).map((row: any) => withPlayableAudioUrl(row, companyId, req));
    return res.status(200).json({ success: true, count: rows.length, data: rows });
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
        ...withPlayableAudioUrl(call as any, companyId, req),
        conversions,
        lost_reasons: lostReasons || [],
        criteria_scores: criteriaScores || [],
      },
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Failed to get call.' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/calls/:id/audio?t=<imzolangan token>
// Audioni PBX'dan OQIM qilib uzatadi (Supabase Storage ishlatilmaydi).
// Autentifikatsiya requireAuth orqali EMAS, chunki <audio src="..."> tegi
// Authorization sarlavhasini yubora olmaydi — buning o'rniga qisqa muddatli
// imzolangan token (6 soat) havolaning ichida keladi va u qaysi qo'ng'iroq
// hamda qaysi kompaniya uchun berilganini o'zida saqlaydi.
// ---------------------------------------------------------------------------
router.get('/:id/audio', async (req: Request, res: Response) => {
  try {
    const id = String(req.params.id);
    if (!UUID_REGEX.test(id)) return res.status(400).json({ success: false, error: "id yaroqli UUID bo'lishi kerak." });
    const token = typeof req.query.t === 'string' ? req.query.t : '';
    const payload = token ? verifyAudioToken(token) : null;
    if (!payload || payload.call_id !== id) {
      return res.status(401).json({ success: false, error: 'Havola yaroqsiz yoki muddati tugagan.' });
    }

    const { data: call } = await supabase
      .from('calls')
      .select('id, audio_url, audio_source_url')
      .eq('id', id)
      .eq('company_id', payload.company_id)
      .maybeSingle();
    if (!call) return res.status(404).json({ success: false, error: "Qo'ng'iroq topilmadi." });

    const sourceUrl = (call.audio_source_url || call.audio_url || '').trim();
    if (!sourceUrl) return res.status(404).json({ success: false, error: 'Audio havolasi yo\'q.' });

    // Range so'rovini o'tkazib yuboramiz — brauzer audioni oldinga/orqaga
    // surishi (seek) uchun shart.
    const range = req.headers.range;
    const upstream = await fetch(sourceUrl, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': 'Procell-Audio/1.0',
        Accept: 'audio/*,*/*',
        ...(range ? { Range: range } : {}),
        ...(await pbxAuthHeaders(sourceUrl)),
      },
    });

    if (!upstream.ok && upstream.status !== 206) {
      return res.status(502).json({ success: false, error: `Audio manbadan olinmadi: HTTP ${upstream.status}` });
    }

    res.status(upstream.status === 206 ? 206 : 200);
    for (const header of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const value = upstream.headers.get(header);
      if (value) res.setHeader(header, value);
    }
    if (!upstream.headers.get('accept-ranges')) res.setHeader('accept-ranges', 'bytes');
    res.setHeader('cache-control', 'private, max-age=3600');

    if (!upstream.body) return res.end();
    Readable.fromWeb(upstream.body as any).pipe(res);
  } catch (err: any) {
    if (!res.headersSent) {
      return res.status(500).json({ success: false, error: err?.message || 'Audio uzatishda xatolik.' });
    }
    res.end();
  }
});

export default router;
