// Qisqa qo'ng'iroq qoidasi (2026-10-16): < 60 s saqlanmaydi va AI'ga yuborilmaydi.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isTooShort, minCallSec } from './callPolicy';

test('standart chegara 60 soniya', () => {
  assert.equal(minCallSec(), 60);
  assert.equal(isTooShort(59), true);
  assert.equal(isTooShort(60), false);
  assert.equal(isTooShort(906), false);
});

test("davomiylik noma'lum (0, null, NaN) — qisqa deb hisoblanmaydi (yo'qolmasin)", () => {
  assert.equal(isTooShort(0), false);
  assert.equal(isTooShort(null), false);
  assert.equal(isTooShort(undefined), false);
  assert.equal(isTooShort(Number.NaN), false);
});
