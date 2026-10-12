// UTel qo'ng'iroq'i qaysi kunga yoziladi (calls.created_at). 2026-10-12.
//
// NEGA: avval created_at = INSERT vaqti edi — webhook kech kelsa qo'ng'iroq
// boshqa kunga tushib, kunlik son vaqt o'tib o'zgarardi.

import test from 'node:test';
import assert from 'node:assert/strict';
import { utelCallStartedAt } from './utel-webhook';

const NOW = Date.parse('2026-10-12T15:30:00Z');

test('created_at = call_history.date_time (Toshkent, zonasiz)', () => {
  assert.equal(utelCallStartedAt({ date_time: '2026-10-12 20:17:00' }, NOW), '2026-10-12T15:17:00.000Z');
});

test('webhook bir necha soat kech kelsa ham qo\'ng\'iroq o\'z kunida qoladi', () => {
  // Kecha 23:50 Toshkentda boshlangan, bugun kelgan webhook — KECHAGI kun.
  assert.equal(utelCallStartedAt({ date_time: '2026-10-11 23:50:00' }, NOW), '2026-10-11T18:50:00.000Z');
});

test('date_time yo\'q yoki ishonchsiz bo\'lsa — hozirgi vaqt', () => {
  const now = new Date(NOW).toISOString();
  assert.equal(utelCallStartedAt({}, NOW), now);
  assert.equal(utelCallStartedAt(null, NOW), now);
  assert.equal(utelCallStartedAt({ date_time: 'xato' }, NOW), now);
  // Kelajakdagi vaqt (soat noto'g'ri) — qabul qilinmaydi.
  assert.equal(utelCallStartedAt({ date_time: '2026-10-13 09:00:00' }, NOW), now);
});

// ----------------------------------------------------------------------------
// Navbat so'rovlari partial indeksga mos (supabase/perf_11_utel_queue_index.sql).
// Shartlar AYNAN bir xil bo'lmasa Postgres indeksni ishlatmaydi va har ~8
// soniyada butun calls jadvalini skanerlaydi.
// ----------------------------------------------------------------------------
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname ?? __dirname, '..', '..');
const webhookSrc = readFileSync(path.join(ROOT, 'src/routes/utel-webhook.ts'), 'utf8');
const indexSql = readFileSync(path.join(ROOT, 'supabase/perf_11_utel_queue_index.sql'), 'utf8');

test('partial indeks predikati navbat shartlari bilan bir xil', () => {
  assert.match(indexSql, /where status <> 'done' and audio_url ilike '%utel%'/);
  for (const fn of ['async function runQueueOnce', 'async function countWaiting', 'async function probeOnce']) {
    const start = webhookSrc.indexOf(fn);
    assert.ok(start >= 0, `${fn} topilmadi`);
    const body = webhookSrc.slice(start, start + 3500);
    assert.ok(body.includes(".neq('status', 'done')"), `${fn}: .neq('status', 'done') bo'lishi kerak`);
    assert.ok(body.includes(".ilike('audio_url', '%utel%')"), `${fn}: .ilike('audio_url', '%utel%') bo'lishi kerak`);
  }
});

test('navbatning "matni bor" so\'rovi transkript matnini tortmaydi', () => {
  const start = webhookSrc.indexOf('async function runQueueOnce');
  const body = webhookSrc.slice(start, webhookSrc.indexOf('.limit(BATCH * 5)', start));
  assert.ok(body.includes(".select('id, company_id, status')"));
  assert.ok(!/select\('[^']*transcript/.test(body), 'pending so\'rovida transcript ustuni bo\'lmasin');
});
