#!/usr/bin/env node
// ============================================================================
// XATO BELGILANGAN QO'NG'IROQLARNI NAVBATGA QAYTARADI (2026-09-27)
//
// NIMA UCHUN: waitForAnalysis standart timeout'i 180 soniya edi. O'lchandi —
// 906 soniyalik audio uchun STT 1096 soniya ketadi. Timeout bo'lganda
// qo'ng'iroq "Javobsiz" / "Aloqa sifati yomon" deb belgilanar va
// status='done' yozilardi; navbat esa .neq('status','done') bilan tanlaydi,
// ya'ni qator boshqa hech qachon qayta urinilmasdi. 24-sentabr 19:01'dan
// keyingi 1976 qo'ng'iroq (38 soat audio, ichida 15 daqiqalik haqiqiy sotuv
// suhbatlari) shu sababdan tahlilsiz qoldi.
//
// Kod tuzatildi va deploy qilindi. Bu skript esa YOZIB QO'YILGAN XATO
// BELGILARNI tozalab, qatorlarni navbatga qaytaradi.
//
// XAVFSIZLIK:
//   - audio_url, duration, client_phone kabi ASL ma'lumot TEGILMAYDI.
//   - faqat tahlil natijasi tozalanadi: dropped_reason, rop_comment,
//     summary, error, status.
//   - o'zgartirishdan OLDIN barcha qatorlar JSON zaxiraga yoziladi.
//   - standart rejim — SINOV (hech narsa yozilmaydi). Qo'llash: --apply
//
// ISHLATISH:
//   node scripts/requeue-stt.mjs            # sinov: nima o'zgarishini ko'rsatadi
//   node scripts/requeue-stt.mjs --apply    # haqiqatan navbatga qaytaradi
// ============================================================================

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const APPLY = process.argv.includes('--apply');

// .env.local dan kalitlarni o'qiymiz.
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
// Xato boshlangan payt (oxirgi muvaffaqiyatli tahlil: 2026-09-24T14:01 UTC).
const SINCE = process.env.SINCE || '2026-09-24T14:00:00';
// Bundan qisqa audioda gaplashish bo'lmagan — "Javobsiz" to'g'ri, tegmaymiz.
const MIN_DURATION = Number(process.env.MIN_DURATION || 15);

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

const FILTER = `company_id=eq.${COMPANY}&transcript=is.null`
  + `&duration=gte.${MIN_DURATION}&created_at=gte.${SINCE}`;

// 1) Ta'sirlangan qatorlarni sahifalab olamiz (PostgREST bir so'rovda 1000 ta beradi).
const rows = [];
for (let offset = 0; ; offset += 1000) {
  const page = await rest('GET',
    'calls?select=id,created_at,operator_ext,duration,dropped_reason,rop_comment,summary,status,error'
    + `&${FILTER}&order=created_at.asc&limit=1000&offset=${offset}`);
  if (!page?.length) break;
  rows.push(...page);
  if (page.length < 1000) break;
}

const byReason = {};
let seconds = 0;
for (const r of rows) {
  const k = r.dropped_reason || '(sabab yo\'q)';
  byReason[k] = (byReason[k] || 0) + 1;
  seconds += Math.max(0, Number(r.duration) || 0);
}

console.log(`\nTa'sirlangan qator: ${rows.length}`);
console.log(`Jami audio: ${(seconds / 3600).toFixed(1)} soat`);
console.log('Hozirgi sabablari:');
for (const [k, v] of Object.entries(byReason).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(5)}  ${k}`);
}

if (!rows.length) { console.log('\nTozalash kerak qator yo\'q.'); process.exit(0); }

// 2) ZAXIRA — o'zgartirishdan oldin.
const backup = path.join(ROOT, `requeue-backup-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`);
writeFileSync(backup, JSON.stringify(rows, null, 1));
console.log(`\nZaxira: ${backup}`);

if (!APPLY) {
  console.log('\nSINOV rejimi — baza o\'zgartirilmadi.');
  console.log('Haqiqatan bajarish uchun: node scripts/requeue-stt.mjs --apply\n');
  process.exit(0);
}

// 3) Navbatga qaytaramiz.
const CLEAR = { status: 'queued', dropped_reason: null, rop_comment: null, summary: null, error: null };
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
console.log('Navbat ish vaqtida (09:00-23:00 Toshkent) o\'zi ishlab ketadi.');
console.log('Kuzatish: "Audio yozuvlar" bo\'limida Natija ustuni "Tahlil qilinmoqda…" bo\'ladi.\n');
