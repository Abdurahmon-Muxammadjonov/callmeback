// Sifatsiz lid sabablari toifalarga yig'iladi (2026-10-16).
import test from 'node:test';
import assert from 'node:assert/strict';
import { leadReasonCategory } from './leadReasons';

test("bir xil sababning turli yozilishi bitta toifaga", () => {
  for (const s of ['Mijoz qiziqish bildirmadi', 'Qiziqish bildirmadi', 'mijoz qiziqish bildirmadi']) {
    assert.equal(leadReasonCategory(s), 'Qiziqish bildirmadi');
  }
});

test("ko'tarmadi / noto'g'ri raqam / suhbat uzildi", () => {
  assert.equal(leadReasonCategory("Qo'ng'iroqni ko'tarmadi"), "Qo'ng'iroqni ko'tarmadi");
  assert.equal(leadReasonCategory('Noto‘g‘ri raqam'), "Noto'g'ri raqam");
  assert.equal(leadReasonCategory("Suhbat umuman bo'lmagan"), "Suhbat bo'lmadi / uzildi");
  assert.equal(leadReasonCategory('Mijoz qiziqish bildirmadi va suhbatni tugatdi'), 'Qiziqish bildirmadi');
  assert.equal(leadReasonCategory('Mijoz suhbatni davom ettirmadi'), "Suhbat bo'lmadi / uzildi");
});

test("boshqa joyda o'qiydi va aniq muloqot bo'lmadi", () => {
  assert.equal(leadReasonCategory('Mijoz boshqa kursga yozilgan'), "Boshqa joyda o'qiydi");
  assert.equal(leadReasonCategory('Mijoz boshqa joyga yozilgan'), "Boshqa joyda o'qiydi");
  assert.equal(leadReasonCategory("Suhbatda aniq muloqot bo'lmadi"), "Suhbat bo'lmadi / uzildi");
  assert.equal(leadReasonCategory('Suhbat davom ettirilmagan'), "Suhbat bo'lmadi / uzildi");
});

test("toifaga tushmagani o'z matni bilan, bo'sh — Sabab yozilmagan", () => {
  assert.equal(leadReasonCategory('ota-onasi bilan maslahatlashadi'), 'Ota-onasi bilan maslahatlashadi');
  assert.equal(leadReasonCategory('  '), 'Sabab yozilmagan');
});
