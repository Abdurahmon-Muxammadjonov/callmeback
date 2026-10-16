// ============================================================================
// XODIM PAROLINI DIREKTORGA KO'RSATISH (2026-10-16)
//
// Foydalanuvchi talabi: "Xodimlarni boshqarish"da xodimga yozilgan parol
// sozlamalar qayta ochilganda o'chib ketmasin — o'sha parol ko'rinib tursin.
//
// Login AVVALGIDEK faqat bcrypt xesh (users.password_hash) bilan tekshiriladi.
// Qo'shimcha ravishda parolning SHIFRLANGAN nusxasi (users.password_enc,
// AES-256-GCM) saqlanadi — uni faqat o'sha kompaniyaning direktori/admini
// GET /users/:id/credentials orqali ko'radi. Ochiq matn bazada yo'q.
//
// Kalit: WEBHOOK_SECRET_ENC_KEY dan HKDF bilan hosil qilingan ALOHIDA kalit
// (webhook sekretlari bilan bir xil kalit ishlatilmasin). Ustun yoki kalit
// bo'lmasa — hammasi jim o'tkaziladi: parol saqlanadi va login ishlaydi,
// faqat sozlamalarda ko'rinmaydi (supabase/staff_02_user_password_enc.sql).
// ============================================================================

import crypto from 'node:crypto';
import { supabase } from './supabase';

const ALGO = 'aes-256-gcm';

function key(): Buffer | null {
  const raw = process.env.WEBHOOK_SECRET_ENC_KEY;
  if (!raw) return null;
  const master = Buffer.from(raw, 'hex');
  if (master.length !== 32) return null;
  return Buffer.from(crypto.hkdfSync('sha256', master, Buffer.alloc(0), 'procell:user-password:v1', 32));
}

export function encryptPassword(plain: string): string | null {
  const k = key();
  if (!k) return null;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv(ALGO, k, iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${data.toString('base64')}`;
}

export function decryptPassword(stored: string | null | undefined): string | null {
  const k = key();
  if (!k || !stored) return null;
  try {
    const [iv, tag, data] = stored.split('.');
    const d = crypto.createDecipheriv(ALGO, k, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
  } catch {
    return null; // kalit almashgan yoki ma'lumot buzilgan — ko'rsatilmaydi
  }
}

/** Parol o'rnatilgan/almashtirilgandan keyin shifrlangan nusxani yozadi.
 *  Eng yaxshi harakat: ustun hali yo'q bo'lsa ham saqlash buzilmaydi. */
export async function rememberPassword(userId: string, plain: string): Promise<void> {
  const enc = encryptPassword(plain);
  if (!enc) return;
  const { error } = await supabase.from('users').update({ password_enc: enc }).eq('id', userId);
  if (error && !/password_enc/.test(error.message)) {
    console.warn(`password_enc yozilmadi (user=${userId}):`, error.message);
  }
}

/** Direktorga ko'rsatish uchun; ustun/kalit bo'lmasa null. */
export async function revealPassword(userId: string): Promise<string | null> {
  const { data, error } = await supabase.from('users').select('password_enc').eq('id', userId).maybeSingle();
  if (error) return null;
  return decryptPassword((data as any)?.password_enc ?? null);
}
