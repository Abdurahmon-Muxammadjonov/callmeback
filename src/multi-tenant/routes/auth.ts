import { Router, Request, Response } from 'express';
import { supabaseAdmin } from '../lib/supabaseAdmin';
import { getClientIp, isIpBlocked, recordInviteFailure } from '../lib/rateLimit';
import { logAudit } from '../lib/auditLog';

const router = Router();

/* =============================================================================
 * Muhim eslatma: "bitta tranzaksiyada" haqida
 * =============================================================================
 * /auth/register-company uchun talab: "companies + auth user + public.users —
 * bitta tranzaksiyada, xato bo'lsa rollback". Bu SO'ZMA-SO'Z bajarilishi
 * MUMKIN EMAS, chunki auth.users Supabase Auth (GoTrue) xizmati orqali
 * boshqariladi va PostgREST/oddiy SQL orqali unga to'g'ridan-to'g'ri INSERT
 * qilish TAVSIYA ETILMAYDI (parol hash'lash, email tasdiqlash tokenlari kabi
 * ichki maydonlar noto'g'ri holatga tushib qolishi mumkin). Ya'ni
 * `supabase.auth.admin.createUser()` — alohida tizim chaqiruvi, u
 * `public.companies`/`public.users`'ga yozish bilan bitta SQL
 * BEGIN/COMMIT ichiga sig'dirib bo'lmaydi.
 *
 * Shu sabab bu yerda SAGA (kompensatsiyalovchi harakatlar) patterni
 * qo'llanilgan: har bosqich xato bersa, oldingi bosqich(lar) QO'LDA orqaga
 * qaytariladi (compensating action). Foydalanuvchiga "yarim yaratilgan"
 * holat hech qachon ko'rinmaydi — muvaffaqiyatli javob faqat HAMMA bosqich
 * o'tgandan keyin qaytadi.
 * ============================================================================= */

function isValidEmail(v: unknown): v is string {
  return typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

// ============================================================================
// POST /auth/register — mavjud kompaniyaga xodim sifatida qo'shilish
// ============================================================================
//
// Request:
//   { "email": "aziz@salon.uz", "password": "kuchli-parol-123",
//     "full_name": "Aziz Karimov", "invite_code": "K7X9M2QRT" }
//
// Response 201:
//   { "success": true, "data": {
//       "user_id": "b5f78196-...", "company_id": "c1538ccf-...",
//       "role": "agent", "full_name": "Aziz Karimov" } }
//
// Xatolar:
//   400 { "success": false, "error": "email, password, full_name, invite_code majburiy." }
//   400 { "success": false, "error": "Kompaniya kodi noto'g'ri yoki mavjud emas." }
//   409 { "success": false, "error": "Bu email bilan foydalanuvchi allaqachon mavjud." }
//   429 { "success": false, "error": "Juda ko'p noto'g'ri urinish. 15 daqiqadan keyin qayta urinib ko'ring." }
//   500 { "success": false, "error": "..." }
router.post('/register', async (req: Request, res: Response) => {
  const ip = getClientIp(req);

  // 3-band: rate limiting — HAR narsadan oldin, hatto body validatsiyasidan
  // ham oldin (bloklangan IP hech qanday qo'shimcha ishni servergа
  // yuklamasligi kerak).
  if (await isIpBlocked(ip)) {
    return res.status(429).json({
      success: false,
      error: "Juda ko'p noto'g'ri urinish. 15 daqiqadan keyin qayta urinib ko'ring.",
    });
  }

  const { email, password, full_name, invite_code } = req.body ?? {};

  if (!isValidEmail(email) || typeof password !== 'string' || password.length < 8
    || typeof full_name !== 'string' || !full_name.trim()
    || typeof invite_code !== 'string' || !invite_code.trim()) {
    return res.status(400).json({
      success: false,
      error: 'email, password (kamida 8 belgi), full_name, invite_code majburiy.',
    });
  }

  const admin = supabaseAdmin();

  // 1) invite_code bo'yicha tenant qidiruvi.
  const { data: company, error: companyErr } = await admin
    .from('companies')
    .select('id, status')
    .eq('invite_code', invite_code.trim())
    .maybeSingle();

  if (companyErr) {
    return res.status(500).json({ success: false, error: `Database Error: ${companyErr.message}` });
  }
  if (!company) {
    // 3-band: bu aynan "noto'g'ri invite_code urinishi" — hisoblanadi va
    // agar shu daqiqada 5-chisi bo'lsa, IP avtomatik 15 daqiqaga bloklanadi.
    await recordInviteFailure(ip);
    return res.status(400).json({ success: false, error: "Kompaniya kodi noto'g'ri yoki mavjud emas." });
  }
  if (company.status !== 'active') {
    return res.status(400).json({ success: false, error: "Bu kompaniya hisobi vaqtincha to'xtatilgan." });
  }

  // 2) auth.users'da hisob yaratish (Supabase Admin SDK).
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: email.trim().toLowerCase(),
    password,
    email_confirm: true, // invite_code orqali kirgan — emailni alohida tasdiqlash shart emas
    user_metadata: { full_name: full_name.trim() },
  });

  if (createErr || !created?.user) {
    const isDuplicate = /already registered|already exists/i.test(createErr?.message || '');
    return res.status(isDuplicate ? 409 : 500).json({
      success: false,
      error: isDuplicate ? 'Bu email bilan foydalanuvchi allaqachon mavjud.' : (createErr?.message || 'Auth xatosi.'),
    });
  }

  const userId = created.user.id;

  // 3) Ushbu kompaniyaning BIRINCHI useri bo'lsa — 'owner', aks holda 'agent'.
  //    Race-condition himoyasi: `public.users(company_id) WHERE role = 'owner'`
  //    ustida PARTIAL UNIQUE INDEX borligini taxmin qilamiz (bir kompaniyada
  //    faqat bitta owner bo'lishi mumkin — DB darajasida kafolatlanadi).
  //    Shu sabab avval 'owner' bilan urinamiz; agar ikkinchi kishi bir vaqtda
  //    ro'yxatdan o'tayotgan bo'lsa, unique-violation qaytadi va 'agent'
  //    bilan qayta urinamiz — oddiy "count qilib tekshirish"dan ko'ra
  //    ishonchliroq, chunki count-check'da ham xuddi shunday poyga (race)
  //    bo'lishi mumkin edi.
  const { count: existingCount } = await admin
    .from('users')
    .select('id', { count: 'exact', head: true })
    .eq('company_id', company.id);

  let role: 'owner' | 'agent' = existingCount && existingCount > 0 ? 'agent' : 'owner';

  let insertErr = (await admin
    .from('users')
    .insert({ id: userId, company_id: company.id, role, full_name: full_name.trim() })
  ).error;

  if (insertErr && /unique|duplicate/i.test(insertErr.message) && role === 'owner') {
    // Poyga holati: boshqa birov ayni paytda owner bo'lib ulgurdi — 'agent' bilan qayta urinamiz.
    role = 'agent';
    insertErr = (await admin
      .from('users')
      .insert({ id: userId, company_id: company.id, role, full_name: full_name.trim() })
    ).error;
  }

  if (insertErr) {
    // Kompensatsiya: auth.users'dagi yozuvni orqaga qaytaramiz — yarim
    // yaratilgan (login qila oladigan, lekin profili yo'q) hisob qolmasin.
    await admin.auth.admin.deleteUser(userId).catch(() => {});
    return res.status(500).json({ success: false, error: `Database Error: ${insertErr.message}` });
  }

  await logAudit({ companyId: company.id, userId, action: 'register', ipAddress: ip, metadata: { role } });

  return res.status(201).json({
    success: true,
    data: { user_id: userId, company_id: company.id, role, full_name: full_name.trim() },
  });
});

// ============================================================================
// POST /auth/register-company — yangi kompaniya + owner birga yaratiladi
// ============================================================================
//
// Request:
//   { "company_name": "Toshkent Motors", "email": "ceo@toshkentmotors.uz",
//     "password": "kuchli-parol-123", "full_name": "Bekzod Yusupov" }
//
// Response 201:
//   { "success": true, "data": {
//       "company_id": "9c2e...", "invite_code": "M4K7X2QRT",
//       "user_id": "b5f7...", "role": "owner" } }
//
// Xatolar:
//   400 { "success": false, "error": "company_name, email, password, full_name majburiy." }
//   409 { "success": false, "error": "Bu email bilan foydalanuvchi allaqachon mavjud." }
//   500 { "success": false, "error": "..." }  (bosqichlardan biri qulasa — pastga qarang)
// Diqqat: bu endpoint 3-banddagi rate-limit qoidasiga kirmaydi (talab faqat
// /auth/register uchun edi — bu yerda invite_code umuman ishlatilmaydi, shu
// sabab "noto'g'ri invite_code urinishi" tushunchasi qo'llanmaydi). Amalda
// bu endpoint ham spam/abuse'ga ochiq (masalan minglab soxta kompaniya
// yaratish) — productionga chiqarishdan oldin umumiy IP/CAPTCHA himoyasi
// qo'shish tavsiya etiladi, lekin bu alohida (keng qamrovli) masala.
router.post('/register-company', async (req: Request, res: Response) => {
  const ip = getClientIp(req);
  const { company_name, email, password, full_name } = req.body ?? {};

  if (typeof company_name !== 'string' || !company_name.trim()
    || !isValidEmail(email) || typeof password !== 'string' || password.length < 8
    || typeof full_name !== 'string' || !full_name.trim()) {
    return res.status(400).json({
      success: false,
      error: 'company_name, email, password (kamida 8 belgi), full_name majburiy.',
    });
  }

  const admin = supabaseAdmin();

  // --- Bosqich 1: companies ---
  // invite_code'ni QO'LDA generatsiya qilmaymiz — jadvalda DEFAULT
  // public.generate_invite_code() o'rnatilgan (bo'lim D, SQL migratsiyada).
  const { data: company, error: companyErr } = await admin
    .from('companies')
    .insert({ name: company_name.trim() })
    .select('id, invite_code')
    .single();

  if (companyErr || !company) {
    return res.status(500).json({ success: false, error: `Kompaniya yaratib bo'lmadi: ${companyErr?.message}` });
  }

  // --- Bosqich 2: auth.users (owner) ---
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email: email.trim().toLowerCase(),
    password,
    email_confirm: true,
    user_metadata: { full_name: full_name.trim() },
  });

  if (createErr || !created?.user) {
    // Kompensatsiya: bosqich 1'ni orqaga qaytaramiz.
    await admin.from('companies').delete().eq('id', company.id);

    const isDuplicate = /already registered|already exists/i.test(createErr?.message || '');
    return res.status(isDuplicate ? 409 : 500).json({
      success: false,
      error: isDuplicate ? 'Bu email bilan foydalanuvchi allaqachon mavjud.' : (createErr?.message || 'Auth xatosi.'),
    });
  }

  const userId = created.user.id;

  // --- Bosqich 3: public.users (owner sifatida bog'lash) ---
  const { error: linkErr } = await admin
    .from('users')
    .insert({ id: userId, company_id: company.id, role: 'owner', full_name: full_name.trim() });

  if (linkErr) {
    // Kompensatsiya: bosqich 1 VA 2'ni orqaga qaytaramiz.
    await admin.auth.admin.deleteUser(userId).catch(() => {});
    await admin.from('companies').delete().eq('id', company.id).then(undefined, () => {});
    return res.status(500).json({ success: false, error: `Foydalanuvchini bog'lab bo'lmadi: ${linkErr.message}` });
  }

  await logAudit({ companyId: company.id, userId, action: 'register_company', ipAddress: ip });

  return res.status(201).json({
    success: true,
    data: { company_id: company.id, invite_code: company.invite_code, user_id: userId, role: 'owner' },
  });
});

export default router;
