// GET so'rovlari LLM CHAQIRMASLIGI kerak (API v2 §0.4, §6.5).
//
// NEGA BU TEST BOR: /api/analytics/staff-stats har bir operator uchun
// GPT-4o-mini chaqirardi va so'rov 7.4 soniya ketardi. Tuzatilgandan keyin
// ham kimdir buildCoaching()'ni qaytarib qo'yishi mumkin, shuning uchun
// qoida test bilan qulflanadi.
//
// Tekshiruv statik: analytics.ts manba matnida LLM yo'liga olib boradigan
// chaqiruv qolmaganini tasdiqlaydi. Bu integratsiya testisiz ham
// ishonchli, chunki GPT yo'li faqat shu funksiyalar orqali o'tadi.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(import.meta.dirname ?? __dirname, '..');
const readRaw = (rel: string) => readFileSync(path.join(SRC, rel), 'utf8');

/**
 * IZOHLARNI TASHLAB kodni qaytaradi.
 *
 * Nega kerak: kod ichida "ilgari buildCoaching() chaqirilardi" kabi izoh
 * qolishi TABIIY va foydali — u nima uchun olib tashlanganini tushuntiradi.
 * Tekshiruv esa faqat HAQIQIY chaqiruvga qarashi kerak.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')   // /* ... */
    .replace(/(^|[^:])\/\/.*$/gm, '$1');  // // ... (URL'dagi // ga tegmaydi)
}
const read = (rel: string) => stripComments(readRaw(rel));

/** LLM chaqirishga olib keladigan belgilar. */
const LLM_MARKERS = [
  'buildCoaching',          // coaching.ts -> OpenAI chat/completions
  'analyzeWithOpenAi',      // openaiAnalyzer.ts
  'analyzeTranscript',      // audio-pipeline.ts -> GPT yoki Gemini
  'classifyShortCall',      // openaiAnalyzer.ts
  'api.openai.com',
  'generativelanguage',     // Gemini
];

test('analytics.ts (barcha GET endpointlar) LLM chaqirmaydi', () => {
  const src = read('routes/analytics.ts');
  for (const marker of LLM_MARKERS) {
    assert.equal(
      src.includes(marker), false,
      `analytics.ts ichida "${marker}" topildi — GET so'rovi LLM chaqirmasligi kerak (§0.4)`,
    );
  }
});

test('staff-stats tavsiyani operator_insights jadvalidan o\'qiydi', () => {
  const src = readRaw('routes/analytics.ts');
  assert.ok(src.includes("from('operator_insights')"),
    'staff-stats operator_insights jadvalidan o\'qishi kerak');
  assert.ok(src.includes('deriveFaults'),
    'ayblar determinisik deriveFaults() bilan hisoblanishi kerak');
  assert.ok(src.includes('advice_generated_at'),
    'javobda tavsiya qachon tayyorlangani bo\'lishi kerak (UI ko\'rsatadi)');
});

test('deriveFaults va deriveAdvice model chaqirmaydi', async () => {
  const mod = await import('../lib/coaching');
  // Kalitlarni ataylab o'chirib qo'yamiz: chaqiruv bo'lsa xato chiqadi.
  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const stages = [
      { title: 'Probniyga chaqirish', pct: 10 },
      { title: 'Ehtiyojni aniqlash', pct: 55 },
      { title: 'Taqdimot', pct: 95 },
    ];
    const faults = mod.deriveFaults(stages);
    const advice = mod.deriveAdvice(stages);
    assert.ok(faults.length >= 1 && faults.length <= 4);
    assert.ok(advice.length >= 1);
    // 70% dan past bandlar aybga tushadi, 95% tushmaydi.
    assert.ok(faults.some((f) => /probniy/i.test(f)), 'eng kuchsiz band aybda bo\'lsin');
    assert.ok(!faults.some((f) => /Taqdimot/i.test(f)), '95% band aybda bo\'lmasin');
  } finally {
    if (saved !== undefined) process.env.OPENAI_API_KEY = saved;
  }
});

test('hech bir aybda 70% dan yuqori band yo\'q (chegara aniq)', async () => {
  const mod = await import('../lib/coaching');
  const faults = mod.deriveFaults([{ title: 'A', pct: 70 }, { title: 'B', pct: 69 }]);
  assert.ok(faults.some((f) => f.includes('B')), '69% aybda bo\'lsin');
  assert.ok(!faults.some((f) => f.startsWith('A ')), '70% aybda bo\'lmasin');
});
