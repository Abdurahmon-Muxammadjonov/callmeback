// ROLE: API process og'ir fon ishlarini (ffmpeg, STT, Gemini) yuritmasligi kerak. 2026-10-12.

import test from 'node:test';
import assert from 'node:assert/strict';
import { processRole, runsBackgroundJobs, servesApi } from './processRole';

function withRole(value: string | undefined, fn: () => void): void {
  const saved = process.env.ROLE;
  if (value === undefined) delete process.env.ROLE; else process.env.ROLE = value;
  try { fn(); } finally {
    if (saved === undefined) delete process.env.ROLE; else process.env.ROLE = saved;
  }
}

test('standart rol — api: fon ishlari YO\'Q, HTTP bor', () => {
  withRole(undefined, () => {
    assert.equal(processRole(), 'api');
    assert.equal(runsBackgroundJobs(), false);
    assert.equal(servesApi(), true);
  });
});

test('worker: fon ishlari bor, API yo\'q', () => {
  withRole(' Worker ', () => {
    assert.equal(processRole(), 'worker');
    assert.equal(runsBackgroundJobs(), true);
    assert.equal(servesApi(), false);
  });
});

test('all: ikkalasi (eski bitta-servisli rejim); noma\'lum qiymat — api', () => {
  withRole('all', () => {
    assert.equal(runsBackgroundJobs(), true);
    assert.equal(servesApi(), true);
  });
  withRole('xato', () => assert.equal(processRole(), 'api'));
});
