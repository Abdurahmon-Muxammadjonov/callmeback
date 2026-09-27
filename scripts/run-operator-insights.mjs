#!/usr/bin/env node
// ============================================================================
// OPERATOR TAVSIYALARINI QO'LDA TAYYORLAYDI (API v2 §10)
//
// NEGA KERAK: staff-stats endi GPT chaqirmaydi va tavsiyani
// operator_insights jadvalidan o'qiydi. Jadval bo'sh bo'lsa UI "Tavsiya
// tayyorlanmoqda…" ko'rsatadi. Bu skript jadvalni darhol to'ldiradi —
// rejadagi 13:00 / 20:00 / 02:30 slotini kutmasdan.
//
// ISHLATISH:
//   node scripts/run-operator-insights.mjs                 # sinov (GPT chaqirmaydi)
//   node scripts/run-operator-insights.mjs --apply
//   node scripts/run-operator-insights.mjs --apply --company=<uuid>
//
// OLDIN: supabase/api_v2_stage1_operator_insights.sql ishga tushirilgan
// bo'lishi kerak.
// ============================================================================

import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const ONLY = (argv.find((a) => a.startsWith('--company=')) || '').split('=')[1] || null;

// .env.local dan kalitlarni process.env ga qo'yamiz (modul ularni shundan oladi).
for (const line of readFileSync(path.join(ROOT, '.env.local'), 'utf8').split('\n')) {
  const t = line.trim();
  if (!t || t.startsWith('#') || !t.includes('=')) continue;
  const i = t.indexOf('=');
  if (!process.env[t.slice(0, i)]) process.env[t.slice(0, i)] = t.slice(i + 1).trim();
}
if (!process.env.SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_URL) {
  process.env.SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
}

const { supabase } = await import('../dist/lib/supabase.js');
const { collectInsightInputs, runOperatorInsights } = await import('../dist/jobs/operatorInsights.js');

// Qaysi kompaniyalar? calls jadvalidagi haqiqiy company_id lar.
let companies = ONLY ? [ONLY] : null;
if (!companies) {
  const { data } = await supabase.from('companies').select('id, name').limit(50);
  companies = (data || []).map((c) => c.id);
  console.log(`\nKompaniyalar: ${companies.length}`);
}

let total = 0;
for (const id of companies) {
  const inputs = await collectInsightInputs(supabase, id);
  console.log(`\n${id.slice(0, 8)}…  mos keladigan operator: ${inputs.length}`);
  for (const i of inputs) {
    const errs = i.topErrors.map((e) => `${e.label} (−${e.lostPoints})`).join(', ') || '—';
    console.log(`  ext ${i.ext.padEnd(6)} baholangan ${String(i.ratedCalls).padStart(4)}  xatolar: ${errs.slice(0, 90)}`);
  }
  total += inputs.length;
  if (APPLY && inputs.length) {
    const r = await runOperatorInsights(id, supabase);
    console.log(`  -> yozildi ${r.written}, o'tkazildi ${r.skipped}, ${r.tokens} token`);
  }
}

if (!APPLY) {
  console.log(`\nSINOV rejimi — GPT chaqirilmadi, jadval o'zgartirilmadi.`);
  console.log(`Jami ${total} operator uchun tavsiya tayyorlanadi (operatorga 1 chaqiruv).`);
  console.log('Bajarish: node scripts/run-operator-insights.mjs --apply\n');
} else {
  console.log(`\nTAYYOR.\n`);
}
