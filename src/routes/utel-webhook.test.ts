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
