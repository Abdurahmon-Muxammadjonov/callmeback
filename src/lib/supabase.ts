import { createClient } from '@supabase/supabase-js';

// Ikkala nomlash uslubini ham qo'llab-quvvatlaymiz (eski va yangi Supabase kalitlari).
const supabaseUrl =
  process.env.SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  '';

const supabaseServiceKey =
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  '';

if (!supabaseUrl || !supabaseServiceKey) {
  // Jim placeholder'ga ulanib "fetch failed" berish o'rniga aniq xato beramiz.
  throw new Error(
    'Supabase konfiguratsiyasi yo\'q: .env.local da NEXT_PUBLIC_SUPABASE_URL (yoki SUPABASE_URL) ' +
    'va SUPABASE_SERVICE_ROLE_KEY (yoki SUPABASE_SECRET_KEY) belgilangan bo\'lishi kerak. ' +
    'Hamda src/server.ts birinchi qatorida "import \'./env\'" turishini tekshiring.'
  );
}

export const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

// PostgREST ba'zan yangi qo'shilgan foreign key'larni schema keshida ko'rmay qoladi
// ("Could not find a relationship..." xatosi). Shu holatda keshni yangilashga urinib,
// so'rovni bir marta qayta ishga tushiramiz.
export async function reloadSchemaCache(): Promise<void> {
  try {
    const schemaClient = typeof (supabase as any).schema === 'function'
      ? (supabase as any).schema('pg_catalog')
      : supabase;
    if (typeof (schemaClient as any).rpc === 'function') {
      await (schemaClient as any).rpc('pg_notify', { channel: 'pgrst', payload: 'reload schema' });
    }
  } catch (error: any) {
    console.warn('PostgREST schema reload failed:', error?.message || error);
  }
}

export async function withSchemaReloadRetry<T>(
  action: () => PromiseLike<{ data: T; error: any }>
): Promise<{ data: T; error: any }> {
  const first = await action();
  if (!first.error) return first;

  const isRelationshipError = /Could not find a relationship/i.test(first.error?.message || '');
  if (!isRelationshipError) return first;

  await reloadSchemaCache();
  return action();
}
