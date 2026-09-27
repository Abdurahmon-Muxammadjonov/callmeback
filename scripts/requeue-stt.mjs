#!/usr/bin/env node
// ============================================================================
// XATO BELGILANGAN QO'NG'IROQLARNI NAVBATGA QAYTARADI (2026-09-27)
//
// NIMA UCHUN: 24-sentabr 19:01:49 (Toshkent) dan sales-ai-front har bir
// audioga HTTP 200 va status='done' qaytardi, lekin transkript BO'SH edi.
// Bo'sh matn "Javobsiz" / "Aloqa sifati yomon" deb yozilib status='done'
// qo'yilardi — navbat esa .neq('status','done') bilan tanlaydi, ya'ni
// bunday qator BOSHQA HECH QACHON olinmasdi. 2949 qo'ng'iroq shu sababdan
// tahlilsiz qoldi (ichida 5 daqiqalik haqiqiy sotuv suhbatlari ham bor).
//
// Xizmat tiklangani tasdiqlandi: production kod yo'li bilan sinalgan
// 5 ta "Aloqa sifati yomon" qo'ng'iroqning 5 tasi ham matn berdi.
//
// TANLASH SHARTLARI
//   - UTel audiosi bor va transkript BO'SH;
//   - 24-sen 14:00 UTC (19:00 Toshkent) dan keyin kelgan;
//   - davomiyligi >= MIN_DURATION (standart 15s) — undan qisqasida
//     "Javobsiz" haqiqatan to'g'ri, bekorga token sarflamaymiz;
//   - "Kunlik limitdan oshdi" deb qolganlar ham kiradi.
//
// XAVFSIZLIK
//   - asl ma'lumot (audio_url, duration, client_phone) TEGILMAYDI;
//   - faqat tahlil natijasi tozalanadi: dropped_reason, rop_comment,
//     summary, error;
//   - status='requeued' qo'yiladi. Bu backend uchun belgi:
//       * kunlik limitga KIRMAYDI (global limit 3600 o'zgarishsiz qoladi);
//       * PAST USTUVORLIK — jonli qo'ng'iroq har doim birinchi.
//     (src/routes/utel-webhook.ts, REQUEUED_STATUS)
//   - o'zgartirishdan OLDIN barcha qatorlar JSON zaxiraga yoziladi;
//   - standart rejim — SINOV. Yozish uchun --apply kerak.
//
// ISHLATISH
//   node scripts/requeue-stt.mjs                      # sinov (hisobot)
//   node scripts/requeue-stt.mjs --limit 50 --apply   # birinchi bo'lak
//   node scripts/requeue-stt.mjs --limit 300 --apply  # keyingi bo'laklar
//   node scripts/requeue-stt.mjs --apply              # qolgan hammasi
//
// DIQQAT: --limit eng ESKISIDAN boshlab oladi (created_at o'sish tartibi),
// shuning uchun bo'laklab yurgizish takrorlanmaydi.
// ============================================================================

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const LIMIT = (() => {
  const i = argv.indexOf('--limit');
  const n = i >= 0 ? Number(argv[i + 1]) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
})();

const env = {};
for (const line of readFileSync(path.join(ROOT, '.env.local'), 'utf8').split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#') || !t.includes('=')) continue;
  const i = t.indexOf('=');
  env[t.slice(0, i)] = t.slice(i + 1).trim();
}
const URL_BASE = (env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_BASE || !KEY) {
  console.error('XATO: .env.local ichida SUPABASE_URL va SUPABASE_SERVICE_ROLE_KEY bo\'lishi kerak.');
  process.exit(1);
}

const COMPANY = process.env.COMPANY_ID || '24823352-465e-43ea-913c-9f9d7270b9e9';
const SINCE = process.env.SINCE || '2026-09-24T14:00:00';
const MIN_DURATION = Number(process.env.MIN_DURATION || 15);
/** Backend shu holatni "limitdan ozod + past ustuvorlik" deb tushunadi. */
const REQUEUED_STATUS = 'requeued';

async function rest(method, qs, body, extraHeaders) {
  const headers = {
    apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json',
    ...(extraHeaders || {}),
  };
  const resp = await fetch(`${URL_BASE}/rest/v1/${qs}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const text = await resp.text();
  return text.trim() ? JSON.parse(text) : null;
}

// Faqat hali qayta navbatga qo'yilmaganlarni olamiz — bo'laklab yurgizish
// takrorlanmasin (status allaqachon 'requeued' bo'lsa o'tkazib yuboriladi).
const FILTER = `company_id=eq.${COMPANY}&transcript=is.null`
  + `&duration=gte.${MIN_DURATION}&created_at=gte.${SINCE}`
  + `&status=neq.${REQUEUED_STATUS}`;

const all = [];
for (let offset = 0; ; offset += 1000) {
  const page = await rest('GET',
    'calls?select=id,created_at,operator_ext,duration,dropped_reason,rop_comment,summary,status,error'
    + `&${FILTER}&order=created_at.asc&limit=1000&offset=${offset}`);
  if (!page?.length) break;
  all.push(...page);
  if (page.length < 1000) break;
}
const rows = LIMIT ? all.slice(0, LIMIT) : all;

// --- Hisobot: kunlar va sabablar bo'yicha ---
const tashkentDay = (iso) => new Date(new Date(iso).getTime() + 5 * 3600_000).toISOString().slice(0, 10);
const byDay = {}, byReason = {};
let seconds = 0;
for (const r of rows) {
  const d = tashkentDay(r.created_at);
  byDay[d] = (byDay[d] || 0) + 1;
  const k = r.dropped_reason || '(sabab yo\'q)';
  byReason[k] = (byReason[k] || 0) + 1;
  seconds += Math.max(0, Number(r.duration) || 0);
}

console.log(`\nJami mos keladigan : ${all.length}`);
console.log(`Bu bo'lakda        : ${rows.length}${LIMIT ? ` (--limit ${LIMIT})` : ''}`);
console.log(`Audio hajmi        : ${(seconds / 3600).toFixed(1)} soat`);
console.log('\nKunlar bo\'yicha (Toshkent):');
for (const [k, v] of Object.entries(byDay).sort()) console.log(`  ${k}   ${String(v).padStart(5)}`);
console.log('\nHozirgi sabablari:');
for (const [k, v] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(5)}  ${k}`);
}
console.log('\nO\'zgarish: status -> \'requeued\' (limitdan ozod, past ustuvorlik);'
  + '\n           dropped_reason / rop_comment / summary / error -> null;'
  + '\n           audio_url, duration, client_phone TEGILMAYDI.');

if (!rows.length) { console.log('\nTozalash kerak qator yo\'q.\n'); process.exit(0); }

const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const backup = path.join(ROOT, `requeue-backup-${stamp}.json`);
writeFileSync(backup, JSON.stringify(rows, null, 1));
console.log(`\nZaxira: ${backup}`);

if (!APPLY) {
  console.log('\nSINOV rejimi — baza o\'zgartirilmadi.');
  console.log(`Bajarish: node scripts/requeue-stt.mjs${LIMIT ? ` --limit ${LIMIT}` : ''} --apply\n`);
  process.exit(0);
}

const CLEAR = {
  status: REQUEUED_STATUS,
  dropped_reason: null, rop_comment: null, summary: null, error: null,
};
const ids = rows.map((r) => r.id);
let done = 0;
for (let i = 0; i < ids.length; i += 100) {
  const chunk = ids.slice(i, i + 100);
  await rest('PATCH', `calls?id=in.(${chunk.join(',')})`, CLEAR, { Prefer: 'return=minimal' });
  done += chunk.length;
  process.stdout.write(`\r  ... ${done}/${ids.length}`);
  await new Promise((r) => setTimeout(r, 150));
}
console.log(`\n\nTAYYOR: ${done} qator navbatga qaytarildi.`);
console.log('Navbat ish vaqtida (09:00-23:00 Toshkent) o\'zi ishlab ketadi,');
console.log('jonli qo\'ng\'iroqlardan keyingi ustuvorlik bilan.');
console.log('Kuzatish: node scripts/requeue-progress.mjs\n');
