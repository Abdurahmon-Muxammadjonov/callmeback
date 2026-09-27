#!/usr/bin/env node
// ============================================================================
// ERTALABKI TEKSHIRUV (2026-09-27)
//
// Ish kuni boshlangandan keyin quvur sog'lom ishlayotganini bir buyruq
// bilan ko'rsatadi. 24-sentabrdagi nosozlik 3 KUN sezilmadi — shu sabab
// har ertalab bu tekshiruvni o'tkazish kerak.
//
// Ko'rsatadi:
//   - bugun ish boshlangandan keyin kelgan jonli qo'ng'iroqlar va
//     ulardan nechtasi matnga o'girilgan (davomiylik guruhlari bilan);
//   - navbat uzunligi: jonli kutayotganlar va qayta navbatdagilar alohida;
//   - STT sog'lig'i: 'stt_suspect' qatorlar bormi (circuit breaker izi);
//   - oxirgi muvaffaqiyatli transkript qachon olingan.
//
// ISHLATISH: node scripts/morning-check.mjs [--since HH:MM]
// ============================================================================

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);

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

// Ish boshlanishi (Toshkent) -> UTC ISO.
const sinceHm = (() => {
  const i = argv.indexOf('--since');
  return i >= 0 && /^\d{2}:\d{2}$/.test(argv[i + 1] || '') ? argv[i + 1] : '09:00';
})();
const todayTashkent = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tashkent', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());
const sinceIso = new Date(`${todayTashkent}T${sinceHm}:00+05:00`).toISOString();

async function count(filter) {
  const resp = await fetch(`${URL_BASE}/rest/v1/calls?select=id&${filter}`, {
    headers: { ...H, Prefer: 'count=exact', Range: '0-0' },
    signal: AbortSignal.timeout(60_000),
  });
  return Number((resp.headers.get('content-range') || '/0').split('/')[1]) || 0;
}

// QAYTA NAVBATDAGI qatorlarni JONLI hisobdan chiqaramiz. Aks holda
// bugungi sanaga tushgan eski backlog qatorlari "matnga o'girilmagan jonli
// qo'ng'iroq" bo'lib ko'rinadi va xulosa yolg'on "NOSOZ" chiqadi.
const requeuedIds = new Set();
for (const f of readdirSync(ROOT).filter((x) => /^requeue-backup-.*\.json$/.test(x))) {
  for (const r of JSON.parse(readFileSync(path.join(ROOT, f), 'utf8'))) requeuedIds.add(r.id);
}
// DIQQAT: URL uzunligi cheklangani uchun PostgREST filtriga hammasini
// joylay olmaymiz. Shuning uchun jonli hisob "status" bilan ajratiladi
// (requeued qatorlar chiqariladi), id ro'yxati esa faqat ma'lumot uchun.
const excl = '&status=neq.requeued';

const base = `company_id=eq.${COMPANY}&created_at=gte.${sinceIso}${excl}`;

console.log(`\n=== ERTALABKI TEKSHIRUV — ${todayTashkent}, ${sinceHm} dan beri (Toshkent) ===`);
if (requeuedIds.size) {
  console.log(`(qayta navbatdagi ${requeuedIds.size} qator jonli hisobdan chiqarildi)`);
}
console.log('');

// 1) Bugungi jonli qo'ng'iroqlar, davomiylik guruhlari bo'yicha.
console.log('JONLI QO\'NG\'IROQLAR (bugun, qayta navbatdagilar hisobga olinmaydi):');
const groups = [[0, 15], [15, 62], [62, 90], [90, 100000]];
const labels = [
  '0-15s (javobsiz)',
  '15-62s (jiringlash ham shunda)',
  '62-90s',
  '90s+ (haqiqiy suhbat)',
];
let liveTotal = 0, liveText = 0;
for (const [i, [lo, hi]] of groups.entries()) {
  const f = `${base}&duration=gte.${lo}&duration=lt.${hi}`;
  const [tot, txt] = await Promise.all([count(f), count(`${f}&transcript=not.is.null`)]);
  liveTotal += tot; liveText += txt;
  const pct = tot ? `${(100 * txt / tot).toFixed(0)}%` : '—';
  console.log(`  ${labels[i].padEnd(30)} ${String(tot).padStart(5)} ta,  matnli ${String(txt).padStart(5)}  (${pct})`);
}
const [scored] = await Promise.all([count(`${base}&kpi_score=gt.0`)]);
console.log(`  ${'JAMI'.padEnd(30)} ${String(liveTotal).padStart(5)} ta,  matnli ${String(liveText).padStart(5)}`);
console.log(`  ${'ballangan (kpi>0)'.padEnd(30)} ${String(scored).padStart(5)} ta`);

// 2) Navbat uzunligi.
const qBase = `company_id=eq.${COMPANY}&audio_url=not.is.null&transcript=is.null`;
const [liveWaiting, requeued, processing, suspect, failed] = await Promise.all([
  count(`${qBase}&status=neq.done&status=neq.requeued&created_at=gte.${sinceIso}`),
  count(`company_id=eq.${COMPANY}&status=eq.requeued`),
  count(`company_id=eq.${COMPANY}&status=eq.processing`),
  count(`company_id=eq.${COMPANY}&status=eq.stt_suspect`),
  count(`company_id=eq.${COMPANY}&status=eq.failed`),
]);
console.log('\nNAVBAT:');
console.log(`  bugungi jonli kutayotgan : ${liveWaiting}`);
console.log(`  qayta navbatdagi (eski)  : ${requeued}`);
console.log(`  ayni vaqtda ishlanmoqda  : ${processing}`);
console.log(`  xato (qayta urinadi)     : ${failed}`);

// 3) STT sog'ligi.
console.log('\nSTT SOG\'LIGI:');
console.log(`  'stt_suspect' qatorlar : ${suspect}  ${suspect > 0 ? '<-- CIRCUIT BREAKER ISHGA TUSHGAN' : '(toza)'}`);

// DIQQAT: bazada updated_at ustuni yo'q, shuning uchun "oxirgi
// muvaffaqiyat" QO'NG'IROQ VAQTI bo'yicha olinadi. Eski backlog qayta
// ishlanayotganda bu ko'rsatkich adashtiradi — shu sabab faqat BUGUNGI
// jonli qo'ng'iroqlar ichidan olinadi.
const lastOk = await fetch(
  `${URL_BASE}/rest/v1/calls?select=created_at,duration&${base}`
  + '&transcript=not.is.null&order=created_at.desc&limit=1',
  { headers: H, signal: AbortSignal.timeout(60_000) },
).then((r) => r.json());
if (lastOk?.[0]) {
  const at = new Date(lastOk[0].created_at);
  const minsAgo = Math.round((Date.now() - at.getTime()) / 60_000);
  const local = at.toLocaleString('en-GB', { timeZone: 'Asia/Tashkent' });
  console.log(`  bugungi oxirgi matnli qo'ng'iroq: ${local} (${minsAgo} daqiqa oldin)`);
} else {
  console.log('  bugun hali birorta jonli qo\'ng\'iroq matnga o\'girilmagan');
}

// 4) Xulosa.
// XULOSA 90 SONIYADAN UZUNLAR bo'yicha. Nega 60 emas: UTel liniyasi
// AYNAN 60 soniya jiringlab uzadi (ext 5200 da o'lchandi: 61s audio,
// 17 sukunat bo'lagi, nutq yo'q). Bunday qo'ng'iroqda bo'sh matn TO'G'RI
// natija, shuning uchun ular xulosaga kirmasligi kerak.
const live60 = await count(`${base}&duration=gte.90`);
const live60text = await count(`${base}&duration=gte.90&transcript=not.is.null`);
const live60pending = await count(`${base}&duration=gte.90&transcript=is.null&status=neq.done`);
console.log('\nXULOSA:');
if (live60 === 0) {
  console.log('  Bugun hali 90 soniyadan uzun jonli qo\'ng\'iroq kelmagan — baho berish erta.');
} else if (live60pending === live60) {
  console.log(`  ${live60} ta 90s+ qo'ng'iroq hali navbatda — natija kutilmoqda, baho berish erta.`);
} else {
  const pct = 100 * live60text / live60;
  const verdict = pct >= 90 ? 'SOG\'LOM' : pct >= 60 ? 'SHUBHALI' : 'NOSOZ';
  console.log(`  90s+ qo'ng'iroqlarning ${pct.toFixed(0)}% i matnga o'girilgan -> ${verdict}`);
  console.log('  (normal kunda 99.6%, nosozlik davrida 11.6% edi)');
}
console.log('');
