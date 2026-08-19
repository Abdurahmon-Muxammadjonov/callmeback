import type { Request } from 'express';
import { supabaseAdmin } from './supabaseAdmin';

/**
 * Haqiqiy klient IP'ini oladi. Railway/har qanday reverse-proxy orqasida
 * `req.socket.remoteAddress` proxy'ning o'z IP'ini qaytaradi — shu sabab
 * avval `X-Forwarded-For`ga qaraymiz (proxy shu headerga haqiqiy klient
 * IP'ini qo'shib beradi, birinchi qiymat — asl klient).
 *
 * DIQQAT: X-Forwarded-For klient tomonidan SOXTALASHTIRILISHI mumkin, agar
 * server proxy orqasida bo'lmasa (masalan to'g'ridan-to'g'ri internetga
 * ochiq bo'lsa). Productionda buni faqat ishonchli proxy (Railway, nginx,
 * Cloudflare) headerni QAYTA YOZGANDA ishlatish xavfsiz — Express'da
 * `app.set('trust proxy', 1)` shu sababdan kerak.
 */
export function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.socket.remoteAddress || req.ip || '0.0.0.0';
}

export async function isIpBlocked(ip: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin().rpc('is_ip_blocked', { p_ip: ip });
  if (error) {
    // Rate-limit tekshiruvi o'zi ishlamay qolsa ham, /auth/register butunlay
    // to'xtab qolmasligi kerak — xatoni logga yozib, "bloklanmagan" deb
    // hisoblaymiz (fail-open). Muqobil (fail-closed) ham mumkin, lekin bu
    // holatda haqiqiy foydalanuvchilarni bloklab qo'yish xavfi bor.
    console.error('is_ip_blocked RPC xatosi:', error.message);
    return false;
  }
  return Boolean(data);
}

/** @returns shu urinishdan keyin IP bloklanganmi (5-chi muvaffaqiyatsiz urinish) */
export async function recordInviteFailure(ip: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin().rpc('record_invite_failure_and_maybe_block', { p_ip: ip });
  if (error) {
    console.error('record_invite_failure_and_maybe_block RPC xatosi:', error.message);
    return false;
  }
  return Boolean(data);
}
