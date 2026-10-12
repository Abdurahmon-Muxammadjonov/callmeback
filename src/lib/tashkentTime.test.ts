// Toshkent kun/hafta/oy chegaralari — kunlik son "sakrashi" xatosining
// ildizi shu yerda edi (UTC va Toshkent aralash ishlatilgan). 2026-10-12.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays, mondayOf, monthStartOf, minusMonthsTashkent, parseTashkentLocal,
  tashkentDay, tashkentDayStart,
} from './tashkentTime';
import { popRanges } from './reportBuilders';

test('Toshkent tunidagi qo\'ng\'iroq UTC kechasi bo\'lsa ham Toshkent kuniga tushadi', () => {
  // 2026-10-12 20:30 UTC = 2026-10-13 01:30 Toshkent
  assert.equal(tashkentDay(new Date('2026-10-12T20:30:00Z')), '2026-10-13');
  assert.equal(tashkentDayStart('2026-10-13').toISOString(), '2026-10-12T19:00:00.000Z');
});

test('hafta dushanbadan, oy 1-kundan', () => {
  assert.equal(mondayOf('2026-10-13'), '2026-10-12'); // seshanba -> dushanba
  assert.equal(mondayOf('2026-10-12'), '2026-10-12'); // dushanba o'zi
  assert.equal(mondayOf('2026-10-18'), '2026-10-12'); // yakshanba -> o'sha haftaning dushanbasi
  assert.equal(monthStartOf('2026-10-13'), '2026-10-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

test('"1 oy oldin" Toshkent devor soati bo\'yicha va oy oxirida qisqartiriladi', () => {
  // 31-mart 15:00 Toshkent -> 28-fevral 15:00 Toshkent (eski setUTCMonth 3-martni berardi)
  assert.equal(minusMonthsTashkent(new Date('2026-03-31T10:00:00Z'), 1).toISOString(), '2026-02-28T10:00:00.000Z');
  // 1-aprel 01:00 Toshkent (UTC'da hali 31-mart) -> 1-mart 01:00 Toshkent
  assert.equal(minusMonthsTashkent(new Date('2026-03-31T20:00:00Z'), 1).toISOString(), '2026-02-28T20:00:00.000Z');
  // Kabisa yil
  assert.equal(minusMonthsTashkent(new Date('2028-03-30T07:00:00Z'), 1).toISOString(), '2028-02-29T07:00:00.000Z');
});

test('PoP oynalari Toshkent kuni/haftasi/oyi bo\'yicha', () => {
  const now = new Date('2026-10-12T20:30:00Z'); // 13-oktabr 01:30 Toshkent, seshanba
  const r = popRanges(now);
  assert.equal(r[0].from.toISOString(), '2026-10-12T19:00:00.000Z'); // bugun 00:00
  assert.equal(r[0].to!.toISOString(), '2026-10-13T19:00:00.000Z');  // ertaga 00:00 (chegara)
  assert.equal(r[1].from.toISOString(), '2026-10-11T19:00:00.000Z'); // kecha 00:00
  assert.equal(r[1].to!.toISOString(), '2026-10-11T20:30:00.000Z');  // kecha shu vaqtgacha
  assert.equal(r[2].from.toISOString(), '2026-10-11T19:00:00.000Z'); // dushanba 12-okt 00:00
  assert.equal(r[2].to!.toISOString(), '2026-10-18T19:00:00.000Z');   // keyingi dushanba
  assert.equal(r[4].from.toISOString(), '2026-09-30T19:00:00.000Z'); // 1-oktabr 00:00
  assert.equal(r[4].to!.toISOString(), '2026-10-31T19:00:00.000Z');   // 1-noyabr 00:00
  assert.equal(r[5].from.toISOString(), '2026-08-31T19:00:00.000Z'); // 1-sentabr 00:00
  assert.equal(r[5].to!.toISOString(), '2026-09-12T20:30:00.000Z');  // 13-sentabr 01:30
});

test('parseTashkentLocal: UTel date_time zonasiz Toshkent vaqti', () => {
  assert.equal(parseTashkentLocal('2026-10-12 20:17:00')!.toISOString(), '2026-10-12T15:17:00.000Z');
  assert.equal(parseTashkentLocal('2026-10-12T20:17')!.toISOString(), '2026-10-12T15:17:00.000Z');
  assert.equal(parseTashkentLocal('2026-10-12T15:17:00Z')!.toISOString(), '2026-10-12T15:17:00.000Z');
  assert.equal(parseTashkentLocal(''), null);
  assert.equal(parseTashkentLocal('kecha'), null);
  assert.equal(parseTashkentLocal(1760280000), null);
});
