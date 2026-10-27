// Target tahlil (2026-10-27): kreativ kaliti, Meta harakatlari, hisob ID.
import test from 'node:test';
import assert from 'node:assert/strict';
import { TARGET_SOURCE_RE, actionCounts, normAccountId, normKey } from './metaAds';

test('kreativ nomi utm_content bilan solishtiriladi', () => {
  assert.equal(normKey('Reels 2'), 'reels2');
  assert.equal(normKey('reels-2'), 'reels2');
  assert.equal(normKey('REELS_10'), 'reels10');
  assert.notEqual(normKey('Reels 1'), normKey('Reels 10'));
});

test('Meta harakatlari: lid va yozishuv', () => {
  assert.deepEqual(actionCounts([
    { action_type: 'lead', value: '12' },
    { action_type: 'onsite_conversion.lead_grouped', value: '12' },
    { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '30' },
    { action_type: 'link_click', value: '400' },
  ]), { leads: 12, messages: 30 });
  assert.deepEqual(actionCounts(null), { leads: 0, messages: 0 });
});

test('reklama hisobi ID va target manbalar', () => {
  assert.equal(normAccountId('123456'), 'act_123456');
  assert.equal(normAccountId('act_123456'), 'act_123456');
  assert.equal(normAccountId(''), null);
  assert.ok(TARGET_SOURCE_RE.test('Instagram') && TARGET_SOURCE_RE.test('ig') && TARGET_SOURCE_RE.test('Facebook'));
  assert.ok(!TARGET_SOURCE_RE.test('Telegram') && !TARGET_SOURCE_RE.test('Tavsiya'));
});
