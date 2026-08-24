import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let supabaseClient: SupabaseClient | null = null;

function getSupabaseConfig(): { url: string; serviceKey: string } {
  const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '';
  const serviceKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !serviceKey) {
    throw new Error(
      'Supabase konfiguratsiyasi yo\'q: Railway yoki .env.local da SUPABASE_URL (yoki NEXT_PUBLIC_SUPABASE_URL) ' +
      'va SUPABASE_SERVICE_ROLE_KEY (yoki SUPABASE_SECRET_KEY) belgilangan bo\'lishi kerak.'
    );
  }
  return { url, serviceKey };
}

function getSupabaseClient(): SupabaseClient {
  if (!supabaseClient) {
    const { url, serviceKey } = getSupabaseConfig();
    supabaseClient = createClient(url, serviceKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    });
  }
  return supabaseClient;
}

export const supabase = new Proxy({} as SupabaseClient, {
  get(_target, prop, receiver) {
    const client = getSupabaseClient();
    const value = Reflect.get(client, prop, receiver);
    if (typeof value === 'function') return value.bind(client);
    return value;
  },
  set(_target, prop, value) {
    const client = getSupabaseClient();
    return Reflect.set(client, prop, value);
  },
}) as SupabaseClient;

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

// PostgREST har bir so'rovga 1000 qatorlik standart chegara qo'yadi — shu sababli
// `.select(...)`ni to'g'ridan-to'g'ri `.length`/`.reduce()` bilan agregatsiya qilish
// jadval 1000 qatordan oshgan zahoti (masalan "jami qo'ng'iroqlar soni") noto'g'ri,
// muzlab qolgan natija berardi. Bu yerda sahifalab (`.range()`) HAMMA qatorni yig'ib
// olamiz — dataset qancha o'ssa ham son to'g'ri chiqishi uchun.
const PAGE_SIZE = 1000;
export async function fetchAllRows<T>(
  queryFactory: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: any }>
): Promise<T[]> {
  const all: T[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await queryFactory(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const rows = data || [];
    all.push(...rows);
    if (rows.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return all;
}
