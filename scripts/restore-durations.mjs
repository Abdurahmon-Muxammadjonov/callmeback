#!/usr/bin/env node
// ============================================================================
// DAVOMIYLIGI 0 BO'LGAN QO'NG'IROQLARNI TIKLAYDI (2026-09-27)
//
// NEGA: callRowFields audit.duration ni shartsiz yozardi, GPT esa bu
// maydonni qaytarmaydi -> har qayta tahlil calls.duration ni 0 ga
// tushirardi. Kod tuzatildi (duration endi GPT'dan umuman yozilmaydi);
// bu skript allaqachon nolga aylangan qatorlarni tiklaydi.
//
// IKKI MANBA, shu tartibda:
//   1) requeue-backup-*.json — qayta navbatga qo'yishdan oldingi ASL qiymat;
//   2) audio faylning O'ZI — probeWavDurationSec() WAV sarlavhasining
//      birinchi 44 baytini Range so'rovi bilan oladi (butun fayl
//      yuklanmaydi), byteRate va to'liq hajmdan davomiylikni hisoblaydi.
//
// XAVFSIZLIK: faqat 0 -> >0. PATCH shartida duration=eq.0 himoyasi bor,
// ya'ni orada boshqa jarayon to'g'ri qiymat yozib qo'ysa ustidan yozilmaydi.
//
// ISHLATISH:
//   node scripts/restore-durations.mjs            # sinov (hisobot)
//   node scripts/restore-durations.mjs --apply
// ============================================================================

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { probeWavDurationSec } from '../dist/lib/audioDuration.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');

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

const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

// --- 1) Zaxiralardan asl davomiyliklar ---
const fromBackup = new Map();
const files = readdirSync(ROOT).filter((f) => /^requeue-backup-.*\.json$/.test(f)).sort();
for (const f of files) {
  for (const r of JSON.parse(readFileSync(path.join(ROOT, f), 'utf8'))) {
    const d = Number(r.duration) || 0;
    if (d > 0) fromBackup.set(r.id, d);
  }
}

// --- 2) Bazadan duration=0 bo'lgan barcha qatorlar ---
const zero = [];
for (let offset = 0; ; offset += 1000) {
  const resp = await fetch(
    `${URL_BASE}/rest/v1/calls?select=id,created_at,audio_url,operator_ext`
    + `&company_id=eq.${COMPANY}&audio_url=not.is.null&duration=eq.0`
    + `&order=created_at.asc&limit=1000&offset=${offset}`,
    { headers: H, signal: AbortSignal.timeout(60_000) },
  );
  const page = await resp.json();
  if (!page?.length) break;
  zero.push(...page);
  if (page.length < 1000) break;
}

const tashkentDay = (iso) => new Date(new Date(iso).getTime() + 5 * 3600_000).toISOString().slice(0, 10);
const byDay = {};
for (const r of zero) {
  const d = tashkentDay(r.created_at);
  byDay[d] = (byDay[d] || 0) + 1;
}

console.log(`\nDavomiyligi 0 bo'lgan qator (audio bor): ${zero.length}`);
console.log('Kunlar bo\'yicha (Toshkent):');
for (const [k, v] of Object.entries(byDay).sort()) console.log(`  ${k}   ${String(v).padStart(5)}`);
console.log(`\nZaxiradan ma'lum: ${zero.filter((r) => fromBackup.has(r.id)).length}`);
console.log(`Audiodan o'lchash kerak: ${zero.filter((r) => !fromBackup.has(r.id)).length}`);

if (!zero.length) { console.log('\nTiklash kerak qator yo\'q.\n'); process.exit(0); }

// --- 3) Har biriga davomiylik topamiz ---
const resolved = [];
let probed = 0, failed = 0;
for (const r of zero) {
  let sec = fromBackup.get(r.id) || 0;
  let src = 'zaxira';
  if (!sec) {
    sec = (await probeWavDurationSec(r.audio_url)) || 0;
    src = 'audio';
    probed++;
  }
  if (sec > 0) resolved.push({ id: r.id, sec: Math.round(sec), src, day: tashkentDay(r.created_at) });
  else failed++;
  if ((probed + resolved.length) % 20 === 0) process.stdout.write(`\r  ... tekshirildi ${resolved.length + failed}/${zero.length}`);
}
console.log(`\r  tekshirildi ${zero.length}/${zero.length}          `);

const total = resolved.reduce((s, r) => s + r.sec, 0);
console.log(`\nTiklanadi   : ${resolved.length} qator, ${(total / 60).toFixed(1)} daqiqa`);
console.log(`  zaxiradan : ${resolved.filter((r) => r.src === 'zaxira').length}`);
console.log(`  audiodan  : ${resolved.filter((r) => r.src === 'audio').length}`);
console.log(`Topilmadi   : ${failed} (WAV emas yoki audio ochilmadi — 0 qoladi)`);

const perDay = {};
for (const r of resolved) perDay[r.day] = (perDay[r.day] || 0) + r.sec;
console.log('\nKunlar bo\'yicha tiklanadigan vaqt:');
for (const [k, v] of Object.entries(perDay).sort()) {
  console.log(`  ${k}   +${(v / 60).toFixed(1)} daqiqa`);
}

if (!APPLY) {
  console.log('\nSINOV rejimi — baza o\'zgartirilmadi. Bajarish: --apply\n');
  process.exit(0);
}

let done = 0;
for (const r of resolved) {
  const resp = await fetch(`${URL_BASE}/rest/v1/calls?id=eq.${r.id}&duration=eq.0`, {
    method: 'PATCH',
    headers: { ...H, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ duration: r.sec }),
    signal: AbortSignal.timeout(30_000),
  });
  if (resp.ok) done++;
  if (done % 20 === 0 || done === resolved.length) process.stdout.write(`\r  ... ${done}/${resolved.length}`);
}
console.log(`\n\nTAYYOR: ${done} qatorda davomiylik tiklandi (${(total / 60).toFixed(1)} daqiqa).`);
console.log('daily_stats jadvali YO\'Q — analitika calls dan jonli hisoblaydi,');
console.log('shuning uchun kunlik raqamlar 60 soniyalik kesh tugagach o\'zi to\'g\'rilanadi.\n');
