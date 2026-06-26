import { Router, Request, Response } from 'express';
import { scryptSync, timingSafeEqual } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { supabase } from '../lib/supabase';
import { markOnline, markOffline, onlineIds } from '../lib/presence';

const router = Router();

// Faqat ochiq (xavfsiz) ustunlar — password_hash hech qachon qaytarilmaydi.
// Eslatma: bu ro'yxat uchun — migration ishlamagan bo'lsa ham buzilmasin (faqat
// doim mavjud ustunlar). GET /:id esa '*' ni oladi (yangi ustunlarni ham beradi).
const PUBLIC_COLS = 'id, name, email, age, phone, role, created_at';

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
      .select('id, name, email, phone, role, first_name, last_name, password_hash')
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
    return res.status(200).json({ success: true, data: safe });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Login failed.';
    return res.status(500).json({ success: false, error: message });
  }
});

router.get('/', async (req: Request, res: Response) => {
  try {
    const { data: users, error } = await supabase
      .from('users')
      .select(PUBLIC_COLS)
      .order('created_at', { ascending: false });

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
router.get('/presence', (_req: Request, res: Response) => {
  return res.status(200).json({ success: true, data: onlineIds() });
});

// Heartbeat — xodim sahifasi davriy yuboradi (onlayn ekanini bildiradi).
router.post('/:id/ping', (req: Request, res: Response) => {
  markOnline(String(req.params.id));
  return res.status(200).json({ success: true });
});

// Logout / chiqish — darhol offline qilamiz.
router.post('/:id/offline', (req: Request, res: Response) => {
  markOffline(String(req.params.id));
  return res.status(200).json({ success: true });
});

router.post('/', async (req: Request, res: Response) => {
  try {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('application/json')) {
      return res.status(415).json({
        success: false,
        error: 'Content-Type must be application/json',
      });
    }

    const { name, email, age, phone, role, password } = req.body;

    if (!name || !email) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: "name" and "email" are required.',
      });
    }

    const insertData: Record<string, unknown> = {
      name,
      email: String(email).trim().toLowerCase(),
      age: age !== undefined && age !== null ? parseInt(age as string, 10) : null,
      phone: phone || null,
      role: role || 'user',
    };
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
        return res.status(409).json({
          success: false,
          error: 'A user with this email address already exists.',
        });
      }

      return res.status(500).json({
        success: false,
        error: `Database Error: ${error.message}`,
      });
    }

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

router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

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

router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const contentType = req.headers['content-type'] || '';
    if (!contentType.includes('application/json')) {
      return res.status(415).json({
        success: false,
        error: 'Content-Type must be application/json',
      });
    }

    const { name, email, age, phone, role, password, first_name, last_name } = req.body;

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
    if (role !== undefined) updateData.role = role;
    if (first_name !== undefined) updateData.first_name = first_name;
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
        return res.status(409).json({
          success: false,
          error: 'A user with this email address already exists.',
        });
      }

      return res.status(500).json({
        success: false,
        error: `Database Error: ${updateError.message}`,
      });
    }

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

router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

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

// GET /users/:id/credentials — XAVFSIZ: parol bcrypt-hash, ochiq saqlanmaydi va
// qaytarilmaydi (password: null). Admin/direktor faqat YANGI parol o'rnatadi.
router.get('/:id/credentials', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { data, error } = await supabase.from('users').select('id, email').eq('id', id).maybeSingle();
  if (error) return res.status(500).json({ success: false, error: `Database Error: ${error.message}` });
  if (!data) return res.status(404).json({ success: false, error: 'User topilmadi.' });
  return res.status(200).json({ success: true, data: { email: data.email, password: null } });
});

// PUT /users/:id/credentials — parol (va ixtiyoriy email) → credentials_changed_at = now()
router.put('/:id/credentials', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
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
    return res.status(200).json({ success: true, data, sessions_revoked: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Credentials yangilashda xatolik.';
    return res.status(500).json({ success: false, error: message });
  }
});

// GET /users/:id/shift
router.get('/:id/shift', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { data, error } = await supabase.from('users').select('shift_start, shift_end').eq('id', id).maybeSingle();
  if (error) return res.status(500).json({ success: false, error: `Database Error: ${error.message}` });
  if (!data) return res.status(404).json({ success: false, error: 'User topilmadi.' });
  return res.status(200).json({ success: true, data: { start: data.shift_start, end: data.shift_end } });
});

// PUT /users/:id/shift  { start, end }
router.put('/:id/shift', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { start, end } = req.body ?? {};
  const { data, error } = await supabase
    .from('users').update({ shift_start: start ?? null, shift_end: end ?? null }).eq('id', id)
    .select('shift_start, shift_end').maybeSingle();
  if (error) return res.status(500).json({ success: false, error: `Database Error: ${error.message}` });
  if (!data) return res.status(404).json({ success: false, error: 'User topilmadi.' });
  return res.status(200).json({ success: true, data: { start: data.shift_start, end: data.shift_end } });
});

// GET /users/:id/scripts
router.get('/:id/scripts', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { data, error } = await supabase
    .from('user_scripts').select('id, title, enabled').eq('user_id', id).order('created_at', { ascending: true });
  if (error) return res.status(500).json({ success: false, error: `Database Error: ${error.message}` });
  return res.status(200).json({ success: true, data });
});

// PUT /users/:id/scripts  { scripts: [{ id?, title, enabled }] } — to'liq almashtirish (replace)
router.put('/:id/scripts', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
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
