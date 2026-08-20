import crypto from 'node:crypto';

// Har-kompaniya webhook'ining secret_token'ini "hech qachon ochiq matnda
// saqlanmasin" talabini bajaradi. Supabase Vault o'rniga ilova darajasidagi
// AES-256-GCM — sabab supabase/company_sections_webhooks.sql'dagi izohda.

const ALGO = 'aes-256-gcm';

function getKey(): Buffer {
  const raw = process.env.WEBHOOK_SECRET_ENC_KEY;
  if (!raw) {
    throw new Error('WEBHOOK_SECRET_ENC_KEY .env da sozlanmagan.');
  }
  // 64 ta hex belgi = 32 bayt (AES-256 kaliti).
  const key = Buffer.from(raw, 'hex');
  if (key.length !== 32) {
    throw new Error('WEBHOOK_SECRET_ENC_KEY 32 baytlik (64 hex belgi) bo\'lishi kerak.');
  }
  return key;
}

/** Tasodifiy, foydalanuvchiga ko'rsatiladigan webhook sekretini yaratadi (bir marta qaytariladi). */
export function generateWebhookSecret(): string {
  return crypto.randomBytes(24).toString('base64url'); // ~32 belgili, URL-xavfsiz
}

export function encryptSecret(plain: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // iv.authTag.ciphertext — hammasi base64, bitta ustunga sig'ishi uchun.
  return `${iv.toString('base64')}.${authTag.toString('base64')}.${encrypted.toString('base64')}`;
}

export function decryptSecret(stored: string): string {
  const key = getKey();
  const [ivB64, tagB64, dataB64] = stored.split('.');
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error('Shifrlangan secret formati noto\'g\'ri.');
  }
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]);
  return decrypted.toString('utf8');
}

/** Faqat oxirgi 4 belgi — javoblarda/logda to'liq sekret hech qachon chiqmasin. */
export function maskSecret(plain: string): string {
  if (plain.length <= 4) return '*'.repeat(plain.length);
  return `${'*'.repeat(Math.min(8, plain.length - 4))}${plain.slice(-4)}`;
}
