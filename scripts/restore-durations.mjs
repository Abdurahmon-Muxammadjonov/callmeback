#!/usr/bin/env node
// ============================================================================
// ZAXIRADAN DAVOMIYLIKNI TIKLAYDI (2026-09-27)
//
// NEGA: qayta tahlil calls.duration ni 0 ga tushirardi (callRowFields
// audit.duration ni yozardi, GPT esa bu maydonni qaytarmaydi). Kod
// tuzatildi; bu skript allaqachon nolga aylangan qatorlarni
// requeue-backup-*.json dagi ASL qiymatlardan tiklaydi.
//
// FAQAT 0 dan >0 ga o'zgartiradi — boshqa hech narsaga tegmaydi.
//
// ISHLATISH:
//   node scripts/restore-durations.mjs                 # sinov
//   node scripts/restore-durations.mjs --apply
//   node scripts/restore-durations.mjs --file <zaxira.json> --apply
// ============================================================================

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

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

function backupFiles() {
  const i = argv.indexOf('--file');
  if (i >= 0 && argv[i + 1]) return [path.resolve(argv[i + 1])];
  return readdirSync(ROOT)
    .filter((f) => /^requeue-backup-.*\.json$/.test(f))
    .sort()
    .map((f) => path.join(ROOT, f));
}

async function rest(method, qs, body) {
  const resp = await fetch(`${URL_BASE}/rest/v1/${qs}`, {
    method,
    headers: {
      apikey: KEY, Authorization: `Bearer ${KEY}`,
      'Content-Type': 'application/json', Prefer: 'return=minimal',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const t = await resp.text();
  return t.trim() ? JSON.parse(t) : null;
}

// Zaxiralardan asl davomiyliklarni yig'amiz (eng oxirgi nusxa ustun).
const original = new Map();
const files = backupFiles();
for (const f of files) {
  for (const r of JSON.parse(readFileSync(f, 'utf8'))) {
    const d = Number(r.duration) || 0;
    if (d > 0) original.set(r.id, d);
  }
}
console.log(`\nZaxira fayllari: ${files.length}  |  asl davomiyligi ma'lum: ${original.size} qator`);

// Hozirgi holat.
const ids = [...original.keys()];
const nowById = new Map();
for (let i = 0; i < ids.length; i += 100) {
  const chunk = ids.slice(i, i + 100);
  const rows = await fetch(
    `${URL_BASE}/rest/v1/calls?select=id,duration&id=in.(${chunk.join(',')})`,
    { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` }, signal: AbortSignal.timeout(60_000) },
  ).then((r) => r.json());
  for (const r of rows) nowById.set(r.id, Number(r.duration) || 0);
}

const toFix = ids.filter((id) => nowById.get(id) === 0);
const lost = toFix.reduce((s, id) => s + original.get(id), 0);
console.log(`Davomiyligi 0 bo'lib qolgan : ${toFix.length}`);
console.log(`Tiklanadigan vaqt           : ${lost} soniya (${(lost / 60).toFixed(1)} daqiqa)`);

if (!toFix.length) { console.log('\nTiklash kerak qator yo\'q.\n'); process.exit(0); }
if (!APPLY) {
  console.log('\nSINOV rejimi — baza o\'zgartirilmadi. Bajarish: --apply\n');
  process.exit(0);
}

let done = 0;
for (const id of toFix) {
  await rest('PATCH', `calls?id=eq.${id}&duration=eq.0`, { duration: original.get(id) });
  done++;
  if (done % 10 === 0 || done === toFix.length) process.stdout.write(`\r  ... ${done}/${toFix.length}`);
}
console.log(`\n\nTAYYOR: ${done} qatorda davomiylik tiklandi.\n`);
