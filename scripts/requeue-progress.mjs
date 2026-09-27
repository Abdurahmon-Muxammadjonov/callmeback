#!/usr/bin/env node
// ============================================================================
// QAYTA NAVBAT BO'LAGINI KUZATADI (2026-09-27)
//
// AYNAN SO'NGGI BO'LAKNI o'lchaydi: requeue-stt.mjs har yurgizilganda
// o'zgartirgan qatorlarning id'larini JSON zaxiraga yozadi — shu fayldan
// id'lar olinadi va faqat o'shalarning hozirgi holati sanaladi.
//
// NEGA SHUNDAY: avval o'lchov butun oyna bo'yicha olinardi va hali
// navbatga qo'yilmagan 1900+ qator ham "bo'sh" deb sanalardi — natijada
// "bo'sh ulushi 99.5%" degan yolg'on ko'rsatkich chiqardi.
//
// ISHLATISH:
//   node scripts/requeue-progress.mjs            # bir marta
//   node scripts/requeue-progress.mjs --watch     # tugaguncha har daqiqada
//   node scripts/requeue-progress.mjs --file <zaxira.json>
// ============================================================================

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const WATCH = argv.includes('--watch');

const env = {};
for (const line of readFileSync(path.join(ROOT, '.env.local'), 'utf8').split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#') || !t.includes('=')) continue;
  const i = t.indexOf('=');
  env[t.slice(0, i)] = t.slice(i + 1).trim();
}
const URL_BASE = (env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/+$/, '');
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;

/** Eng yangi zaxira faylini topadi (yoki --file bilan berilganini). */
function backupPath() {
  const i = argv.indexOf('--file');
  if (i >= 0 && argv[i + 1]) return path.resolve(argv[i + 1]);
  const files = readdirSync(ROOT).filter((f) => /^requeue-backup-.*\.json$/.test(f)).sort();
  if (!files.length) {
    console.error('Zaxira fayli topilmadi. Avval requeue-stt.mjs ni yurgizing.');
    process.exit(1);
  }
  return path.join(ROOT, files[files.length - 1]);
}

const bak = backupPath();
const batch = JSON.parse(readFileSync(bak, 'utf8'));
const ids = batch.map((r) => r.id);
const durationById = new Map(batch.map((r) => [r.id, Number(r.duration) || 0]));

async function fetchRows(chunk) {
  const resp = await fetch(
    `${URL_BASE}/rest/v1/calls?select=id,status,transcript,kpi_score,dropped_reason,key_moments,is_problem`
    + `&id=in.(${chunk.join(',')})`,
    {
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
      signal: AbortSignal.timeout(60_000),
    },
  );
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  return resp.json();
}

async function report() {
  const rows = [];
  for (let i = 0; i < ids.length; i += 100) rows.push(...(await fetchRows(ids.slice(i, i + 100))));

  // DIQQAT: "bo'sh ulushi" FAQAT 90 soniyadan uzun qo'ng'iroqlar bo'yicha
  // hisoblanadi. Nega: UTel jiringlash vaqtini ham davomiylik deb yozadi va
  // liniya AYNAN 60 soniya jiringlab uzadi. 15-62 soniyalik "bo'sh"lar —
  // javobsiz jiringlashlar, ular nosozlik belgisi EMAS. Ilgari ular ham
  // sanalib, ko'rsatkich 85% ga chiqib yolg'on ogohlantirish berardi.
  const s = {
    navbatda: 0, ishlanmoqda: 0, matnli: 0, bosh: 0, shubhali: 0, xato: 0, ballangan: 0,
    keyMoments: 0, muammoli: 0,
    // 90s+ kesimi — nosozlikning haqiqiy ko'rsatkichi.
    uzunJami: 0, uzunBosh: 0,
    // Jiringlash kesimi — ma'lumot uchun.
    jiringlash: 0,
  };
  for (const r of rows) {
    const hasText = !!(r.transcript && String(r.transcript).trim());
    if (r.status === 'requeued') s.navbatda++;
    else if (r.status === 'processing') s.ishlanmoqda++;
    else if (r.status === 'stt_suspect') s.shubhali++;
    else if (r.status === 'failed') s.xato++;
    if (hasText) s.matnli++;
    else if (r.status === 'done') s.bosh++;
    const dur = durationById.get(r.id) || 0;
    if (dur >= 90) {
      s.uzunJami++;
      if (!hasText && r.status === 'done') s.uzunBosh++;
    } else if (!hasText && r.status === 'done' && dur >= 15) {
      s.jiringlash++;
    }
    if (Number(r.kpi_score) > 0) s.ballangan++;
    if (Array.isArray(r.key_moments) && r.key_moments.length) s.keyMoments++;
    if (r.is_problem) s.muammoli++;
  }

  const qoldi = s.navbatda + s.ishlanmoqda;
  const boshUlush = s.uzunJami ? (100 * s.uzunBosh) / s.uzunJami : 0;

  console.log(`\n[${new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Tashkent' })} Toshkent]`
    + `  bo'lak: ${ids.length} ta  (${path.basename(bak)})`);
  console.log(`  navbatda            : ${s.navbatda}`);
  console.log(`  ishlanmoqda         : ${s.ishlanmoqda}`);
  console.log(`  MATN OLDI           : ${s.matnli}`);
  console.log(`  ballangan (kpi>0)   : ${s.ballangan}`);
  console.log(`  vaqt belgilari bor  : ${s.keyMoments}`);
  console.log(`  muammoli deb topildi: ${s.muammoli}`);
  console.log(`  matnsiz (jiringlash): ${s.jiringlash}   <- javobsiz, normal`);
  console.log(`  bo'sh qaytdi (jami) : ${s.bosh}`);
  console.log(`  STT shubhali        : ${s.shubhali}`);
  console.log(`  xato (qayta urinadi): ${s.xato}`);
  console.log(`  --- NOSOZLIK KO'RSATKICHI (90s+ qo'ng'iroqlar) ---`);
  console.log(`  90s+ ishlangan      : ${s.uzunJami}`);
  console.log(`  shundan bo'sh       : ${s.uzunBosh}`);
  console.log(`  bo'sh ulushi        : ${boshUlush.toFixed(1)}%   (normal 0.4%, nosozlikda 88%)`);

  if (s.shubhali > 0) {
    console.log('\n  ⚠️  CIRCUIT BREAKER ISHGA TUSHGAN — navbat pauzada, STT ni tekshiring.');
  } else if (s.uzunJami >= 10 && boshUlush > 30) {
    console.log('\n  ⚠️  90s+ qo\'ng\'iroqlarda bo\'sh ulushi yuqori — STT ni tekshiring.');
  }
  return qoldi;
}

if (WATCH) {
  for (;;) {
    const qoldi = await report();
    if (qoldi === 0) { console.log('\nBo\'lak tugadi.\n'); break; }
    await new Promise((r) => setTimeout(r, 60_000));
  }
} else {
  await report();
  console.log('');
}
