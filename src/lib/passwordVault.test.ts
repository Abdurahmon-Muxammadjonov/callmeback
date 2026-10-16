// Xodim parolining shifrlangan nusxasi (2026-10-16).
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.WEBHOOK_SECRET_ENC_KEY = 'a'.repeat(64);
// Kalit har chaqiruvda env'dan o'qiladi; require — loyiha CommonJS (sttHealth.test.ts dagidek).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { encryptPassword, decryptPassword } = require('./passwordVault') as typeof import('./passwordVault');

test('shifrlash -> ochish asl parolni qaytaradi, ochiq matn ko\'rinmaydi', () => {
  const enc = encryptPassword('parol777')!;
  assert.ok(enc && !enc.includes('parol777'));
  assert.equal(decryptPassword(enc), 'parol777');
});

test('har safar boshqa shifr (tasodifiy iv)', () => {
  assert.notEqual(encryptPassword('12345678'), encryptPassword('12345678'));
});

test("buzilgan yoki bo'sh qiymat — null (xato tashlamaydi)", () => {
  assert.equal(decryptPassword('abc.def.ghi'), null);
  assert.equal(decryptPassword(null), null);
});

test("kalit yo'q — shifrlanmaydi, null", () => {
  const saved = process.env.WEBHOOK_SECRET_ENC_KEY;
  delete process.env.WEBHOOK_SECRET_ENC_KEY;
  assert.equal(encryptPassword('x'), null);
  process.env.WEBHOOK_SECRET_ENC_KEY = saved;
});
