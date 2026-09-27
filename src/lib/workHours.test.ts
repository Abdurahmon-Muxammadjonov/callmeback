// Toshkent kuni helperlari testlari.
//
// NEGA BU TEST BOR: 2026-09-27 da kunlik limit ozodligi status belgisiga
// tayanardi, lekin navbat status'ni 'processing'ga o'zgartirib belgini
// o'chirib tashlardi — 49 ta qo'ng'iroq yana "Kunlik limitdan oshdi"
// bo'lib qaytdi. Chidamli zaxira sifatida "bugungi kun emasmi?" tekshiruvi
// qo'shildi; shu tekshiruv aniq ishlashi kerak.

import test from 'node:test';
import assert from 'node:assert/strict';

import { tashkentDayKey, isTodayTashkent } from './workHours';

test('tashkentDayKey UTC+5 ga ko\'ra kunni beradi', () => {
  // 2026-09-27 18:30 UTC = 2026-09-27 23:30 Toshkent — hali o'sha kun.
  assert.equal(tashkentDayKey(new Date('2026-09-27T18:30:00Z')), '2026-09-27');
  // 2026-09-27 19:30 UTC = 2026-09-28 00:30 Toshkent — keyingi kun.
  assert.equal(tashkentDayKey(new Date('2026-09-27T19:30:00Z')), '2026-09-28');
  // Kun boshi: 2026-09-26 19:00 UTC = 2026-09-27 00:00 Toshkent.
  assert.equal(tashkentDayKey(new Date('2026-09-26T19:00:00Z')), '2026-09-27');
});

test('isTodayTashkent o\'tgan kunni BUGUN demaydi', () => {
  const now = new Date('2026-09-27T11:00:00Z'); // 16:00 Toshkent, 27-sen
  // Aynan shu nosozlik davridagi qo'ng'iroqlar — ular BUGUN emas.
  assert.equal(isTodayTashkent('2026-09-25T10:20:25Z', now), false);
  assert.equal(isTodayTashkent('2026-09-26T11:03:50Z', now), false);
  assert.equal(isTodayTashkent('2026-09-24T14:19:13Z', now), false);
});

test('isTodayTashkent bugungi qo\'ng\'iroqni BUGUN deydi', () => {
  const now = new Date('2026-09-27T11:00:00Z'); // 16:00 Toshkent
  assert.equal(isTodayTashkent('2026-09-27T05:49:40Z', now), true, 'ertalab 10:49 Toshkent');
  assert.equal(isTodayTashkent('2026-09-26T19:05:00Z', now), true, '00:05 Toshkent — bu ham 27-sen');
  assert.equal(isTodayTashkent('2026-09-27T10:59:00Z', now), true);
});

test('kun chegarasi (23:00 va 00:00 Toshkent) to\'g\'ri ajratiladi', () => {
  const now = new Date('2026-09-27T11:00:00Z'); // 27-sen, 16:00 Toshkent
  // 26-sen 23:59 Toshkent = 26-sen 18:59 UTC -> BUGUN emas.
  assert.equal(isTodayTashkent('2026-09-26T18:59:00Z', now), false);
  // 27-sen 00:00 Toshkent = 26-sen 19:00 UTC -> BUGUN.
  assert.equal(isTodayTashkent('2026-09-26T19:00:00Z', now), true);
});

test('yaroqsiz sana false qaytaradi (xato tashlamaydi)', () => {
  assert.equal(isTodayTashkent('ajabtovur'), false);
  assert.equal(isTodayTashkent(''), false);
});
