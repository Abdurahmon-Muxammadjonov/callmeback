// Gemini STT javobini tozalash (normalizeSegments) — 2026-10-15.
// Dashboard (CallDetail) va GPT tahlili (withTimeCodes) segmentlarni
// {speaker, start, end, text} shaklida o'qiydi; bu testlar shaklni qotiradi.

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSegments } from './geminiStt';
import { withTimeCodes } from './audio-pipeline';

test("rol bo'yicha: S — SPEAKER_00 (sotuvchi), M — SPEAKER_01 (mijoz), tartib vaqt bo'yicha", () => {
  const segs = normalizeSegments({
    segments: [
      { speaker: 'S', start: 3, end: 4, text: 'Assalomu alaykum, men Farida' },
      { speaker: 'M', start: 1, end: 2, text: 'Alo' },
    ],
  });
  assert.deepEqual(segs.map((s) => s.text), ['Alo', 'Assalomu alaykum, men Farida']);
  assert.equal(segs[0].speaker, 'SPEAKER_01');
  assert.equal(segs[0].role, 'client');
  assert.equal(segs[1].speaker, 'SPEAKER_00');
  assert.equal(segs[1].role, 'seller');
});

test("rolsiz belgilar (A/B) vaqt tartibida keyingi raqamlarni oladi, role yo'q", () => {
  const segs = normalizeSegments({ segments: [{ speaker: 'B', start: 1, end: 2, text: 'bir' }, { speaker: 'A', start: 3, end: 4, text: 'ikki' }] });
  assert.equal(segs[0].speaker, 'SPEAKER_02');
  assert.equal(segs[1].speaker, 'SPEAKER_03');
  assert.equal(segs[0].role, undefined);
});

test("bo'sh matnli segmentlar tashlanadi, bo'shliqlar siqiladi", () => {
  const segs = normalizeSegments({ segments: [{ speaker: 'A', start: 0, end: 1, text: '   ' }, { speaker: 'A', start: 1, end: 2, text: ' ha   ha ' }] });
  assert.equal(segs.length, 1);
  assert.equal(segs[0].text, 'ha ha');
});

test("noto'g'ri vaqtlar tuzatiladi va audio uzunligidan oshmaydi", () => {
  const segs = normalizeSegments(
    { segments: [{ speaker: 'A', start: -5, end: 'x', text: 'bir' }, { speaker: 'B', start: 500, end: 900, text: 'ikki' }] },
    60,
  );
  assert.equal(segs[0].start, 0);
  assert.equal(segs[0].end, 0);
  assert.equal(segs[1].start, 65); // 60 + 5 soniya zaxira
  assert.equal(segs[1].end, 65);
});

test("segments yo'q yoki noto'g'ri shakl — bo'sh ro'yxat", () => {
  assert.deepEqual(normalizeSegments(null), []);
  assert.deepEqual(normalizeSegments({ text: 'salom' }), []);
  assert.deepEqual(normalizeSegments({ segments: [] }), []);
});

test("withTimeCodes Gemini rolini ishlatadi: birinchi \"Alo\" degan mijoz — Mijoz", () => {
  const segs = normalizeSegments({
    segments: [
      { speaker: 'M', start: 26.5, end: 27.6, text: 'Alo?' },
      { speaker: 'S', start: 28, end: 29.6, text: 'Assalomu alaykum, men Farida.' },
    ],
  });
  assert.equal(withTimeCodes('', segs), '[00:27] Mijoz: Alo?\n[00:28] Sotuvchi: Assalomu alaykum, men Farida.');
});

test('withTimeCodes rolsiz (sales-ai) segmentlarda eski taxmin: birinchi gapirgan — Sotuvchi', () => {
  const segs = [
    { speaker: 'SPEAKER_00', start: 1, text: 'Alo' },
    { speaker: 'SPEAKER_01', start: 2, text: 'Salom' },
  ];
  assert.equal(withTimeCodes('', segs), '[00:01] Sotuvchi: Alo\n[00:02] Mijoz: Salom');
});
