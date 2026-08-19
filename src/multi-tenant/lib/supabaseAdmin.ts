import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// Stack: Node.js + Express + TypeScript (loyihaning qolgan qismi bilan bir xil).
//
// Bu klient SERVICE_ROLE kalit bilan ishlaydi — RLS'ni chetlab o'tadi.
// Shu sabab uni FAQAT backend kodida ishlating (hech qachon frontend'ga
// yoki javobga chiqarmang) va har bir so'rovda company_id filtrini QO'LDA
// qo'shishni unutmang — RLS bu klient uchun himoya bermaydi, chunki u
// maxsus shu maqsad uchun (auth.users yaratish, boshqa tenant'lar nomidan
// yozish kerak bo'lgan holatlar — masalan /auth/register) mo'ljallangan.
let cached: SupabaseClient | null = null;

export function supabaseAdmin(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    throw new Error('SUPABASE_URL va SUPABASE_SERVICE_ROLE_KEY sozlanmagan.');
  }

  cached = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}
