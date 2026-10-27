// Sotuv dashboardi (2026-10-20): oldingi davr, o'sish, maydonlar.
import test from 'node:test';
import assert from 'node:assert/strict';
import { growth, previousRange, sourceKey } from './salesDashboard';
import { leadSource, selectValues } from './crmDeals';

test('joriy oy boshidan — o\'tgan oyning shu kunlari', () => {
  assert.deepEqual(previousRange({ from: '2026-10-01', to: '2026-10-17' }), { from: '2026-09-01', to: '2026-09-17' });
  // 31-mart → fevralda 31 yo'q: oy oxirigacha.
  assert.deepEqual(previousRange({ from: '2026-03-01', to: '2026-03-31' }), { from: '2026-02-01', to: '2026-02-28' });
});

test('ixtiyoriy oraliq — xuddi shu uzunlikdagi oldingi oraliq', () => {
  assert.deepEqual(previousRange({ from: '2026-10-10', to: '2026-10-16' }), { from: '2026-10-03', to: '2026-10-09' });
  assert.deepEqual(previousRange({ from: '2026-10-20', to: '2026-10-20' }), { from: '2026-10-19', to: '2026-10-19' });
  assert.deepEqual(previousRange({ from: '2026-01-01', to: '2026-10-17' }).to, '2025-12-31');
});

test('o\'sish: asos 0 bo\'lsa foiz yo\'q', () => {
  assert.deepEqual(growth(150, 100), { pct: 50, abs: 50 });
  assert.deepEqual(growth(5, 0), { pct: null, abs: 5 });
  assert.equal(growth(14_585_000, 101_370_000).pct, -85.6);
});

test('tanlov maydonlari va manba', () => {
  const cfs = [
    { field_id: 1, field_name: 'Lid manbasi', values: [{ value: 'facebook' }] },
    { field_id: 2, field_name: 'Daromad', values: [{ value: '$500-1000' }] },
    { field_id: 3, field_name: 'Tillar', values: [{ value: 'Ingliz' }, { value: 'Rus' }] },
    { field_id: 4, field_name: 'Izoh', values: [{ value: 'matn' }] },
    { field_id: 5, field_name: 'utm_content', field_code: 'UTM_CONTENT', values: [{ value: 'ad_123' }] },
  ];
  assert.deepEqual(selectValues(cfs, new Set([1, 2, 3])), { 1: 'facebook', 2: '$500-1000', 3: 'Ingliz, Rus' });
  assert.equal(selectValues([], new Set([1])), null);
  assert.deepEqual(leadSource(cfs), { source: 'facebook', utmSource: null, utmContent: 'ad_123', utmCampaign: null, utmMedium: null });
  assert.equal(leadSource([{ field_name: 'utm_source', field_code: 'UTM_SOURCE', values: [{ value: 'instagram' }] }]).source, 'instagram');
});

test('manba nomlari birlashtiriladi', () => {
  assert.equal(sourceKey('instagram'), 'Instagram');
  assert.equal(sourceKey('Instagram'), 'Instagram');
  assert.equal(sourceKey('ig'), 'Instagram');
  assert.equal(sourceKey(' Telegram '), 'Telegram');
  assert.equal(sourceKey('amo_zapusk_1103'), 'Amo_zapusk_1103');
  assert.equal(sourceKey(null), '—');
});
