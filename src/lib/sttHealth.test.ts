// STT circuit breaker testlari.
//
// Ishga tushirish: npm test
//
// Modul sozlamalarni IMPORT paytida o'qiydi, shuning uchun env
// o'zgaruvchilari dinamik import'dan OLDIN o'rnatiladi.

import test from 'node:test';
import assert from 'node:assert/strict';

process.env.STT_HEALTH_WINDOW = '10';
process.env.STT_EMPTY_THRESHOLD = '0.7';
process.env.STT_HEALTH_MIN_DURATION_SEC = '20';

// DIQQAT: `import` iboralari ko'tariladi (hoisted), shuning uchun yuqoridagi
// env qiymatlari ta'sir qilishi uchun modul require() bilan olinadi.
// Loyiha CommonJS'ga kompilyatsiya qilinadi, ya'ni bu ishlaydi.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const health = require('./sttHealth') as typeof import('./sttHealth');
const { recordOutcome, isPaused, resetHealthForTest, countsTowardHealth, healthSnapshot } = health;

/** N ta natijani ketma-ket qayd etadi (davomiylik standart 60s). */
function feed(outcomes: boolean[], durationSec = 60): void {
  for (const empty of outcomes) recordOutcome(empty, durationSec);
}

test('bo\'sh javoblar ketma-ketligida pauza YOQILADI', () => {
  resetHealthForTest();
  feed(Array(10).fill(true));
  assert.equal(isPaused(), true, '10 tadan 10 tasi bo\'sh — pauza yoqilishi kerak');
  assert.equal(healthSnapshot().emptyRatio, 1);
});

test('oyna to\'lmaguncha pauza yoqilmaydi', () => {
  resetHealthForTest();
  feed(Array(9).fill(true));
  assert.equal(isPaused(), false, '9 ta namuna (oyna 10) — hali qaror qabul qilinmaydi');
  recordOutcome(true, 60);
  assert.equal(isPaused(), true, '10-chi namunadan keyin yoqiladi');
});

test('normal kun darajasi (20% bo\'sh) pauza YOQMAYDI', () => {
  resetHealthForTest();
  // 23-sentabrdagi haqiqiy daraja: ≥20s qo'ng'iroqlarning 19.7% i bo'sh.
  feed([true, true, false, false, false, false, false, false, false, false]);
  assert.equal(isPaused(), false, '20% bo\'sh — bu normal, pauza bo\'lmasin');
  assert.equal(healthSnapshot().emptyRatio, 0.2);
});

test('chegara aynan 70% da yoqiladi, 60% da yoqilmaydi', () => {
  // DIQQAT: qaror FAQAT bo'sh natija kelganda qayta baholanadi —
  // muvaffaqiyatli natija hech qachon pauza yoqmasligi kerak. Shuning
  // uchun bo'shlar oxirida turadi.
  resetHealthForTest();
  feed([...Array(4).fill(false), ...Array(6).fill(true)]);
  assert.equal(healthSnapshot().emptyRatio, 0.6);
  assert.equal(isPaused(), false, '60% — chegaradan past');

  resetHealthForTest();
  feed([...Array(3).fill(false), ...Array(7).fill(true)]);
  assert.equal(healthSnapshot().emptyRatio, 0.7);
  assert.equal(isPaused(), true, '70% — chegaraga yetdi');
});

test('muvaffaqiyatli natija hech qachon pauza yoqmaydi', () => {
  resetHealthForTest();
  // Oyna 70% bo'shdan iborat, lekin oxirgi natija muvaffaqiyatli.
  feed([...Array(7).fill(true), ...Array(3).fill(false)]);
  assert.equal(isPaused(), false, 'oxirgi natija matn bergan — xizmat tirik');
});

test('qisqa qo\'ng\'iroqlar sog\'liq o\'lchoviga KIRMAYDI', () => {
  resetHealthForTest();
  assert.equal(countsTowardHealth(19), false);
  assert.equal(countsTowardHealth(20), true);

  feed(Array(30).fill(true), 5); // 5 soniyalik javobsizlar
  assert.equal(isPaused(), false, 'haqiqiy javobsiz qisqa qo\'ng\'iroqlar pauza yoqmasligi kerak');
  assert.equal(healthSnapshot().samples, 0);
});

test('tiklanganda pauza O\'CHADI va oyna tozalanadi', () => {
  resetHealthForTest();
  feed(Array(10).fill(true));
  assert.equal(isPaused(), true, 'avval pauza yoqilsin');

  recordOutcome(false, 60); // matn keldi
  assert.equal(isPaused(), false, 'matn kelishi bilan pauza ochilishi kerak');
  assert.equal(healthSnapshot().samples, 0, 'oyna tozalanishi kerak');
});

test('tiklangandan keyin yana buzilsa — qaytadan yoqiladi', () => {
  resetHealthForTest();
  feed(Array(10).fill(true));
  recordOutcome(false, 60);
  assert.equal(isPaused(), false);

  feed(Array(10).fill(true));
  assert.equal(isPaused(), true, 'ikkinchi uzilishda ham ishlashi kerak');
});

test('pauza yoqilgan chaqiruv true qaytaradi, keyingilari false', () => {
  resetHealthForTest();
  const results = Array(10).fill(true).map(() => recordOutcome(true, 60));
  assert.equal(results.filter(Boolean).length, 1, 'faqat bitta chaqiruv "yangi yoqildi" desin');
  assert.equal(results[9], true, 'oxirgisi yoqqan bo\'lsin');
  assert.equal(recordOutcome(true, 60), false, 'allaqachon pauzada — takror yoqilmaydi');
});
