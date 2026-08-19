import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { supabase } from '../lib/supabase';

// Kompaniya asosidagi ro'yxatdan o'tish (PROMPT_BACKEND_COMPANY_AUTH.md
// spetsifikatsiyasiga to'liq mos). Mavjud `users`/`companies` jadvallarini
// ishlatadi, POST /users/login kutayotgan bcrypt sxemasi bilan bir xil
// (users.ts'dagi hashPassword() bilan aynan bir xil parametr — 10 rounds).

const router = Router();

function hashPassword(plain: string): string {
  return bcrypt.hashSync(plain, 10);
}

function isValidEmail(v: unknown): v is string {
  return typeof v === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

function isDuplicateEmailError(message: string | undefined): boolean {
  return /duplicate|unique/i.test(message || '');
}

// ============================================================================
// POST /auth/register-company — yangi kompaniya + owner (role='director')
// ============================================================================
router.post('/register-company', async (req: Request, res: Response) => {
  try {
    const { company_name, owner_name, email, password } = req.body ?? {};

    if (typeof company_name !== 'string' || !company_name.trim()
      || typeof owner_name !== 'string' || !owner_name.trim()
      || !isValidEmail(email) || typeof password !== 'string' || password.length < 6) {
      return res.status(400).json({
        success: false,
        error: 'company_name, owner_name, email, password (kamida 6 belgi) majburiy.',
      });
    }

    const normalizedEmail = email.trim().toLowerCase();

    // Email allaqachon bandligini oldindan tekshiramiz — company yaratib,
    // keyin foydalanuvchi qadamida qulab, keraksiz rollback qilmaslik uchun.
    const { data: existing } = await supabase.from('users').select('id').eq('email', normalizedEmail).maybeSingle();
    if (existing) {
      return res.status(409).json({ success: false, error: "Bu email bilan hisob allaqachon mavjud." });
    }

    // 1) Kompaniya — invite_code DEFAULT public.generate_invite_code() orqali avtomatik.
    const { data: company, error: companyErr } = await supabase
      .from('companies')
      .insert({ name: company_name.trim() })
      .select('id, invite_code')
      .single();

    if (companyErr || !company) {
      return res.status(500).json({ success: false, error: `Kompaniya yaratib bo'lmadi: ${companyErr?.message || 'unknown'}` });
    }

    // 2) Owner — role='director' (frontend director/admin'ni "to'liq panel" deb talqin qiladi).
    const { data: user, error: userErr } = await supabase
      .from('users')
      .insert({
        name: owner_name.trim(),
        email: normalizedEmail,
        password_hash: hashPassword(password),
        role: 'director',
        company_id: company.id,
      })
      .select('id, name, email, role')
      .single();

    if (userErr || !user) {
      // Kompensatsiya: users yaratib bo'lmadi — yarim yaratilgan (egasiz) kompaniya qolmasin.
      await supabase.from('companies').delete().eq('id', company.id);
      const dup = isDuplicateEmailError(userErr?.message);
      return res.status(dup ? 409 : 500).json({
        success: false,
        error: dup ? "Bu email bilan hisob allaqachon mavjud." : `Foydalanuvchi yaratib bo'lmadi: ${userErr?.message}`,
      });
    }

    return res.status(201).json({
      success: true,
      data: { user, invite_code: company.invite_code },
    });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'register-company xatosi.' });
  }
});

// ============================================================================
// POST /auth/register — xodim mavjud kompaniyaga company_code bilan qo'shiladi
// ============================================================================
router.post('/register', async (req: Request, res: Response) => {
  try {
    const { name, email, password, company_code } = req.body ?? {};

    if (typeof name !== 'string' || !name.trim()
      || !isValidEmail(email) || typeof password !== 'string' || password.length < 6
      || typeof company_code !== 'string' || !company_code.trim()) {
      return res.status(400).json({
        success: false,
        error: 'name, email, password (kamida 6 belgi), company_code majburiy.',
      });
    }

    const { data: company, error: companyErr } = await supabase
      .from('companies')
      .select('id')
      .eq('invite_code', company_code.trim().toUpperCase())
      .maybeSingle();

    if (companyErr) {
      return res.status(500).json({ success: false, error: `Database Error: ${companyErr.message}` });
    }
    if (!company) {
      // Xabarda "kod" so'zi ataylab bor — frontend (register.ts) shuni qidirib,
      // do'stona xabarga aylantiradi.
      return res.status(404).json({ success: false, error: "Bu kompaniya kodi topilmadi." });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const { data: existing } = await supabase.from('users').select('id').eq('email', normalizedEmail).maybeSingle();
    if (existing) {
      return res.status(409).json({ success: false, error: "Bu email bilan hisob allaqachon mavjud." });
    }

    const { data: user, error: userErr } = await supabase
      .from('users')
      .insert({
        name: name.trim(),
        email: normalizedEmail,
        password_hash: hashPassword(password),
        role: 'user',
        company_id: company.id,
      })
      .select('id, name, email, role')
      .single();

    if (userErr || !user) {
      const dup = isDuplicateEmailError(userErr?.message);
      return res.status(dup ? 409 : 500).json({
        success: false,
        error: dup ? "Bu email bilan hisob allaqachon mavjud." : `Foydalanuvchi yaratib bo'lmadi: ${userErr?.message}`,
      });
    }

    return res.status(201).json({ success: true, data: user });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'register xatosi.' });
  }
});

export default router;
