// CRM'ga yuborish (2026-10-16): izoh matni, imzo va webhook manzili tekshiruvi.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { amoNoteText, signBody, type CallPayload } from './crmPush';
import { isSafeWebhookUrl } from '../routes/company-integrations';

const p: CallPayload = {
  event: 'call.analyzed', call_id: 'c1', company_id: 'co', created_at: '2026-10-14T14:33:08Z', duration_sec: 130,
  direction: 'outgoing', client_phone: '950560175', operator_ext: '105', operator_name: 'Menejer | Farida',
  score10: 7, summary: 'Mijoz kelishga rozi bo\'ldi.', comment: null, lead_quality: 'unqualified',
  lead_reasons: ['Qiziqish bildirmadi'], url: 'https://www.procell.uz/x',
};

test('amoCRM izohi: operator, davomiylik, ball, lid sifati va havola', () => {
  const t = amoNoteText(p);
  assert.match(t, /Menejer \| Farida \(105\)/);
  assert.match(t, /Davomiyligi: 2:10/);
  assert.match(t, /Ball: 7\/10/);
  assert.match(t, /Lid: sifatsiz — Qiziqish bildirmadi/);
  assert.match(t, /https:\/\/www\.procell\.uz\/x/);
});

test('webhook imzosi — HMAC-SHA256', () => {
  const body = JSON.stringify(p);
  assert.equal(signBody('s3cret', body), `sha256=${crypto.createHmac('sha256', 's3cret').update(body).digest('hex')}`);
});

test("webhook manzili: faqat tashqi https (SSRF himoyasi)", () => {
  assert.equal(isSafeWebhookUrl('https://api.5crm.uz/hooks/abc'), true);
  for (const bad of ['http://api.5crm.uz/x', 'https://localhost/x', 'https://127.0.0.1/x', 'https://10.0.0.5/x', 'https://192.168.1.1/x', 'https://callmeback.railway.internal/x', 'not a url']) {
    assert.equal(isSafeWebhookUrl(bad), false, bad);
  }
});
