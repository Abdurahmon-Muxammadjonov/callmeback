import { Router, Request, Response } from 'express';
import { supabase } from '../lib/supabase';
import { requireAuth, requireCompanyRole, type CompanyAuthedRequest } from '../middleware/companyAuth';
import { ALWAYS_UNLOCKED_SECTIONS, LOCKABLE_SECTIONS, isLockableSection } from '../lib/companySections';
import { generateUnlockCode, hashUnlockCode, verifyUnlockCode } from '../lib/sectionUnlockCode';
import { backfillPendingUnlockCalls } from './analyze-call';

const router = Router();

// ============================================================================
// GET /company/sections — joriy kompaniyaning bo'lim holatlari
// ============================================================================
router.get('/sections', requireAuth, async (req: CompanyAuthedRequest, res: Response) => {
  const companyId = req.auth!.companyId as string;

  const { data, error } = await supabase
    .from('company_sections')
    .select('section_key, is_locked')
    .eq('company_id', companyId);

  if (error) return res.status(500).json({ success: false, error: `Database Error: ${error.message}` });

  // Tarif prompt Part 4.1: frontend "kod kiritish" va "tarifni yangilash"
  // modallarini ajratishi uchun HAR BIR qulflangan bo'lim kompaniyaning
  // joriy tarifiga kiradimi (in_plan) yoki yo'qligini bilishi kerak —
  // shu sabab shu yerda companies.tariff_id -> tariffs.included_sections
  // ham o'qib qo'shiladi.
  const { data: company } = await supabase
    .from('companies')
    .select('tariff_id')
    .eq('id', companyId)
    .maybeSingle();

  let includedSections: string[] = [];
  if (company?.tariff_id) {
    const { data: tariff } = await supabase
      .from('tariffs')
      .select('included_sections')
      .eq('id', company.tariff_id)
      .maybeSingle();
    includedSections = tariff?.included_sections || [];
  }

  const rowsByKey = new Map((data || []).map((r) => [r.section_key, r.is_locked]));

  const sections = [
    ...ALWAYS_UNLOCKED_SECTIONS.map((key) => ({ section_key: key, is_locked: false, in_plan: true })),
    // Qator yo'q bo'lgan bo'lim uchun ham default (is_locked=true) qaytariladi —
    // register-company'da alohida "seed" qadami yo'qligining sababi shu
    // (supabase/company_sections_webhooks.sql'dagi izohga qarang).
    ...LOCKABLE_SECTIONS.map((key) => ({
      section_key: key,
      is_locked: rowsByKey.has(key) ? rowsByKey.get(key) : true,
      // tarifi hali yo'q (tariff_id=null) kompaniya uchun hech narsa
      // "planda" hisoblanmaydi — bot Part 2'dagi "hali to'lamagan" holatiga mos.
      in_plan: includedSections.includes(key),
    })),
  ];

  return res.status(200).json({ success: true, data: sections });
});

// ============================================================================
// POST /company/sections/unlock — bir martalik kod bilan bo'lim ochish
// ============================================================================
router.post('/sections/unlock', requireAuth, requireCompanyRole(['director', 'admin']), async (req: CompanyAuthedRequest, res: Response) => {
  const { section_key, code } = req.body ?? {};
  const companyId = req.auth!.companyId as string;

  if (typeof section_key !== 'string' || !isLockableSection(section_key)) {
    return res.status(400).json({ success: false, error: `section_key quyidagilardan biri bo'lishi kerak: ${LOCKABLE_SECTIONS.join(', ')}` });
  }
  if (typeof code !== 'string' || !code.trim()) {
    return res.status(400).json({ success: false, error: 'code majburiy.' });
  }

  // Shu kompaniya+bo'lim uchun ISHLATILMAGAN kodlarni olib, mos kelganini qidiramiz
  // (hash'lar orqali solishtirish uchun oldindan ro'yxatini olishga majburmiz —
  // bcrypt hash orqali to'g'ridan-to'g'ri WHERE bilan qidirib bo'lmaydi).
  const { data: candidates, error: candErr } = await supabase
    .from('section_unlock_codes')
    .select('id, code')
    .eq('company_id', companyId)
    .eq('section_key', section_key)
    .eq('used', false);

  if (candErr) return res.status(500).json({ success: false, error: `Database Error: ${candErr.message}` });

  const match = (candidates || []).find((c) => verifyUnlockCode(code, c.code));
  if (!match) {
    return res.status(400).json({ success: false, error: "Kod noto'g'ri yoki allaqachon ishlatilgan." });
  }

  // Kodni ishlatilgan deb belgilaymiz.
  const { error: useErr } = await supabase
    .from('section_unlock_codes')
    .update({ used: true, used_at: new Date().toISOString() })
    .eq('id', match.id)
    .eq('used', false); // ikki parallel so'rov bitta kodni ikki marta ishlatmasin

  if (useErr) return res.status(500).json({ success: false, error: `Database Error: ${useErr.message}` });

  // Bo'limni ochamiz (upsert — qator hali bo'lmasligi mumkin, default holat edi).
  const { error: unlockErr } = await supabase
    .from('company_sections')
    .upsert({
      company_id: companyId,
      section_key,
      is_locked: false,
      unlocked_at: new Date().toISOString(),
      unlocked_by: req.auth!.userId,
    }, { onConflict: 'company_id,section_key' });

  if (unlockErr) return res.status(500).json({ success: false, error: `Database Error: ${unlockErr.message}` });

  // Backfill: shu bo'lim AI-tahlilga bog'liq bo'lsa (hozircha faqat
  // call_analytics), avvalgi "pending_unlock" qo'ng'iroqlarni qayta navbatga
  // qo'yamiz — talab qilingan default xulq (variant a: ma'lumot yo'qolmaydi).
  if (section_key === 'call_analytics') {
    void backfillPendingUnlockCalls(supabase, companyId);
  }

  return res.status(200).json({ success: true, data: { section_key, is_locked: false } });
});

// ============================================================================
// POST /admin/section-codes — SalesPulse platforma admini kod chiqaradi
// ============================================================================
// Bu kompaniyaning o'z owner/director'i EMAS, balki platforma egasi
// tomonidan chaqiriladi — xuddi mavjud /crm/admin/sync-calls kabi
// x-admin-sync-token header bilan himoyalangan (ADMIN_SYNC_TOKEN env).
router.post('/admin/section-codes', async (req: Request, res: Response) => {
  const expectedToken = (process.env.ADMIN_SYNC_TOKEN || '').trim();
  if (!expectedToken) {
    return res.status(500).json({ success: false, error: 'ADMIN_SYNC_TOKEN sozlanmagan.' });
  }
  const provided = (typeof req.headers['x-admin-sync-token'] === 'string' ? req.headers['x-admin-sync-token'] : '').trim();
  if (provided !== expectedToken) {
    return res.status(401).json({ success: false, error: 'Admin token noto\'g\'ri.' });
  }

  const { company_id, section_key, issued_by } = req.body ?? {};
  if (typeof company_id !== 'string' || !company_id.trim()) {
    return res.status(400).json({ success: false, error: 'company_id majburiy.' });
  }
  if (typeof section_key !== 'string' || !isLockableSection(section_key)) {
    return res.status(400).json({ success: false, error: `section_key quyidagilardan biri bo'lishi kerak: ${LOCKABLE_SECTIONS.join(', ')}` });
  }

  const code = generateUnlockCode();
  const { error } = await supabase.from('section_unlock_codes').insert({
    company_id,
    section_key,
    code: hashUnlockCode(code),
    created_by: typeof issued_by === 'string' ? issued_by.trim() : null,
  });

  if (error) return res.status(500).json({ success: false, error: `Database Error: ${error.message}` });

  // Kod FAQAT shu javobda ochiq ko'rinadi — bazada hash saqlanadi, qayta
  // ko'rsatib bo'lmaydi (yo'qotilsa, yangi kod chiqarish kerak).
  return res.status(201).json({ success: true, data: { company_id, section_key, code } });
});

export default router;
