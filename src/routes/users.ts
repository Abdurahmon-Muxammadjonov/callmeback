import { Router, Request, Response } from 'express';
import { scryptSync, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { supabase } from '../lib/supabase';
import { markOnline, markOffline, onlineIds } from '../lib/presence';
import { signSessionToken } from '../lib/authToken';
import { requireAuth, type CompanyAuthedRequest } from '../middleware/companyAuth';
import { invalidateOperatorNames } from '../lib/operatorNames';
import { rememberPassword, revealPassword } from '../lib/passwordVault';

const router = Router();

// Faqat ochiq (xavfsiz) ustunlar — password_hash hech qachon qaytarilmaydi.
// Eslatma: bu ro'yxat uchun — migration ishlamagan bo'lsa ham buzilmasin (faqat
// doim mavjud ustunlar). GET /:id esa '*' ni oladi (yangi ustunlarni ham beradi).
// operator_ext (2026-10-15) — akkaunt bog'langan telefoniya operatori (ichki
// raqam). supabase/staff_01_user_operator_ext.sql ishga tushirilgan bo'lishi shart.
const PUBLIC_COLS = 'id, name, email, age, phone, role, operator_ext, created_at';

// Ichki raqam: faqat raqamlar (UTel "105", "5200"); bo'sh/null — bog'lanishni uzish.
function parseOperatorExt(v: unknown): { ok: true; value: string | null } | { ok: false } {
  if (v === null || v === '') return { ok: true, value: null };
  const s = String(v).trim();
  return /^\d{1,8}$/.test(s) ? { ok: true, value: s } : { ok: false };
}

// Yangi parollar bcrypt bilan hash qilinadi ($2... format).
function hashPassword(plain: string): string {
  return bcrypt.hashSync(plain, 10);
}

// verify ikkala formatni ham qo'llab-quvvatlaydi:
//  - bcrypt ($2a/$2b/$2y...) — yangi parollar
//  - eski scrypt (salt:hash) — avval yaratilgan hisoblar buzilmasin
function verifyPassword(plain: string, stored: string | null): boolean {
  if (!stored) return false;
  if (stored.startsWith('$2')) {
    try { return bcrypt.compareSync(plain, stored); } catch { return false; }
  }
  const [salt, key] = stored.split(':');
  if (!salt || !key) return false;
  const hashed = scryptSync(plain, salt, 64);
  const keyBuf = Buffer.from(key, 'hex');
  return keyBuf.length === hashed.length && timingSafeEqual(keyBuf, hashed);
}

// POST /users/login — email + parol bilan kirish (parol hash orqali tekshiriladi).
router.post('/login', async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body ?? {};
    if (!email || !password) {
      return res.status(400).json({ success: false, error: 'email va password majburiy.' });
    }

    const { data: user, error } = await supabase
      .from('users')
      .select('id, name, email, phone, role, first_name, last_name, password_hash, company_id')
      .eq('email', String(email).trim().toLowerCase())
      .maybeSingle();

    if (error) {
      return res.status(500).json({ success: false, error: `Database Error: ${error.message}` });
    }
    if (!user || !verifyPassword(String(password), user.password_hash)) {
      return res.status(401).json({ success: false, error: 'Email yoki parol noto\'g\'ri.' });
    }

    markOnline(user.id); // login = onlayn
    const { password_hash, ...safe } = user; // hash'ni javobdan chiqarib tashlaymiz
    void password_hash;
    // Kompaniyaga bog'liq endpoint'lar (/company/me, /dashboard/stats,
    // /company/logo) shu tokenni Authorization: Bearer sifatida kutadi.
    const token = signSessionToken({ sub: user.id, company_id: user.company_id ?? null, role: user.role });
    return res.status(200).json({ success: true, data: { ...safe, token } });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Login failed.';
    return res.status(500).json({ success: false, error: message });
  }
});

// ============================================================================
// XAVFSIZLIK (2026-10-15)
//
// NIMA EDI: /users ostidagi HAMMA endpoint (login'dan tashqari) tokensiz
// ochiq edi va kompaniya bo'yicha filtrlanmasdi: istalgan odam barcha
// kompaniyalar xodimlarini ko'rishi, yangi foydalanuvchi yaratishi va —
// eng xavflisi — PUT /users/:id/credentials bilan ISTALGAN hisobning
// parolini almashtirib, uni egallab olishi mumkin edi. "Xodimlarni
// boshqarish" sahifasida boshqa kompaniyalarning xodimlari ko'rinardi.
//
// ENDI: login'dan keyingi hamma narsa requireAuth (sessiya JWT) talab
// qiladi; kompaniya va rol TOKENDAN olinadi, mijoz yuborgan company_id'ga
// ishonilmaydi. Boshqa kompaniyaning foydalanuvchisi 404 bilan javob oladi
// (mavjudligi ham oshkor qilinmaydi).
//   - direktor/admin: o'z kompaniyasidagi foydalanuvchilarni boshqaradi;
//   - xodim (user): faqat O'ZINI o'qiydi (profil, smena, skriptlar) va
//     o'z onlayn holatini yuboradi (operator kabineti — EmployeeDashboard).
// ============================================================================
router.use(requireAuth);

const ADMIN_ROLES = ['director', 'admin'];
// Kim qaysi rolni bera oladi: direktor — hammasini, admin — direktordan tashqari.
const ASSIGNABLE_ROLES: Record<string, string[]> = {
  director: ['user', 'admin', 'director'],
  admin: ['user', 'admin'],
};

function isAdmin(req: CompanyAuthedRequest): boolean {
  return ADMIN_ROLES.includes(req.auth!.role);
}

type Access = 'self-or-admin' | 'admin';

/** Maqsad foydalanuvchi so'rovchining kompaniyasida ekanini va ruxsatni
 *  tekshiradi. Ruxsat bo'lmasa javobni o'zi yuboradi va false qaytaradi. */
async function canAccessUser(req: CompanyAuthedRequest, res: Response, id: string, access: Access): Promise<boolean> {
  const self = req.auth!.userId === id;
  if (access === 'self-or-admin' && self) return true;
  if (!isAdmin(req)) {
    res.status(403).json({ success: false, error: "Bu amal uchun ruxsat yo'q." });
    return false;
  }
  const { data, error } = await supabase.from('users').select('company_id').eq('id', id).maybeSingle();
  if (error) {
    res.status(500).json({ success: false, error: `Database Error: ${error.message}` });
    return false;
  }
  if (!data || data.company_id !== req.auth!.companyId) {
    res.status(404).json({ success: false, error: 'User topilmadi.' });
    return false;
  }
  return true;
}

router.get('/', async (req: CompanyAuthedRequest, res: Response) => {
  if (!isAdmin(req)) return res.status(403).json({ success: false, error: "Bu amal uchun ruxsat yo'q." });
  try {
    // Ixtiyoriy filtrlar:
    //   ?role=user   → faqat xodimlar (direktor/admin ko'rinmaydi)
    //   ?role=admin  → faqat direktorlar
    //   ?exclude_role=admin → adminlardan boshqasi
    const role = typeof req.query.role === 'string' ? req.query.role.trim() : '';
    const excludeRole = typeof req.query.exclude_role === 'string' ? req.query.exclude_role.trim() : '';

    let q = supabase
      .from('users')
      .select(PUBLIC_COLS)
      .eq('company_id', req.auth!.companyId) // FAQAT o'z kompaniyasi (tokendan)
      .order('created_at', { ascending: false });
    if (role) q = q.eq('role', role);
    if (excludeRole) q = q.neq('role', excludeRole);

    const { data: users, error } = await q;

    if (error) {
      console.error('Error fetching users from Supabase:', error.message);
      return res.status(500).json({
        success: false,
        error: `Database Error: ${error.message}`,
      });
    }

    return res.status(200).json({
      success: true,
      data: users,
    });
  } catch (error: unknown) {
    console.error('GET /users error:', error);
    const message = error instanceof Error ? error.message : 'Failed to retrieve users.';
    return res.status(500).json({
      success: false,
      error: message,
    });
  }
});

// Onlayn foydalanuvchilar ro'yxati. MUHIM: '/:id' dan OLDIN turishi kerak,
// aks holda Express buni id='presence' deb qabul qiladi.
router.get('/presence', async (req: CompanyAuthedRequest, res: Response) => {
  if (!isAdmin(req)) return res.status(403).json({ success: false, error: "Bu amal uchun ruxsat yo'q." });
  const ids = onlineIds();
  if (!ids.length) return res.status(200).json({ success: true, data: [] });
  // Faqat o'z kompaniyasidagi onlayn foydalanuvchilar.
  const { data, error } = await supabase.from('users').select('id').in('id', ids).eq('company_id', req.auth!.companyId);
  if (error) return res.status(500).json({ success: false, error: `Database Error: ${error.message}` });
  return res.status(200).json({ success: true, data: (data || []).map((u: any) => u.id) });
});

// Heartbeat — xodim sahifasi davriy yuboradi (onlayn ekanini bildiradi).
router.post('/:id/ping', async (req: CompanyAuthedRequest, res: Response) => {
  if (!(await canAccessUser(req, res, String(req.params.id), 'self-or-admin'))) return;
  markOnline(String(req.params.id));
  return res.status(200).json({ success: true });
});

// Logout / chiqish — darhol offline qilamiz.
router.post('/:id/offline', async (req: CompanyAuthedRequest, res: Response) => {
  if (!(await canAccessUser(req, res, String(req.params.id), 'self-or-admin'))) return;
  markOffline(String(req.params.id));
  return res.status(200).json({ success: true });
});

router.post('/', async (req: CompanyAuthedRequest, res: Response) => {
  if (!isAdmin(req)) return res.status(403).json({ success: false, error: "Bu amal uchun ruxsat yo'q." });
  try {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('application/json')) {
      return res.status(415).json({
        success: false,
        error: 'Content-Type must be application/json',
      });
    }

    const { name, email, age, phone, role, password, operator_ext } = req.body;

    if (!name || !email) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: "name" and "email" are required.',
      });
    }

    const newRole = String(role || 'user');
    if (!(ASSIGNABLE_ROLES[req.auth!.role] || []).includes(newRole)) {
      return res.status(403).json({ success: false, error: `"${newRole}" rolini berishga ruxsat yo'q.` });
    }
    const insertData: Record<string, unknown> = {
      name,
      email: String(email).trim().toLowerCase(),
      age: age !== undefined && age !== null ? parseInt(age as string, 10) : null,
      phone: phone || null,
      role: newRole,
      // Kompaniya FAQAT tokendan — mijoz yuborgan company_id e'tiborga olinmaydi.
      company_id: req.auth!.companyId,
    };
    if (operator_ext !== undefined) {
      const ext = parseOperatorExt(operator_ext);
      if (!ext.ok) return res.status(400).json({ success: false, error: "Ichki raqam faqat raqamlardan iborat bo'lsin (masalan 105)." });
      insertData.operator_ext = ext.value;
    }
    // password_hash ustuniga faqat parol berilganda tegamiz — shunda migration
    // ishga tushmagan bo'lsa ham parolsiz qo'shish ishlayveradi.
    if (password) {
      insertData.password_hash = hashPassword(String(password)); // bcrypt — ochiq saqlanmaydi
    }

    const { data: newUser, error } = await supabase
      .from('users')
      .insert(insertData)
      .select(PUBLIC_COLS)
      .single();

    if (error) {
      console.error('Error creating user in Supabase:', error.message);

      if (error.code === '23505') {
        const byExt = /operator_ext/.test(`${error.message} ${(error as any).details ?? ''}`);
        return res.status(409).json({
          success: false,
          error: byExt ? 'Bu ichki raqamga boshqa akkaunt bog\'langan.' : 'A user with this email address already exists.',
        });
      }

      return res.status(500).json({
        success: false,
        error: `Database Error: ${error.message}`,
      });
    }

    invalidateOperatorNames(req.auth!.companyId); // yangi ism hamma panelda darhol
    // Direktor sozlamalarda parolni ko'rishi uchun shifrlangan nusxa (lib/passwordVault.ts).
    if (password && (newUser as any)?.id) await rememberPassword((newUser as any).id, String(password));
    return res.status(201).json({
      success: true,
      data: newUser,
    });
  } catch (error: unknown) {
    console.error('POST /users error:', error);
    const message = error instanceof Error ? error.message : 'Failed to create user.';
    return res.status(500).json({
      success: false,
      error: message,
    });
  }
});

router.get('/:id', async (req: CompanyAuthedRequest, res: Response) => {
  try {
    const { id } = req.params;
    if (!(await canAccessUser(req, res, String(id), 'self-or-admin'))) return;

    // '*' — yangi ustunlar (first_name, last_name, credentials_changed_at) ham
    // qaytadi; migration ishlamagan bo'lsa mavjudlari keladi. password_hash kodda olib tashlanadi.
    const { data: user, error } = await supabase
      .from('users')
      .select('*')
      .eq('id', id)
      .maybeSingle();

    if (error) {
      console.error(`Error fetching user ${id}:`, error.message);
      return res.status(500).json({
        success: false,
        error: `Database Error: ${error.message}`,
      });
    }

    if (!user) {
      return res.status(404).json({
        success: false,
        error: `User with ID ${id} not found.`,
      });
    }

    const { password_hash, password_plain, ...safeUser } = user as Record<string, unknown>;
    void password_hash;
    void password_plain;
    return res.status(200).json({
      success: true,
      data: safeUser,
    });
  } catch (error: unknown) {
    console.error('GET /users/:id error:', error);
    const message = error instanceof Error ? error.message : 'Failed to retrieve user.';
    return res.status(500).json({
      success: false,
      error: message,
    });
  }
});

router.put('/:id', async (req: CompanyAuthedRequest, res: Response) => {
  try {
    const { id } = req.params;
    if (!(await canAccessUser(req, res, String(id), 'admin'))) return;

    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('application/json')) {
      return res.status(415).json({
        success: false,
        error: 'Content-Type must be application/json',
      });
    }

    const { name, email, age, phone, role, password, first_name, last_name, operator_ext } = req.body;

    const { data: existingUser, error: checkError } = await supabase
      .from('users')
      .select('id')
      .eq('id', id)
      .maybeSingle();

    if (checkError) {
      return res.status(500).json({
        success: false,
        error: `Database Error: ${checkError.message}`,
      });
    }

    if (!existingUser) {
      return res.status(404).json({
        success: false,
        error: `User with ID ${id} not found.`,
      });
    }

    const updateData: Record<string, unknown> = {};
    if (name !== undefined) updateData.name = name;
    if (email !== undefined) updateData.email = email;
    if (age !== undefined) updateData.age = age !== null ? parseInt(age as string, 10) : null;
    if (phone !== undefined) updateData.phone = phone || null;
    if (role !== undefined) {
      if (!(ASSIGNABLE_ROLES[req.auth!.role] || []).includes(String(role))) {
        return res.status(403).json({ success: false, error: `"${role}" rolini berishga ruxsat yo'q.` });
      }
      updateData.role = role;
    }
    if (first_name !== undefined) updateData.first_name = first_name;
    if (operator_ext !== undefined) {
      const ext = parseOperatorExt(operator_ext);
      if (!ext.ok) return res.status(400).json({ success: false, error: "Ichki raqam faqat raqamlardan iborat bo'lsin (masalan 105)." });
      updateData.operator_ext = ext.value;
    }
    if (last_name !== undefined) updateData.last_name = last_name;
    if (password) {
      updateData.password_hash = hashPassword(String(password)); // bcrypt — ochiq saqlanmaydi
    }
    // Email yoki parol o'zgarsa → kick-out belgisi (frontend login sahifasiga chiqaradi).
    if (email !== undefined || password) updateData.credentials_changed_at = new Date().toISOString();

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No fields provided for update.',
      });
    }

    const { data: updatedUser, error: updateError } = await supabase
      .from('users')
      .update(updateData)
      .eq('id', id)
      .select(PUBLIC_COLS)
      .single();

    if (updateError) {
      console.error(`Error updating user ${id}:`, updateError.message);

      if (updateError.code === '23505') {
        const byExt = /operator_ext/.test(`${updateError.message} ${(updateError as any).details ?? ''}`);
        return res.status(409).json({
          success: false,
          error: byExt ? 'Bu ichki raqamga boshqa akkaunt bog\'langan.' : 'A user with this email address already exists.',
        });
      }

      return res.status(500).json({
        success: false,
        error: `Database Error: ${updateError.message}`,
      });
    }

    invalidateOperatorNames(req.auth!.companyId); // ism/raqam o'zgardi — hamma panelda darhol
    if (password) await rememberPassword(String(id), String(password));
    return res.status(200).json({
      success: true,
      data: updatedUser,
    });
  } catch (error: unknown) {
    console.error('PUT /users/:id error:', error);
    const message = error instanceof Error ? error.message : 'Failed to update user.';
    return res.status(500).json({
      success: false,
      error: message,
    });
  }
});

router.delete('/:id', async (req: CompanyAuthedRequest, res: Response) => {
  try {
    const { id } = req.params;
    if (req.auth!.userId === id) {
      return res.status(400).json({ success: false, error: "O'z hisobingizni o'chira olmaysiz." });
    }
    if (!(await canAccessUser(req, res, String(id), 'admin'))) return;

    const { data: existingUser, error: checkError } = await supabase
      .from('users')
      .select('id')
      .eq('id', id)
      .maybeSingle();

    if (checkError) {
      return res.status(500).json({
        success: false,
        error: `Database Error: ${checkError.message}`,
      });
    }

    if (!existingUser) {
      return res.status(404).json({
        success: false,
        error: `User with ID ${id} not found.`,
      });
    }

    const { error: deleteError } = await supabase
      .from('users')
      .delete()
      .eq('id', id);

    if (deleteError) {
      console.error(`Error deleting user ${id}:`, deleteError.message);
      return res.status(500).json({
        success: false,
        error: `Database Error: ${deleteError.message}`,
      });
    }

    invalidateOperatorNames(req.auth!.companyId);
    return res.status(200).json({
      success: true,
      message: `User with ID ${id} was deleted successfully.`,
    });
  } catch (error: unknown) {
    console.error('DELETE /users/:id error:', error);
    const message = error instanceof Error ? error.message : 'Failed to delete user.';
    return res.status(500).json({
      success: false,
      error: message,
    });
  }
});

// ============================================================
// Staff Manager — credentials / shift / scripts
// ============================================================

// GET /users/:id/credentials — login bcrypt-hash bilan; parol esa faqat o'z
// kompaniyasi direktori/adminiga, shifrlangan nusxadan (lib/passwordVault.ts).
router.get('/:id/credentials', async (req: CompanyAuthedRequest, res: Response) => {
  const { id } = req.params;
  if (!(await canAccessUser(req, res, String(id), 'admin'))) return;
  const { data, error } = await supabase.from('users').select('id, email').eq('id', id).maybeSingle();
  if (error) return res.status(500).json({ success: false, error: `Database Error: ${error.message}` });
  if (!data) return res.status(404).json({ success: false, error: 'User topilmadi.' });
  // Parol (2026-10-16): direktor/admin uchun shifrlangan nusxadan; yo'q bo'lsa null.
  return res.status(200).json({ success: true, data: { email: data.email, password: await revealPassword(String(id)) } });
});

// PUT /users/:id/credentials — parol (va ixtiyoriy email) → credentials_changed_at = now()
router.put('/:id/credentials', async (req: CompanyAuthedRequest, res: Response) => {
  try {
    const { id } = req.params;
    if (!(await canAccessUser(req, res, String(id), 'admin'))) return;
    const { password, email } = req.body ?? {};
    if (password === undefined && email === undefined) {
      return res.status(400).json({ success: false, error: 'password yoki email berilishi kerak.' });
    }
    const update: Record<string, unknown> = { credentials_changed_at: new Date().toISOString() };
    if (email !== undefined) update.email = String(email).trim().toLowerCase();
    if (password !== undefined) {
      if (typeof password !== 'string' || password.length < 6) {
        return res.status(400).json({ success: false, error: 'Parol kamida 6 ta belgidan iborat bo\'lishi kerak.' });
      }
      update.password_hash = hashPassword(password); // bcrypt — ochiq saqlanmaydi
    }
    const { data, error } = await supabase
      .from('users').update(update).eq('id', id)
      .select('id, email, credentials_changed_at').maybeSingle();
    if (error) {
      if (error.code === '23505') return res.status(409).json({ success: false, error: 'Bu email band.' });
      return res.status(500).json({ success: false, error: `Database Error: ${error.message}` });
    }
    if (!data) return res.status(404).json({ success: false, error: 'User topilmadi.' });
    if (typeof password === 'string') await rememberPassword(String(id), password);
    return res.status(200).json({ success: true, data, sessions_revoked: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Credentials yangilashda xatolik.';
    return res.status(500).json({ success: false, error: message });
  }
});

// GET /users/:id/shift
router.get('/:id/shift', async (req: CompanyAuthedRequest, res: Response) => {
  const { id } = req.params;
  if (!(await canAccessUser(req, res, String(id), 'self-or-admin'))) return;
  const { data, error } = await supabase.from('users').select('shift_start, shift_end').eq('id', id).maybeSingle();
  if (error) return res.status(500).json({ success: false, error: `Database Error: ${error.message}` });
  if (!data) return res.status(404).json({ success: false, error: 'User topilmadi.' });
  return res.status(200).json({ success: true, data: { start: data.shift_start, end: data.shift_end } });
});

// PUT /users/:id/shift  { start, end }
router.put('/:id/shift', async (req: CompanyAuthedRequest, res: Response) => {
  const { id } = req.params;
  if (!(await canAccessUser(req, res, String(id), 'admin'))) return;
  const { start, end } = req.body ?? {};
  const { data, error } = await supabase
    .from('users').update({ shift_start: start ?? null, shift_end: end ?? null }).eq('id', id)
    .select('shift_start, shift_end').maybeSingle();
  if (error) return res.status(500).json({ success: false, error: `Database Error: ${error.message}` });
  if (!data) return res.status(404).json({ success: false, error: 'User topilmadi.' });
  return res.status(200).json({ success: true, data: { start: data.shift_start, end: data.shift_end } });
});

// GET /users/:id/scripts
router.get('/:id/scripts', async (req: CompanyAuthedRequest, res: Response) => {
  const { id } = req.params;
  if (!(await canAccessUser(req, res, String(id), 'self-or-admin'))) return;
  const { data, error } = await supabase
    .from('user_scripts').select('id, title, enabled').eq('user_id', id).order('created_at', { ascending: true });
  if (error) return res.status(500).json({ success: false, error: `Database Error: ${error.message}` });
  return res.status(200).json({ success: true, data });
});

// PUT /users/:id/scripts  { scripts: [{ id?, title, enabled }] } — to'liq almashtirish (replace)
router.put('/:id/scripts', async (req: CompanyAuthedRequest, res: Response) => {
  try {
    const { id } = req.params;
    if (!(await canAccessUser(req, res, String(id), 'admin'))) return;
    const list = Array.isArray(req.body?.scripts) ? req.body.scripts : null;
    if (!list) return res.status(400).json({ success: false, error: 'scripts massiv bo\'lishi kerak.' });

    // Foydalanuvchining eski skriptlarini o'chirib, yangilarini yozamiz.
    const { error: delErr } = await supabase.from('user_scripts').delete().eq('user_id', id);
    if (delErr) return res.status(500).json({ success: false, error: `Database Error: ${delErr.message}` });

    const rows = list
      .filter((s: any) => s && typeof s.title === 'string' && s.title.trim())
      .map((s: any) => ({ user_id: id, title: String(s.title).trim(), enabled: s.enabled === undefined ? true : !!s.enabled }));

    let inserted: any[] = [];
    if (rows.length) {
      const { data, error } = await supabase.from('user_scripts').insert(rows).select('id, title, enabled');
      if (error) return res.status(500).json({ success: false, error: `Database Error: ${error.message}` });
      inserted = data || [];
    }
    // Bell uchun bildirishnoma (best-effort).
    await supabase.from('user_notifications').insert({ user_id: id, message: 'Skriptlaringiz yangilandi.' }).then(undefined, () => {});
    return res.status(200).json({ success: true, data: inserted });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Skriptlarni saqlashda xatolik.';
    return res.status(500).json({ success: false, error: message });
  }
});

export default router;
