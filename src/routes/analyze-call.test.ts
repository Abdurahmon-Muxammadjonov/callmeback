// calls jadvaliga yozilayotgan ustunlar OQ RO'YXATga bo'ysunishini qulflaydi.
//
// NEGA BU TEST BOR (haqiqiy zarar, 2026-09-27 da topilgan):
//   1) duration — GPT bu maydonni qaytarmaydi, normalizeAuditResult uni 0
//      qilardi va har qayta tahlil qo'ng'iroqning gaplashilgan vaqtini
//      o'chirib tashlardi. 2026-09-24 dagi "432 ta qo'ng'iroqda davomiylik 0"
//      holatining ildiz sababi shu edi.
//   2) incoming_count / outgoing_count — GPT taxmin qilardi; ballangan 546
//      qo'ng'iroqning 431 tasida (78.9%) PBX bergan `direction` bilan
//      qarama-qarshi edi.
//
// Qoida: GPT javobidan FAQAT tahlil maydonlari yoziladi. Faktik maydonlar
// (duration, direction, telefon, operator_ext, vaqt, audio) — hech qachon.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  callRowFieldsForTest, factRowFields, CALL_ROW_ANALYSIS_KEYS,
} from './analyze-call';

/** GPT hech narsa qaytarmagan holat — barcha son maydonlar 0, matnlar bo'sh. */
function emptyAudit(): any {
  return {
    total_calls: 0, incoming_count: 0, outgoing_count: 0, duration: 0,
    unanswered_count: 0, bad_leads_count: 0, new_leads_count: 0,
    sent_to_dealer_count: 0, closed_deals_count: 0,
    kpi_score: 0, penalty_amount: 0, bonus_amount: 0,
    rop_comment: '', transcript: '', transcript_segments: [],
    sentiment: '', risk: '', summary: '', client_info: '',
    final_agreement: '', next_steps: [],
    criteria_scores: [], traffic_conversion: 0, sales_conversion: 0,
  };
}

/** FAKTIK ustunlar — bularni GPT hech qachon yozmasligi kerak. */
const FACT_COLUMNS = [
  'duration', 'direction', 'client_phone', 'operator_ext', 'created_at',
  'audio_url', 'audio_source_url', 'audio_storage_url', 'pbx_call_id',
  'company_id', 'manager_id',
];

test('faktik ustunlar oq ro\'yxatda YO\'Q — GPT ularni yoza olmaydi', () => {
  const fields = callRowFieldsForTest(emptyAudit());
  for (const col of FACT_COLUMNS) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(fields, col), false,
      `"${col}" faktik ustun — callRowFields unga tegmasligi kerak`,
    );
  }
});

test('GPT 0 qaytarsa ham duration umuman yozilmaydi', () => {
  const fields = callRowFieldsForTest(emptyAudit());
  assert.equal('duration' in fields, false,
    'duration kaliti bo\'lmasligi kerak — bo\'lsa bazadagi qiymat 0 ga tushadi');
});

test('kiruvchi/chiquvchi hisobi PBX yo\'nalishidan olinadi, GPT\'dan emas', () => {
  const gptSaysIncoming = { ...emptyAudit(), incoming_count: 1, outgoing_count: 0 };
  const fields = callRowFieldsForTest(gptSaysIncoming);
  assert.equal('incoming_count' in fields, false);
  assert.equal('outgoing_count' in fields, false);

  // PBX "chiquvchi" degan — natija ham chiquvchi bo'lishi shart.
  assert.deepEqual(factRowFields('outgoing'), {
    total_calls: 1, incoming_count: 0, outgoing_count: 1, unanswered_count: 0,
  });
  assert.deepEqual(factRowFields('incoming'), {
    total_calls: 1, incoming_count: 1, outgoing_count: 0, unanswered_count: 0,
  });
});

test('yo\'nalish noma\'lum bo\'lsa ikkisi ham 0 — taxmin qilinmaydi', () => {
  for (const d of [null, undefined, '', 'unknown']) {
    const f = factRowFields(d as any);
    assert.equal(f.incoming_count, 0, `direction=${String(d)}`);
    assert.equal(f.outgoing_count, 0, `direction=${String(d)}`);
    assert.equal(f.total_calls, 1);
  }
});

test('oq ro\'yxat aynan kutilgan kalitlardan iborat', () => {
  const fields = callRowFieldsForTest(emptyAudit());
  assert.deepEqual(Object.keys(fields).sort(), [...CALL_ROW_ANALYSIS_KEYS].sort());
});

test('tahlil maydonlari yoziladi (oq ro\'yxat juda qattiq emas)', () => {
  const audit = {
    ...emptyAudit(),
    kpi_score: 62, rop_comment: 'izoh', summary: 'xulosa',
    bad_leads_count: 0, new_leads_count: 1, closed_deals_count: 1,
  };
  const fields: any = callRowFieldsForTest(audit);
  assert.equal(fields.kpi_score, 62);
  assert.equal(fields.rop_comment, 'izoh');
  assert.equal(fields.summary, 'xulosa');
  assert.equal(fields.new_leads_count, 1);
  assert.equal(fields.closed_deals_count, 1);
  assert.equal(fields.bad_lead, false);
});
