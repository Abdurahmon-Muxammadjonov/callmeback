import { supabase } from './supabase';

// ============================================================
// amoCRM OAuth2 klienti.
// Tokenlar `crm_accounts` jadvalida saqlanadi (bitta qator, id='amocrm').
// access_token muddati tugasa — refresh_token bilan avtomatik yangilanadi.
// amoCRM OAuth hujjati: https://www.amocrm.ru/developers/content/oauth/step-by-step
// ============================================================

const ACCOUNT_ID = 'amocrm';

export interface CrmAccount {
  id: string;
  subdomain: string | null;
  client_id: string | null;
  client_secret: string | null;
  redirect_uri: string | null;
  access_token: string | null;
  refresh_token: string | null;
  expires_at: string | null;
  last_sync: string | null;
}

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

async function loadAccount(): Promise<CrmAccount | null> {
  const { data, error } = await supabase.from('crm_accounts').select('*').eq('id', ACCOUNT_ID).maybeSingle();
  if (error) throw new Error(`crm_accounts o'qishda xatolik: ${error.message} (migratsiya supabase/add_crm.sql ishlatilganmi?)`);
  return (data as CrmAccount) || null;
}

function baseUrl(subdomain: string): string {
  // subdomain to'liq host bo'lishi mumkin (company.amocrm.ru) yoki faqat nom (company).
  const host = subdomain.includes('.') ? subdomain : `${subdomain}.amocrm.ru`;
  return `https://${host}`;
}

// authorization_code yoki refresh_token bilan token oladi.
async function fetchToken(
  acc: CrmAccount,
  grant: { grant_type: 'authorization_code'; code: string } | { grant_type: 'refresh_token'; refresh_token: string },
): Promise<TokenResponse> {
  if (!acc.subdomain || !acc.client_id || !acc.client_secret || !acc.redirect_uri) {
    throw new Error('amoCRM sozlamasi to\'liq emas (subdomain/client_id/client_secret/redirect_uri).');
  }
  const resp = await fetch(`${baseUrl(acc.subdomain)}/oauth2/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: acc.client_id,
      client_secret: acc.client_secret,
      redirect_uri: acc.redirect_uri,
      ...grant,
    }),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`amoCRM token xatosi (HTTP ${resp.status}): ${t.slice(0, 300)}`);
  }
  return resp.json() as Promise<TokenResponse>;
}

async function saveTokens(tok: TokenResponse): Promise<void> {
  // 60s xavfsizlik zaxirasi bilan muddatni hisoblaymiz.
  const expires_at = new Date(Date.now() + (tok.expires_in - 60) * 1000).toISOString();
  const { error } = await supabase
    .from('crm_accounts')
    .update({
      access_token: tok.access_token,
      refresh_token: tok.refresh_token,
      expires_at,
      updated_at: new Date().toISOString(),
    })
    .eq('id', ACCOUNT_ID);
  if (error) throw new Error(`Token saqlashda xatolik: ${error.message}`);
}

// Sozlamalarni saqlaydi va authorization code'ni token'ga almashtiradi (dastlabki ulanish).
export async function connect(input: {
  subdomain: string;
  client_id: string;
  client_secret: string;
  redirect_uri: string;
  code: string;
}): Promise<{ connected: true; subdomain: string }> {
  const row = {
    id: ACCOUNT_ID,
    subdomain: input.subdomain,
    client_id: input.client_id,
    client_secret: input.client_secret,
    redirect_uri: input.redirect_uri,
    updated_at: new Date().toISOString(),
  };
  const { error: upErr } = await supabase.from('crm_accounts').upsert(row, { onConflict: 'id' });
  if (upErr) throw new Error(`Sozlama saqlashda xatolik: ${upErr.message}`);

  const acc = await loadAccount();
  if (!acc) throw new Error('crm_accounts qatori topilmadi.');
  const tok = await fetchToken(acc, { grant_type: 'authorization_code', code: input.code });
  await saveTokens(tok);
  return { connected: true, subdomain: input.subdomain };
}

// Amal qiluvchi access_token qaytaradi; kerak bo'lsa refresh qiladi.
export async function getValidAccessToken(): Promise<{ token: string; acc: CrmAccount }> {
  const acc = await loadAccount();
  if (!acc || !acc.access_token || !acc.refresh_token) {
    throw new Error('amoCRM ulanmagan. Avval POST /crm/connect orqali ulang.');
  }
  const notExpired = acc.expires_at && new Date(acc.expires_at).getTime() > Date.now();
  if (notExpired) return { token: acc.access_token, acc };

  // Muddati tugagan — refresh.
  const tok = await fetchToken(acc, { grant_type: 'refresh_token', refresh_token: acc.refresh_token });
  await saveTokens(tok);
  return { token: tok.access_token, acc };
}

// amoCRM API'ga GET (avtomatik token + 401 da bir marta refresh).
export async function amoGet<T = any>(pathWithQuery: string): Promise<T> {
  const { token, acc } = await getValidAccessToken();
  const url = `${baseUrl(acc.subdomain!)}/api/v4${pathWithQuery}`;
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (resp.status === 204) return {} as T; // bo'sh ro'yxat
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`amoCRM GET ${pathWithQuery} xatosi (HTTP ${resp.status}): ${t.slice(0, 300)}`);
  }
  return resp.json() as Promise<T>;
}

export interface AmoUser {
  id: number;
  name: string;
  email: string;
  rights?: { is_active?: boolean };
}

// Barcha amoCRM foydalanuvchilarini (sahifalab) oladi — sotuvchilar = menejerlar.
export async function getUsers(): Promise<AmoUser[]> {
  const users: AmoUser[] = [];
  let page = 1;
  // Xavfsizlik: ko'pi bilan 50 sahifa (12500 user).
  while (page <= 50) {
    const data = await amoGet<{ _embedded?: { users?: AmoUser[] } }>(`/users?page=${page}&limit=250`);
    const batch = data?._embedded?.users || [];
    users.push(...batch);
    if (batch.length < 250) break;
    page++;
  }
  return users;
}

// Ulanish holati (frontend "amoCRM ulanishi" bo'limi uchun).
export async function getStatus(): Promise<{ connected: boolean; subdomain?: string; last_sync?: string | null }> {
  let acc: CrmAccount | null = null;
  try {
    acc = await loadAccount();
  } catch {
    return { connected: false }; // migratsiya hali ishlamagan bo'lishi mumkin
  }
  if (!acc || !acc.access_token) return { connected: false, subdomain: acc?.subdomain || undefined };
  return { connected: true, subdomain: acc.subdomain || undefined, last_sync: acc.last_sync };
}

export async function markSynced(): Promise<void> {
  await supabase.from('crm_accounts').update({ last_sync: new Date().toISOString() }).eq('id', ACCOUNT_ID);
}
