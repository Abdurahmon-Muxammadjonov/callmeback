import { Router, Response } from 'express';
import multer from 'multer';
import { supabase } from '../lib/supabase';
import { requireAuth, requireCompanyRole, type CompanyAuthedRequest } from '../middleware/companyAuth';

const router = Router();

// Logotip — kichik rasm, xotirada ushlab turish xavfsiz (2MB chegara pastda).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 },
});

const ALLOWED_LOGO_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

// ============================================================================
// GET /company/me — login qilgan foydalanuvchining O'Z kompaniyasi
// ============================================================================
router.get('/me', requireAuth, async (req: CompanyAuthedRequest, res: Response) => {
  // req.auth.companyId — tokendan olinadi, HECH QACHON req.query/params'dan
  // emas — aks holda mijoz o'zi xohlagan company_id so'rab, boshqa
  // kompaniyaning ma'lumotini ko'rishi mumkin bo'lardi.
  const { data, error } = await supabase
    .from('companies')
    .select('id, name, logo_url, plan, created_at, tariff_id, tariffs(key, name, included_sections)')
    .eq('id', req.auth!.companyId as string)
    .maybeSingle();

  if (error) return res.status(500).json({ success: false, error: `Database Error: ${error.message}` });
  if (!data) return res.status(404).json({ success: false, error: 'Kompaniya topilmadi.' });

  // `tariffs` — Supabase'ning FK-orqali join qilingan ustuni, tariff_id
  // NULL bo'lsa ham xato bermaydi (hali hech qanday tarif olinmagan bo'lishi
  // mumkin — frontend buni "Get code" oqimi hali boshlanmagan deb talqin qiladi).
  const { tariffs: tariff, ...company } = data as typeof data & { tariffs: any };
  return res.status(200).json({ success: true, data: { ...company, tariff: tariff ?? null } });
});

// ============================================================================
// GET /company/settings — "Analitika" sahifasi KPI norma chegaralari
// ============================================================================
// Frontend'dagi DEFAULT_NORMS (app/lib/analytics.ts) bilan bir xil qiymatlar —
// yozuv hali bo'lmasa ham backend shu standartlarni qaytaradi (insert shart emas).
const DEFAULT_COMPANY_SETTINGS = {
  qualified_call_seconds: 60,
  min_qualified_calls_day: 40,
  min_qualified_calls_week: 160,
  min_qualified_calls_month: 640,
  min_efficiency_score: 50,
};
const COMPANY_SETTINGS_COLUMNS = Object.keys(DEFAULT_COMPANY_SETTINGS) as Array<keyof typeof DEFAULT_COMPANY_SETTINGS>;

router.get('/settings', requireAuth, async (req: CompanyAuthedRequest, res: Response) => {
  const companyId = req.auth!.companyId as string;

  const { data, error } = await supabase
    .from('company_settings')
    .select(COMPANY_SETTINGS_COLUMNS.join(', '))
    .eq('company_id', companyId)
    .maybeSingle();

  if (error) return res.status(500).json({ success: false, error: `Database Error: ${error.message}` });

  return res.status(200).json({ success: true, data: data ?? DEFAULT_COMPANY_SETTINGS });
});

// ============================================================================
// PATCH /company/settings — norma chegaralarini o'zgartirish, faqat director/admin
// ============================================================================
router.patch('/settings', requireAuth, requireCompanyRole(['director', 'admin']), async (req: CompanyAuthedRequest, res: Response) => {
  const companyId = req.auth!.companyId as string;
  const body = (req.body ?? {}) as Record<string, unknown>;

  const update: Record<string, number> = {};
  for (const key of COMPANY_SETTINGS_COLUMNS) {
    if (body[key] === undefined) continue;
    const n = Number(body[key]);
    if (!Number.isFinite(n) || n < 0) {
      return res.status(400).json({ success: false, error: `"${key}" manfiy bo'lmagan son bo'lishi kerak.` });
    }
    if (key === 'min_efficiency_score' && n > 100) {
      return res.status(400).json({ success: false, error: '"min_efficiency_score" 0 dan 100 gacha bo\'lishi kerak.' });
    }
    update[key] = Math.floor(n);
  }

  if (Object.keys(update).length === 0) {
    return res.status(400).json({ success: false, error: `Kamida bitta maydon berilishi kerak: ${COMPANY_SETTINGS_COLUMNS.join(', ')}` });
  }

  const { data, error } = await supabase
    .from('company_settings')
    .upsert({ company_id: companyId, ...update }, { onConflict: 'company_id' })
    .select(COMPANY_SETTINGS_COLUMNS.join(', '))
    .single();

  if (error) return res.status(500).json({ success: false, error: `Database Error: ${error.message}` });

  return res.status(200).json({ success: true, data });
});

// ============================================================================
// POST /company/logo — logotip yuklash, faqat director/admin
// ============================================================================
router.post('/logo', requireAuth, requireCompanyRole(['director', 'admin']), upload.single('logo'), async (req: CompanyAuthedRequest, res: Response) => {
  const file = req.file;
  if (!file) {
    return res.status(400).json({ success: false, error: '"logo" fayli majburiy (multipart/form-data).' });
  }

  const ext = ALLOWED_LOGO_TYPES[file.mimetype];
  if (!ext) {
    return res.status(400).json({ success: false, error: 'Fayl turi qo\'llab-quvvatlanmaydi (faqat PNG, JPEG, WEBP).' });
  }
  if (file.size > 2 * 1024 * 1024) {
    return res.status(400).json({ success: false, error: 'Fayl hajmi 2MB dan oshmasligi kerak.' });
  }

  const companyId = req.auth!.companyId as string;
  const path = `${companyId}/logo.${ext}`;

  // service_role klient — Storage RLS'ni chetlab o'tadi (bu ilovada Storage
  // RLS umuman ishlamaydi, sabab supabase/company_branding.sql'dagi izohda).
  // Avtorizatsiya YUQORIDA (requireAuth + requireCompanyRole) allaqachon
  // tekshirilgan — bu yerga faqat director/admin yeta oladi.
  const { error: uploadErr } = await supabase.storage
    .from('company-logos')
    .upload(path, file.buffer, { contentType: file.mimetype, upsert: true });

  if (uploadErr) {
    return res.status(500).json({ success: false, error: `Logotip yuklab bo'lmadi: ${uploadErr.message}` });
  }

  const { data: pub } = supabase.storage.from('company-logos').getPublicUrl(path);
  // Eski format bilan yuklangan fayl (masalan avval .png, endi .jpg) endi
  // logo_url'da ko'rinmay qolmasligi uchun cache-buster qo'shamiz — aks
  // holda brauzer eski (keshdagi) faylni ko'rsataveradi, chunki URL o'zgarmadi.
  const logoUrl = `${pub.publicUrl}?v=${Date.now()}`;

  const { error: updateErr } = await supabase.from('companies').update({ logo_url: logoUrl }).eq('id', companyId);
  if (updateErr) {
    return res.status(500).json({ success: false, error: `Database Error: ${updateErr.message}` });
  }

  return res.status(200).json({ success: true, data: { logo_url: logoUrl } });
});

// ============================================================================
// DELETE /company/logo — logotipni o'chirish, faqat director/admin
// ============================================================================
router.delete('/logo', requireAuth, requireCompanyRole(['director', 'admin']), async (req: CompanyAuthedRequest, res: Response) => {
  const companyId = req.auth!.companyId as string;

  // Ikkala mumkin bo'lgan kengaytmani ham o'chirishga urinamiz — qaysi
  // formatda yuklangani noma'lum, .remove() mavjud bo'lmagan fayl uchun
  // xato bermaydi (jim o'tadi), shu sabab bir nechtasini bir yo'la
  // ko'rsatish xavfsiz.
  await supabase.storage.from('company-logos').remove(
    Object.values(ALLOWED_LOGO_TYPES).map((ext) => `${companyId}/logo.${ext}`)
  );

  const { error } = await supabase.from('companies').update({ logo_url: null }).eq('id', companyId);
  if (error) return res.status(500).json({ success: false, error: `Database Error: ${error.message}` });

  return res.status(200).json({ success: true });
});

export default router;
