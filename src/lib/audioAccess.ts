import jwt from 'jsonwebtoken';
import { supabase } from './supabase';

// Qo'ng'iroq audiosi ENDI Supabase Storage'ga NUSXALANMAYDI (storage kvotasi
// to'lib, butun loyiha bloklanib qolgani uchun — 2026-09-06). Buning o'rniga
// calls.audio_source_url'da PBX'dagi ASL havola saqlanadi, audio esa shu
// backend orqali OQIM (proxy) qilib uzatiladi: GET /api/calls/:id/audio.
//
// Nega imzolangan token kerak: HTML <audio src="..."> tegi maxfiy sarlavha
// (Authorization header) YUBORA OLMAYDI, shu sabab oddiy requireAuth bu yerda
// ishlamaydi. Shuning uchun /api/calls javobida audio_url qisqa muddatli
// imzolangan havolaga almashtiriladi — token ichida qaysi qo'ng'iroq va qaysi
// kompaniya ekani yozilgan, ya'ni boshqa kompaniyaning audiosini eshitib
// bo'lmaydi (tenant izolyatsiyasi saqlanadi).

const JWT_SECRET = process.env.AUTH_JWT_SECRET;
const AUDIO_TOKEN_TTL_SECONDS = 6 * 60 * 60; // 6 soat — player uchun yetarli

export interface AudioTokenPayload {
  call_id: string;
  company_id: string;
  kind: 'audio';
}

export function signAudioToken(callId: string, companyId: string): string | null {
  if (!JWT_SECRET) return null;
  const payload: AudioTokenPayload = { call_id: callId, company_id: companyId, kind: 'audio' };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: AUDIO_TOKEN_TTL_SECONDS });
}

export function verifyAudioToken(token: string): AudioTokenPayload | null {
  if (!JWT_SECRET) return null;
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as AudioTokenPayload & jwt.JwtPayload;
    if (decoded.kind !== 'audio' || !decoded.call_id || !decoded.company_id) return null;
    return decoded;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// PBX integratsiyasi (webhook_url + api_key). Har bir audio so'rovida DB'ga
// bormaslik uchun qisqa muddatli kesh.
// ---------------------------------------------------------------------------
let cache: { at: number; webhookUrl: string; apiKey: string } | null = null;
const CACHE_TTL_MS = 60_000;

export async function getPbxIntegration(): Promise<{ webhookUrl: string; apiKey: string } | null> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) {
    return { webhookUrl: cache.webhookUrl, apiKey: cache.apiKey };
  }
  const { data } = await supabase
    .from('crm_integrations')
    .select('webhook_url, api_key')
    .eq('enabled', true)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const webhookUrl = (data?.webhook_url || '').trim();
  const apiKey = (data?.api_key || '').trim();
  if (!webhookUrl || !apiKey) return null;

  cache = { at: Date.now(), webhookUrl, apiKey };
  return { webhookUrl, apiKey };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return '';
  }
}

// API kalitni FAQAT PBX'ning o'z hostiga yuboramiz — audio_url boshqa
// (uchinchi tomon) manzilga ishora qilsa, sirimizni unga bermaymiz.
export async function pbxAuthHeaders(audioUrl: string): Promise<Record<string, string>> {
  const integration = await getPbxIntegration();
  if (!integration) return {};
  const target = hostOf(audioUrl);
  if (!target || target !== hostOf(integration.webhookUrl)) return {};
  return {
    'X-API-Key': integration.apiKey,
    Authorization: `Bearer ${integration.apiKey}`,
  };
}

// Eski (2026-09-06 gacha yaratilgan) qatorlarda audio_url Supabase Storage'ning
// ochiq havolasi — ular o'zgarishsiz ishlayveradi, proxy'ga o'tkazilmaydi.
export function isSupabaseStorageUrl(url: string): boolean {
  const base = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').trim();
  if (!base || !url) return false;
  return hostOf(url) === hostOf(base) && url.includes('/storage/v1/');
}
