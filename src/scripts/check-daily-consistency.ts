// ============================================================================
// KUNLIK SON IZCHILLIGI TEKSHIRUVI (2026-10-12).
//
// Bitta kompaniya va bitta Toshkent kuni uchun quyidagilar BIR XIL kunlik
// qo'ng'iroqlar sonini qaytarishini tekshiradi (HTTP orqali, haqiqiy
// endpointlar):
//   /analytics/daily-summary        — o'sha kun qatori: calls, operator_calls
//   /analytics/hourly               — 24 soat yig'indisi
//   /analytics/analysis-status      — total, operator_calls
//   /analytics/overview             — daily.calls.current (faqat BUGUN uchun)
//   /analytics/daily-minutes        — o'sha kun qatori
//   /api/management/conversion-history — o'sha kun qatori
//   /api/management/daily-panel     — "Boshqaruv paneli" (oxirgi 31 kun)
//   baza (to'g'ridan-to'g'ri count) — haqiqat manbai
// Ikkala ta'rif alohida solishtiriladi:
//   calls          — BARCHA qo'ng'iroqlar
//   operator_calls — ichki raqami (bo'sh emas) yoki xodimi bor qo'ng'iroqlar
//
// Ishlatish (AUTH_JWT_SECRET va Supabase kalitlari kerak — Railway env bilan):
//   railway run npx tsx src/scripts/check-daily-consistency.ts \
//     --company=<uuid> [--date=YYYY-MM-DD] [--base=https://<backend-domeni>]
//   (--token=<session JWT> berilsa, AUTH_JWT_SECRET shart emas)
//
// Natija: hammasi mos bo'lsa exit 0, aks holda jadval + exit 1.
// BUGUN uchun tekshirilsa, so'rovlar orasida yangi qo'ng'iroq kelib qolishi
// mumkin — shunda skript 2 marta qayta urinadi.
// ============================================================================
import '../env';
import { signSessionToken } from '../lib/authToken';
import { supabase } from '../lib/supabase';
import { addDays, tashkentDay, tashkentDayStart } from '../lib/tashkentTime';

function arg(name: string): string | undefined {
  const p = `--${name}=`;
  return process.argv.find((a) => a.startsWith(p))?.slice(p.length);
}

const companyId = arg('company') || process.env.CHECK_COMPANY_ID || '';
const base = (arg('base') || process.env.CHECK_BASE_URL || `http://localhost:${process.env.PORT || 5001}`).replace(/\/+$/, '');
const today = tashkentDay(new Date());
const date = arg('date') || today;

if (!/^[0-9a-f-]{36}$/i.test(companyId)) {
  console.error('--company=<uuid> majburiy.');
  process.exit(2);
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today) {
  console.error('--date YYYY-MM-DD formatda va bugundan katta bo\'lmasligi kerak.');
  process.exit(2);
}

function sessionToken(): string {
  const given = arg('token') || process.env.CHECK_TOKEN;
  if (given) return given;
  try {
    return signSessionToken({ sub: 'check-daily-consistency', company_id: companyId, role: 'director' });
  } catch {
    console.error('AUTH_JWT_SECRET yo\'q — "railway run ..." bilan ishga tushiring yoki --token=<JWT> bering.');
    process.exit(2);
  }
}
const token = sessionToken();

/** Bugundan sanagacha necha kun (bugun ham kiradi). */
const span = Math.round((tashkentDayStart(today).getTime() - tashkentDayStart(date).getTime()) / 86_400_000) + 1;

interface Count { source: string; calls: number | null; operator_calls: number | null; note?: string }

async function get(path: string): Promise<any> {
  const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  const body: any = await res.json().catch(() => null);
  if (!res.ok || !body?.success) throw new Error(`${path}: HTTP ${res.status} ${body?.error || ''}`.trim());
  return body;
}

const num = (v: unknown): number | null => (typeof v === 'number' ? v : v == null ? null : Number(v));

async function dbCounts(): Promise<Count> {
  const from = tashkentDayStart(date).toISOString();
  const to = tashkentDayStart(addDays(date, 1)).toISOString();
  const q = () => supabase.from('calls').select('id', { count: 'exact', head: true })
    .eq('company_id', companyId).gte('created_at', from).lt('created_at', to);
  const [all, op] = await Promise.all([
    q(),
    // perf_01 call_is_operator bilan bir xil: operator_ext <> '' YOKI manager_id bor.
    q().or('operator_ext.neq."",manager_id.not.is.null'),
  ]);
  if (all.error) throw new Error(all.error.message);
  if (op.error) throw new Error(op.error.message);
  return { source: 'baza (count)', calls: all.count ?? 0, operator_calls: op.count ?? 0 };
}

async function collect(): Promise<Count[]> {
  const tasks: Array<Promise<Count>> = [
    dbCounts(),
    get(`/analytics/daily-summary?days=${span}`).then((b) => {
      const row = (b.data || []).find((r: any) => r.date === date);
      return { source: '/analytics/daily-summary', calls: num(row?.calls ?? 0), operator_calls: num(row?.operator_calls ?? 0) };
    }),
    get(`/analytics/hourly?date=${date}`).then((b) => ({
      source: '/analytics/hourly (24 soat)',
      calls: (b.data || []).reduce((s: number, h: any) => s + (Number(h.calls) || 0), 0),
      operator_calls: (b.data || []).reduce((s: number, h: any) => s + (Number(h.operator_calls) || 0), 0),
    })),
    get(`/analytics/analysis-status?date=${date}`).then((b) => ({
      source: '/analytics/analysis-status', calls: num(b.data?.total), operator_calls: num(b.data?.operator_calls),
    })),
  ];
  if (span <= 90) {
    tasks.push(
      get(`/analytics/daily-minutes?days=${span}`).then((b) => {
        const row = (b.data || []).find((r: any) => r.date === date);
        return { source: '/analytics/daily-minutes', calls: num(row?.calls ?? 0), operator_calls: num(row?.operator_calls ?? 0) };
      }),
      get(`/api/management/conversion-history?days=${span}`).then((b) => {
        const row = (b.data || []).find((r: any) => r.date === date);
        return { source: '/management/conversion-history', calls: num(row?.calls ?? 0), operator_calls: num(row?.operator_calls ?? 0) };
      }),
    );
  }
  if (span <= 31) {
    tasks.push(get(`/api/management/daily-panel?days=${span}`).then((b) => {
      const row = (b.data?.days || []).find((r: any) => r.date === date);
      return { source: '/management/daily-panel', calls: num(row?.calls ?? 0), operator_calls: num(row?.operator_calls ?? 0) };
    }));
  }
  if (date === today) {
    tasks.push(get('/analytics/overview').then((b) => ({
      source: '/analytics/overview (daily)',
      calls: num(b.data?.daily?.calls?.current),
      operator_calls: num(b.data?.daily?.operator_calls?.current),
    })));
  }
  return Promise.all(tasks);
}

function consistent(rows: Count[]): boolean {
  const uniq = (k: 'calls' | 'operator_calls') => new Set(rows.map((r) => r[k])).size === 1;
  return uniq('calls') && uniq('operator_calls');
}

async function main(): Promise<void> {
  console.log(`Kompaniya ${companyId}, Toshkent kuni ${date}, backend ${base}\n`);
  let rows: Count[] = [];
  const attempts = date === today ? 3 : 1;
  for (let i = 1; i <= attempts; i++) {
    rows = await collect();
    if (consistent(rows)) break;
    if (i < attempts) {
      console.log(`  (${i}-urinish: farq bor — bugun yangi qo'ng'iroq kelgan bo'lishi mumkin, 3 s dan keyin qayta)`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }

  const ref = rows[0];
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(`${pad('manba', 36)}${pad('calls', 10)}operator_calls`);
  for (const r of rows) {
    const mark = r.calls === ref.calls && r.operator_calls === ref.operator_calls ? '✅' : '❌';
    console.log(`${pad(r.source, 36)}${pad(String(r.calls), 10)}${pad(String(r.operator_calls), 16)}${mark}`);
  }
  if (date !== today) console.log('\n(overview faqat BUGUN uchun kunlik son beradi — boshqa sanada tekshirilmaydi)');
  if (span > 90) console.log('(daily-minutes va conversion-history ko\'pi bilan 90 kunni qamraydi — tekshirilmadi)');

  if (consistent(rows)) {
    console.log('\nHAMMASI MOS ✅');
    process.exit(0);
  }
  console.log('\nFARQ BOR ❌ — yuqoridagi jadvalga qarang.');
  process.exit(1);
}

main().catch((e) => {
  console.error('Tekshiruv xatosi:', e?.message || e);
  process.exit(2);
});
