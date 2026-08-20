import { Telegraf } from 'telegraf';
import type { SessionContext } from './dbSession';

// Alohida fayl (faqat instance, handler'siz) — bot1.ts (handler'larni
// ro'yxatdan o'tkazadi) va notifyUser.ts (bot2.ts'dan xabar yuborish uchun)
// ikkalasi ham shu bittasini ishlatadi, aylanma import (circular) bo'lmasin deb.
const token = process.env.TELEGRAM_BOT1_TOKEN || process.env.TOKEN_BOT;
if (!token) {
  console.warn('TELEGRAM_BOT1_TOKEN (yoki TOKEN_BOT) sozlanmagan — Bot 1 ishlamaydi.');
}

export const bot1 = new Telegraf<SessionContext>(token || 'MISSING_TOKEN');
