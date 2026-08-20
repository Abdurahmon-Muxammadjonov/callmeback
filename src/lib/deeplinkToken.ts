import crypto from 'node:crypto';
import { supabase } from './supabase';

const TOKEN_TTL_MS = 30 * 60 * 1000; // 30 daqiqa
const RATE_LIMIT_MAX_PER_HOUR = 5;

export function generateDeeplinkToken(): string {
  return crypto.randomBytes(18).toString('base64url'); // ~24 belgi
}

export async function checkDeeplinkRateLimit(companyId: string): Promise<boolean> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count } = await supabase
    .from('bot_deeplink_tokens')
    .select('token', { count: 'exact', head: true })
    .eq('company_id', companyId)
    .gte('created_at', oneHourAgo);
  return (count ?? 0) < RATE_LIMIT_MAX_PER_HOUR;
}

export async function createDeeplinkToken(companyId: string, purpose: 'get_code' | 'upgrade'): Promise<string> {
  const token = generateDeeplinkToken();
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
  const { error } = await supabase.from('bot_deeplink_tokens').insert({ token, company_id: companyId, purpose, expires_at: expiresAt });
  if (error) throw new Error(error.message);
  return token;
}

/** Token'ni bir martalik ishlatadi (topilsa/eskirmagan/ishlatilmagan bo'lsa) — aks holda null. */
export async function resolveDeeplinkToken(token: string): Promise<{ companyId: string; purpose: 'get_code' | 'upgrade' } | null> {
  const { data, error } = await supabase
    .from('bot_deeplink_tokens')
    .select('company_id, purpose, expires_at, used')
    .eq('token', token)
    .maybeSingle();

  if (error || !data || data.used) return null;
  if (new Date(data.expires_at).getTime() < Date.now()) return null;

  // Bir martalik: ikki parallel urinishning faqat bittasi muvaffaqiyatli
  // bo'lishi uchun `.eq('used', false)` shart bilan yangilaymiz.
  const { data: updated, error: updateErr } = await supabase
    .from('bot_deeplink_tokens')
    .update({ used: true })
    .eq('token', token)
    .eq('used', false)
    .select('token')
    .maybeSingle();

  if (updateErr || !updated) return null;
  return { companyId: data.company_id, purpose: data.purpose as 'get_code' | 'upgrade' };
}
