// Arzimas "muhim lahza"larni filtrlash testi.
//
// NEGA: promptda taqiq bor, lekin jonli sinovda model baribir
// "Operator o'zini tanishtirdi" yozdi. Prompt — maslahat, filtr — kafolat.
//
// Filtr TOR bo'lishi shart: narx muhokamasi, e'tiroz, rozilik va operator
// xatosi KERAKLI lahzalar va ular hech qachon tashlanmasligi kerak.

import test from 'node:test';
import assert from 'node:assert/strict';

import { isTrivialMoment } from './audio-pipeline';

test('har suhbatda bo\'ladigan arzimas lahzalar TASHLANADI', () => {
  const trivial = [
    'Salomlashish',
    'Salomlashish va tanishtirish',
    'Operator o\'zini tanishtirdi',
    'Operator o’zini tanishtirdi',      // egri apostrof
    'Tanishtirish',
    'Suhbat boshlandi',
    'Suhbat tugadi',
    'Suhbat yakunlandi',
    'Qo\'ng\'iroq tugadi',
    'Mijoz javob berdi',
    'Mijoz o\'z fikrlarini bildirdi',
    'Xayrlashuv',
  ];
  for (const label of trivial) {
    assert.equal(isTrivialMoment(label), true, `"${label}" tashlanishi kerak`);
  }
});

test('QARORGA TA\'SIR QILGAN lahzalar SAQLANADI', () => {
  const keep = [
    'Mijoz narxni qimmat deb aytdi',
    'Operator narxlar haqida ma\'lumot berdi',   // narx muhokamasi — kerak
    'Mijoz probniy darsga kelishga rozi bo\'ldi',
    'Mijoz arizasini o\'chirishni so\'radi',
    'Operator savolga javob bera olmadi',
    'Mijoz telefon raqamini berdi',
    'Shanba 14:00 ga kelishildi',
    'Operator mijozning gapini bo\'ldi',
    'Mijoz hali tayyor emasligini bildirdi',
    'Mijoz boshqa markazda arzonroq ekanini aytdi',
  ];
  for (const label of keep) {
    assert.equal(isTrivialMoment(label), false, `"${label}" SAQLANISHI kerak`);
  }
});
