import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';

// SalesPulse admin tomonidan beriladigan, bir martalik bo'lim ochish kodi.
// Bazada FAQAT hash saqlanadi (section_unlock_codes.code) — xuddi
// users.password_hash kabi bcrypt bilan.

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 0/O/1/I yo'q — qo'lda kiritiladi

/** Foydalanuvchiga ko'rsatiladigan format: "XXXX-XXXX" (8 belgi + chiziqcha). */
export function generateUnlockCode(): string {
  const part = (n: number) =>
    Array.from({ length: n }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join('');
  return `${part(4)}-${part(4)}`;
}

export function hashUnlockCode(code: string): string {
  return bcrypt.hashSync(code.trim().toUpperCase(), 10);
}

export function verifyUnlockCode(code: string, hash: string): boolean {
  try {
    return bcrypt.compareSync(code.trim().toUpperCase(), hash);
  } catch {
    return false;
  }
}
