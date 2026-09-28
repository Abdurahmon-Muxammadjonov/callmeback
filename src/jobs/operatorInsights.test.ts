// Tavsiya uzunligini boshqarish testlari (§10: har tavsiya <= 90 belgi).
//
// NEGA: jonli sinovda 11 operatordan 5 tasi tavsiyasiz qoldi, chunki zod
// schema'sida .max(90) bor edi va model bitta uzun gap yozsa BUTUN javob
// rad etilardi. Tavsiyasiz qolgandan ko'ra qisqartirilgani yaxshiroq.

import test from 'node:test';
import assert from 'node:assert/strict';

import { trimTip } from './operatorInsights';

test('chegaraga sig\'adigan matnga TEGILMAYDI', () => {
  const short = 'Suhbat oxirida probniyga taklif qiling: shanba 10 mi, 14 mi?';
  assert.equal(trimTip(short), short);
  assert.ok(short.length <= 90);
});

test('uzun matn SO\'Z chegarasida qisqartiriladi', () => {
  const long = 'Har bir suhbat oxirida mijozga bepul probniy darsga kelishni taklif qiling va unga aniq vaqt varianti bering';
  const out = trimTip(long);
  assert.ok(out.length <= 90, `uzunlik ${out.length}`);
  assert.ok(out.endsWith('…'), 'qisqartirilgani ko\'rinib tursin');
  // So'z o'rtasidan kesilmasin: oxirgi belgidan oldin bo'sh joy bo'lmasligi,
  // lekin kesilgan joy butun so'z bo'lishi kerak.
  const body = out.slice(0, -1);
  assert.ok(long.startsWith(body), 'asl matnning boshlanishi saqlansin');
  assert.ok(!body.endsWith(' '), 'oxirida bo\'sh joy qolmasin');
});

test('bo\'sh joysiz juda uzun so\'z ham chegaraga sig\'adi', () => {
  const out = trimTip('a'.repeat(200));
  assert.ok(out.length <= 90, `uzunlik ${out.length}`);
});

test('chegara aniq: 90 tegilmaydi, 91 qisqaradi', () => {
  const at90 = 'x'.repeat(90);
  assert.equal(trimTip(at90), at90);
  assert.ok(trimTip('x'.repeat(91)).length <= 90);
});
