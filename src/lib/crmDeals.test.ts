import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyStage, cleanManagerName, leadMoney, phone9, pipelineFlags } from './crmDeals';

// JAMALS voronkalari (amoCRM, 2026-10-20) — nomlar aslidagidek.
const MARIFAT = ['Неразобранное', 'Yangi lid', 'Taqsimlandi', 'Hisob raqam yuborildi', 'Predoplata qildi', "Shartnoma asosida qo'shildi", "To'liq to'lov qildi", 'Chek tekshirildi', "Platformaga qo'shildi", 'Lost'];
const OFFLINE = ['Неразобранное', 'PROBNIYGA KELDI', 'SHARTNOMA BERILDI', 'HISOB RAQAM YUBORILDI', "BRON TO'LOV QILDI", "OKTABR | TO'LIQ TO'LOV QILDI", "O'QIMAYDIGAN BO'LDI", 'Успешно реализовано', 'Закрыто и не реализовано'];
const ADAPT = ['Неразобранное', 'ISHGA OLINDI', "KO'TARMADI", 'Успешно реализовано', 'Закрыто и не реализовано'];

const kind = (names: string[], statusName: string, statusId = 1, price = 0) =>
  classifyStage({ statusId, statusName, ...pipelineFlags(names), price });

test('chek bosqichi bor voronka: to\'liq to\'lov — chek tekshirilgandan keyin', () => {
  assert.equal(kind(MARIFAT, "To'liq to'lov qildi"), 'pending');
  assert.equal(kind(MARIFAT, 'Chek tekshirildi'), 'full');
  assert.equal(kind(MARIFAT, "Platformaga qo'shildi", 142), 'full');
  assert.equal(kind(MARIFAT, 'Predoplata qildi'), 'partial');
  assert.equal(kind(MARIFAT, "Shartnoma asosida qo'shildi"), 'partial');
  assert.equal(kind(MARIFAT, 'Hisob raqam yuborildi'), 'none');
  assert.equal(kind(MARIFAT, 'Lost', 143), 'lost');
});

test('chek bosqichi yo\'q voronka: to\'liq to\'lov darhol to\'liq', () => {
  assert.equal(kind(OFFLINE, "OKTABR | TO'LIQ TO'LOV QILDI"), 'full');
  assert.equal(kind(OFFLINE, "BRON TO'LOV QILDI"), 'partial');
  assert.equal(kind(OFFLINE, "O'QIMAYDIGAN BO'LDI"), 'none');
  assert.equal(kind(OFFLINE, 'SHARTNOMA BERILDI'), 'none');
});

test('boshqa to\'lov nomlari', () => {
  const Z = ['PREDOPLATA', '30% + TO\'LOV QILGANLAR', '50% + TO\'LOV QILGANLAR', "TO'LIQ TO'LOV QILDI", 'CHEK TEKSHIRILDI'];
  assert.equal(kind(Z, "30% + TO'LOV QILGANLAR"), 'partial');
  assert.equal(kind(Z, 'PRE-PEY'), 'none'); // lid magnit bosqichi — to'lov emas
  assert.equal(kind(['CHEGIRMA OLGAN | 10-25-50% |'], 'CHEGIRMA OLGAN | 10-25-50% |'), 'none');
  assert.equal(kind(['TO"LIQ TO"LOV QILDI'], 'TO"LIQ TO"LOV QILDI'), 'full');
  assert.equal(kind(["BO'LIB TO'LAYDI"], "BO'LIB TO'LAYDI"), 'partial');
});

test('to\'lov bosqichi yo\'q voronkada yutuq faqat summa bo\'lsa', () => {
  assert.equal(kind(ADAPT, 'Успешно реализовано', 142, 0), 'none');
  assert.equal(kind(ADAPT, 'Успешно реализовано', 142, 500000), 'full');
});

test('pul maydonlari: Бюджет = to\'langan, Qarzdorlik = qarz', () => {
  const f = (deal: number | null, debt: number | null) => [
    ...(deal != null ? [{ field_name: 'Kelishuv Summasi', values: [{ value: deal }] }] : []),
    ...(debt != null ? [{ field_name: 'Qarzdorlik', values: [{ value: debt }] }] : []),
    { field_name: "To'lov turi", values: [{ value: 'Click' }] },
  ];
  assert.deepEqual(leadMoney(16_100_000, f(33_072_000, 16_972_000)), { dealSum: 33_072_000, debt: 16_972_000, payType: 'Click' });
  // Kelishuv yo'q — Qarzdorlik manfiy (−to'langan): qarz hisoblanmaydi.
  assert.equal(leadMoney(4_800_000, f(null, -4_800_000)).debt, 0);
  // Qarzdorlik maydoni yo'q — kelishuv − to'langan.
  assert.equal(leadMoney(1_000_000, f(3_000_000, null)).debt, 2_000_000);
  assert.equal(leadMoney(26_400_000, f(26_400_000, 0)).debt, 0);
});

test('telefon va menejer nomi', () => {
  assert.equal(phone9('+998 (90) 123-45-67'), '901234567');
  assert.equal(phone9('12345'), null);
  assert.equal(cleanManagerName('Menejer 10 | Diyorbek'), 'Diyorbek');
  assert.equal(cleanManagerName('Manager | Dilafruz'), 'Dilafruz');
  assert.equal(cleanManagerName('Asosiy |  Admin'), 'Asosiy |  Admin');
  assert.equal(cleanManagerName(null), null);
});
