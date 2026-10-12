// fetchAllRows API yo'lida ISHLATILMASIN (2026-10-12).
//
// NEGA: u minglab qatorni 1000 tadan KETMA-KET tortadi (har so'rov ~0.6 s) —
// hisobot sahifalari shu sababli o'nlab soniya yuklanardi. Hisob endi
// Postgres funksiyalarida (supabase/perf_*.sql). Ruxsat: faqat src/scripts/.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(import.meta.dirname ?? __dirname, '..');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

test('fetchAllRows faqat src/scripts/ ichida chaqiriladi', () => {
  const offenders = walk(SRC)
    .filter((p) => p.endsWith('.ts') && !p.endsWith('.test.ts'))
    .filter((p) => !p.startsWith(path.join(SRC, 'scripts') + path.sep))
    .filter((p) => !p.endsWith(path.join('lib', 'supabase.ts'))) // ta'rifning o'zi
    .filter((p) => /fetchAllRows\s*[<(]/.test(readFileSync(p, 'utf8').replace(/\/\/.*$/gm, '')))
    .map((p) => path.relative(SRC, p));
  assert.deepEqual(offenders, [], `fetchAllRows API kodida: ${offenders.join(', ')}`);
});
