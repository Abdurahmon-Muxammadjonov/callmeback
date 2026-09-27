#!/usr/bin/env node
// ============================================================================
// QAYTA NAVBAT JARAYONINI KUZATADI (2026-09-27)
//
// Har bo'lakdan keyin: nechtasi matn oldi, nechtasi bo'sh qaytdi, nechtasi
// xato bilan tugadi, nechtasi hali navbatda. Bo'sh ulushi normal darajadan
// keskin oshsa OGOHLANTIRADI — bu STT yana buzilganini bildiradi.
//
// NORMAL DARAJA (haqiqiy ma'lumotdan o'lchangan, ≥20s qo'ng'iroqlar):
//   23-sentabr      19.7% bo'sh
//   24-sen ertalab  14.7% bo'sh
// Shu sabab 40% dan oshsa shubhali, 70% — circuit breaker chegarasi.
//
// ISHLATISH: node scripts/requeue-progress.mjs [--watch]
// ============================================================================

import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const WATCH = process.argv.includes('--watch');

const env = {};
for (const line of readFileSync(path.join(ROOT, '.env.local'), 'utf8').split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#') || !t.includes('=')) continue;
  const i = t.indexOf('=');
  env[t.slice(0, i)] = t.slice(i + 1).trim();
}
const URL_BASE = (env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const COMPANY = process.env.COMPANY_ID || '24823352-465e-43ea-913c-9f9d7270b9e9';
const SINCE = process.env.SINCE || '2026-09-24T14:00:00';

async function count(filter) {
  const resp = await fetch(`${URL_BASE}/rest/v1/calls?select=id&${filter}`, {
    headers: {
      apikey: KEY, Authorization: `Bearer ${KEY}`,
      Prefer: 'count=exact', Range: '0-0',
    },
    signal: AbortSignal.timeout(60_000),
  });
  const cr = resp.headers.get('content-range') || '/0';
  return Number(cr.split('/')[1]) || 0;
}

async function report() {
  const base = `company_id=eq.${COMPANY}&created_at=gte.${SINCE}&duration=gte.15`;
  const [navbatda, ishlanmoqda, matnli, shubhali, xato, javobsiz] = await Promise.all([
    count(`${base}&status=eq.requeued`),
    count(`${base}&status=eq.processing`),
    count(`${base}&transcript=not.is.null`),
    count(`${base}&status=eq.stt_suspect`),
    count(`${base}&status=eq.failed`),
    count(`${base}&transcript=is.null&status=eq.done`),
  ]);
  const ishlangan = matnli + javobsiz;
  const boshUlush = ishlangan ? (100 * javobsiz) / ishlangan : 0;

  console.log(`\n[${new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Tashkent' })} Toshkent]`);
  console.log(`  navbatda (requeued) : ${navbatda}`);
  console.log(`  ishlanmoqda         : ${ishlanmoqda}`);
  console.log(`  MATN OLDI           : ${matnli}`);
  console.log(`  bo'sh qaytdi        : ${javobsiz}`);
  console.log(`  STT shubhali        : ${shubhali}`);
  console.log(`  xato (qayta urinadi): ${xato}`);
  console.log(`  bo'sh ulushi        : ${boshUlush.toFixed(1)}%  (normal 15-20%)`);

  if (shubhali > 0) {
    console.log('\n  ⚠️  CIRCUIT BREAKER ISHGA TUSHGAN — navbat pauzada.');
  } else if (ishlangan >= 20 && boshUlush > 40) {
    console.log('\n  ⚠️  Bo\'sh ulushi normal darajadan yuqori — STT ni tekshiring.');
  }
  return { navbatda, ishlanmoqda };
}

if (WATCH) {
  for (;;) {
    const { navbatda, ishlanmoqda } = await report();
    if (navbatda === 0 && ishlanmoqda === 0) { console.log('\nNavbat tugadi.\n'); break; }
    await new Promise((r) => setTimeout(r, 60_000));
  }
} else {
  await report();
  console.log('');
}
