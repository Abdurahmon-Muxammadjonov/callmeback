// ============================================================================
// TAHLIL NATIJASI CRM'GA AVTOMATIK (2026-10-16, foydalanuvchi talabi: "CRM
// obrabotkasini avtomatik qilish, sistemaga CRM ulash" — amoCRM va 5CRM).
//
// Qo'ng'iroq AI tahlilidan o'tgach (utel-webhook -> processTranscriptToCall)
// kompaniyaning yoqilgan integratsiyalariga natija yuboriladi
// (supabase/crm_01_company_integrations.sql):
//
//   amocrm  — mijoz raqami bo'yicha kontakt topiladi (GET /api/v4/contacts
//             ?query=), uning oxirgi bitimiga (bo'lmasa kontaktga) izoh
//             qo'shiladi: ball, xulosa, lid sifati va sababi, operator, audio.
//             Kirish — amoCRM "uzoq muddatli token" (shifrlangan).
//   webhook — 5CRM yoki istalgan tizim: JSON POST; sarlavhada
//             X-SalesPulse-Signature: sha256=<HMAC(secret, body)>.
//
// Eng yaxshi harakat: CRM xatosi tahlilni buzmaydi — last_error'ga yoziladi.
// ============================================================================

import crypto from 'node:crypto';
import { supabase } from './supabase';
import { decryptFor } from './passwordVault';
import { operatorNamesByExt } from './operatorNames';
import { leadReasonCategory } from './leadReasons';

export const CRM_SECRET_PURPOSE = 'crm-secret';

export interface CallPayload {
  event: 'call.analyzed';
  call_id: string;
  company_id: string;
  created_at: string;
  duration_sec: number;
  direction: string | null;
  client_phone: string | null;
  operator_ext: string | null;
  operator_name: string | null;
  score10: number | null;
  summary: string | null;
  comment: string | null;
  lead_quality: 'qualified' | 'unqualified' | null;
  lead_reasons: string[];
  url: string;
}

/** Qo'ng'iroqdan CRM'ga yuboriladigan ma'lumot (bitta joyda — amoCRM va webhook bir xil). */
export async function buildCallPayload(callId: string): Promise<CallPayload | null> {
  const { data: c } = await supabase
    .from('calls')
    .select('id, company_id, created_at, duration, direction, client_phone, operator_ext, kpi_score, summary, rop_comment, new_leads_count, bad_leads_count')
    .eq('id', callId)
    .maybeSingle();
  if (!c || !(c as any).company_id) return null;
  const call = c as any;
  const [names, lr] = await Promise.all([
    operatorNamesByExt(call.company_id),
    supabase.from('lost_reasons').select('reason_text').eq('call_id', callId),
  ]);
  const ext = String(call.operator_ext ?? '').trim() || null;
  const bad = Number(call.bad_leads_count) > 0;
  const good = !bad && Number(call.new_leads_count) > 0;
  const kpi = Number(call.kpi_score);
  const day = String(call.created_at).slice(0, 10);
  return {
    event: 'call.analyzed',
    call_id: call.id,
    company_id: call.company_id,
    created_at: call.created_at,
    duration_sec: Number(call.duration) || 0,
    direction: call.direction ?? null,
    client_phone: call.client_phone ?? null,
    operator_ext: ext,
    operator_name: ext ? names.get(ext) || `Operator ${ext}` : null,
    score10: kpi > 0 ? Math.round(kpi) / 10 : null,
    summary: call.summary ?? null,
    comment: call.rop_comment ?? null,
    lead_quality: bad ? 'unqualified' : good ? 'qualified' : null,
    lead_reasons: bad ? [...new Set(((lr.data || []) as any[]).map((r) => leadReasonCategory(r.reason_text)))] : [],
    url: `https://www.procell.uz/dashboard/recordings?date=${day}&open=${call.id}`,
  };
}

/** amoCRM izohi matni. */
export function amoNoteText(p: CallPayload): string {
  const lines = [
    `📞 SalesPulse — qo'ng'iroq tahlili`,
    `Operator: ${p.operator_name ?? '—'}${p.operator_ext ? ` (${p.operator_ext})` : ''}`,
    `Davomiyligi: ${Math.floor(p.duration_sec / 60)}:${String(p.duration_sec % 60).padStart(2, '0')}`,
    p.score10 != null ? `Ball: ${p.score10}/10` : null,
    p.lead_quality ? `Lid: ${p.lead_quality === 'qualified' ? 'sifatli' : 'sifatsiz'}${p.lead_reasons.length ? ` — ${p.lead_reasons.join(', ')}` : ''}` : null,
    p.summary ? `Xulosa: ${p.summary}` : null,
    `Audio va to'liq tahlil: ${p.url}`,
  ];
  return lines.filter(Boolean).join('\n');
}

function phoneQuery(phone: string | null): string | null {
  const digits = String(phone ?? '').replace(/\D/g, '');
  if (digits.length < 7) return null;
  return digits.slice(-9); // O'zbekiston: oxirgi 9 raqam (+998 siz)
}

async function amoFetch(sub: string, token: string, path: string, init: RequestInit = {}): Promise<any> {
  const host = sub.includes('.') ? sub : `${sub}.amocrm.ru`;
  const resp = await fetch(`https://${host}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
    signal: AbortSignal.timeout(20_000),
  });
  if (resp.status === 204) return null;
  const text = await resp.text();
  if (!resp.ok) throw new Error(`amoCRM HTTP ${resp.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

/** amoCRM: raqam bo'yicha kontakt -> oxirgi bitimga (bo'lmasa kontaktga) izoh. */
export async function pushToAmo(config: { subdomain: string; token: string }, p: CallPayload): Promise<string> {
  const q = phoneQuery(p.client_phone);
  if (!q) return 'raqam yo\'q — o\'tkazildi';
  const found = await amoFetch(config.subdomain, config.token, `/api/v4/contacts?query=${encodeURIComponent(q)}&with=leads&limit=1`);
  const contact = found?._embedded?.contacts?.[0];
  if (!contact) return 'kontakt topilmadi';
  const leads: Array<{ id: number }> = contact?._embedded?.leads ?? [];
  const leadId = leads.length ? Math.max(...leads.map((l) => Number(l.id))) : null;
  const note = [{ entity_id: leadId ?? contact.id, note_type: 'common', params: { text: amoNoteText(p) } }];
  await amoFetch(config.subdomain, config.token, leadId ? '/api/v4/leads/notes' : '/api/v4/contacts/notes', {
    method: 'POST',
    body: JSON.stringify(note),
  });
  return leadId ? `bitim #${leadId}` : `kontakt #${contact.id}`;
}

export function signBody(secret: string, body: string): string {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

/** Webhook (5CRM va boshqalar): JSON POST + HMAC imzo. */
export async function pushToWebhook(config: { url: string; secret: string | null }, p: CallPayload): Promise<string> {
  const body = JSON.stringify(p);
  const resp = await fetch(config.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'SalesPulse-Webhook/1.0',
      ...(config.secret ? { 'X-SalesPulse-Signature': signBody(config.secret, body) } : {}),
    },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) throw new Error(`Webhook HTTP ${resp.status}`);
  return `HTTP ${resp.status}`;
}

interface IntegrationRow { id: string; provider: 'amocrm' | 'webhook'; config: any; enabled: boolean; pushed_count: number }

/** Integratsiya qatoridan ochilgan (deshifrlangan) sozlama. */
export function openConfig(row: Pick<IntegrationRow, 'provider' | 'config'>): { subdomain: string; token: string } | { url: string; secret: string | null } | null {
  const c = row.config || {};
  if (row.provider === 'amocrm') {
    const token = decryptFor(CRM_SECRET_PURPOSE, c.token_enc);
    return c.subdomain && token ? { subdomain: String(c.subdomain), token } : null;
  }
  return c.url ? { url: String(c.url), secret: decryptFor(CRM_SECRET_PURPOSE, c.secret_enc) } : null;
}

export async function pushOne(row: IntegrationRow, p: CallPayload): Promise<string> {
  const cfg = openConfig(row);
  if (!cfg) throw new Error('Sozlama to\'liq emas yoki kalit o\'qilmadi.');
  return row.provider === 'amocrm' ? pushToAmo(cfg as any, p) : pushToWebhook(cfg as any, p);
}

/** Tahlildan keyin chaqiriladi — xatolar yutiladi (tahlil buzilmasin). */
export async function pushAnalyzedCall(callId: string): Promise<void> {
  try {
    const p = await buildCallPayload(callId);
    if (!p) return;
    const { data, error } = await supabase
      .from('company_integrations')
      .select('id, provider, config, enabled, pushed_count')
      .eq('company_id', p.company_id)
      .in('provider', ['amocrm', 'webhook']) // 'meta' — faqat o'qish (target), unga yozilmaydi
      .eq('enabled', true);
    if (error || !data?.length) return; // jadval hali yo'q yoki integratsiya yo'q
    for (const row of data as IntegrationRow[]) {
      try {
        await pushOne(row, p);
        await supabase.from('company_integrations')
          .update({ last_push_at: new Date().toISOString(), last_error: null, pushed_count: (row.pushed_count || 0) + 1 })
          .eq('id', row.id);
      } catch (e: any) {
        await supabase.from('company_integrations')
          .update({ last_error: String(e?.message || e).slice(0, 300), updated_at: new Date().toISOString() })
          .eq('id', row.id);
      }
    }
  } catch (e: any) {
    console.warn(`CRM'ga yuborilmadi (call=${callId}):`, e?.message || e);
  }
}
