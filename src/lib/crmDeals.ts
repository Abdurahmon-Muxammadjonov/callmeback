// ============================================================================
// amoCRM'DAN PUL MA'LUMOTLARI (2026-10-20, foydalanuvchi talabi: "CRM'ni
// ulab, ichidagi pul ma'lumotlarini olish" — audio UTel'dan, pul CRM'dan).
//
// JAMALS amoCRM'ida (tekshirilgan):
//   «Бюджет» (price)     — TO'LANGAN summa
//   «Kelishuv Summasi»   — shartnoma summasi
//   «Qarzdorlik»         — Kelishuv − to'langan (qarz shu maydondan)
// Direktor qoidasi: to'lov bosqichlarining HAMMASI hisoblanadi; "to'liq
// to'lov" esa CHEK TEKSHIRILGANDAN keyingina to'liq hisoblanadi:
//   partial — bron, predoplata, 30%/50% + to'lov, bo'lib to'laydi, chala
//             to'lov, shartnoma asosida
//   pending — "To'liq to'lov qildi" (voronkada chek bosqichi bor — hali
//             tekshirilmagan)
//   full    — "Chek tekshirildi" va undan keyingi yutuq (142); chek
//             bosqichi yo'q voronkada — "To'liq to'lov qildi" ning o'zi
//
// Sinxron (worker, har CRM_PULL_MINUTES daqiqa): o'zgargan bitimlar
// (filter[updated_at]) → crm_leads (supabase/crm_02_crm_leads.sql); bosqichga
// o'tgan aniq vaqt — amoCRM hodisalaridan (lead_status_changed); mijoz
// raqami — kontaktdan; operator — o'sha raqam bilan gaplashgan UTel
// operatori (calls.client_phone, oxirgi 9 raqam).
// ============================================================================

import { supabase } from './supabase';
import { addDays, dayBounds } from './tashkentTime';
import { operatorNamesByExt } from './operatorNames';
import { openConfig } from './crmPush';

export type PayKind = 'none' | 'partial' | 'pending' | 'full' | 'lost';
export const PAY_KINDS: PayKind[] = ['partial', 'pending', 'full'];

const BACKFILL_DAYS = Number(process.env.CRM_PULL_BACKFILL_DAYS ?? 120);
const MAX_LEAD_PAGES = 60; // bir urinishda ko'pi bilan 15 000 bitim; qolgani keyingisida

// ---------------------------------------------------------------------------
// Bosqich turi (sof funksiyalar — test qilinadi)
// ---------------------------------------------------------------------------
export const normName = (s: unknown) =>
  String(s ?? '').toLowerCase().replace(/[ʻʼ`‘’"]/g, "'").replace(/\s+/g, ' ').trim();

const CHEK_RE = /chek tekshiril/;
const FULL_RE = /to'liq to'lov/;
const PARTIAL_RE = /bron|predoplata|chala to'lov|\d+\s*%\s*\+?\s*to'lov|bo'lib to'la|shartnoma asosida/;

/** Voronka nomlaridan: chek bosqichi bormi, to'lov bosqichi bormi. */
export function pipelineFlags(statusNames: string[]): { hasChek: boolean; hasPay: boolean } {
  const n = statusNames.map(normName);
  return {
    hasChek: n.some((s) => CHEK_RE.test(s)),
    hasPay: n.some((s) => CHEK_RE.test(s) || FULL_RE.test(s) || PARTIAL_RE.test(s)),
  };
}

export function classifyStage(p: { statusId: number; statusName: string; hasChek: boolean; hasPay: boolean; price: number }): PayKind {
  const name = normName(p.statusName);
  if (p.statusId === 143) return 'lost';
  if (CHEK_RE.test(name)) return 'full';
  if (FULL_RE.test(name)) return p.hasChek ? 'pending' : 'full';
  if (PARTIAL_RE.test(name)) return 'partial';
  if (p.statusId === 142) return p.hasPay || p.price > 0 ? 'full' : 'none';
  return 'none';
}

/** Bitim maydonlaridan: shartnoma summasi, qarz, to'lov turi. */
export function leadMoney(price: number, cfs: Array<{ field_name?: string; values?: Array<{ value?: unknown }> }> | null | undefined) {
  let deal: number | null = null;
  let debtField: number | null = null;
  let payType: string | null = null;
  for (const f of cfs ?? []) {
    const n = normName(f.field_name);
    const v = f.values?.[0]?.value;
    if (/kelishuv summa|сумма договора/.test(n)) deal = Number(v) || 0;
    else if (/^qarzdorlik|задолженн/.test(n)) debtField = Number(v) || 0;
    else if (/to'lov turi|тип оплаты|способ оплаты/.test(n)) payType = (f.values ?? []).map((x) => String(x.value ?? '')).filter(Boolean).join(', ') || null;
  }
  const dealSum = deal ?? 0;
  // Qarz faqat kelishuv summasi bor bitimda ma'noli (bo'lmasa Qarzdorlik = −to'langan).
  const debt = dealSum > 0 ? Math.max(0, debtField ?? dealSum - price) : 0;
  return { dealSum, debt, payType };
}

export const phone9 = (raw: unknown): string | null => {
  const d = String(raw ?? '').replace(/\D/g, '');
  return d.length >= 9 ? d.slice(-9) : null;
};

/** "Menejer 10 | Diyorbek" → "Diyorbek". */
export const cleanManagerName = (s: string | null | undefined): string | null => {
  const raw = String(s ?? '').trim();
  if (!raw) return null;
  const short = raw.replace(/^(menejer|manager|менеджер)\s*\d*\s*\|\s*/i, '').trim();
  return short || raw;
};

// ---------------------------------------------------------------------------
// amoCRM klienti (sekundiga ~6 so'rov — amoCRM chegarasi 7)
// ---------------------------------------------------------------------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeClient(subdomain: string, token: string) {
  const host = subdomain.includes('.') ? subdomain : `${subdomain}.amocrm.ru`;
  return async function get(path: string): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      await sleep(170);
      const r = await fetch(`https://${host}${path}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30_000),
      });
      if (r.status === 204) return null;
      if (r.status === 429 && attempt < 3) { await sleep(1500 * (attempt + 1)); continue; }
      if (!r.ok) throw new Error(`amoCRM HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
      return r.json();
    }
  };
}

interface StageInfo { pipelineName: string; statusName: string; sort: number; hasChek: boolean; hasPay: boolean }

/** Dashboard uchun voronka/foydalanuvchi/maydon ro'yxati (company_integrations.pull_meta). */
export interface CrmMeta {
  pipelines: Array<{ id: number; name: string; sort: number; statuses: Array<{ id: number; name: string; sort: number; kind: PayKind }> }>;
  users: Array<{ id: number; name: string; group_id: number | null; active: boolean }>;
  groups: Array<{ id: number; name: string }>;
  fields: Array<{ id: number; name: string; type: string }>;
  updated_at: string;
}

async function loadStages(get: (p: string) => Promise<any>): Promise<{ map: Map<string, StageInfo>; pipelines: CrmMeta['pipelines'] }> {
  const map = new Map<string, StageInfo>();
  const pipelines: CrmMeta['pipelines'] = [];
  const j = await get('/api/v4/leads/pipelines');
  for (const p of j?._embedded?.pipelines ?? []) {
    const statuses: any[] = p._embedded?.statuses ?? [];
    const flags = pipelineFlags(statuses.map((s) => s.name));
    const list: CrmMeta['pipelines'][number]['statuses'] = [];
    for (const s of statuses) {
      map.set(`${p.id}:${s.id}`, { pipelineName: p.name, statusName: s.name, sort: Number(s.sort) || 0, ...flags });
      list.push({ id: Number(s.id), name: s.name, sort: Number(s.sort) || 0, kind: classifyStage({ statusId: Number(s.id), statusName: s.name, ...flags, price: 0 }) });
    }
    pipelines.push({ id: Number(p.id), name: p.name, sort: Number(p.sort) || 0, statuses: list.sort((a, b) => a.sort - b.sort) });
  }
  return { map, pipelines: pipelines.sort((a, b) => a.sort - b.sort) };
}

async function loadUsers(get: (p: string) => Promise<any>): Promise<CrmMeta['users']> {
  const out: CrmMeta['users'] = [];
  for (let page = 1; page <= 10; page++) {
    const j = await get(`/api/v4/users?limit=250&page=${page}&with=group`);
    const arr: any[] = j?._embedded?.users ?? [];
    for (const u of arr) {
      const gid = u.rights?.group_id ?? u._embedded?.groups?.[0]?.id ?? null;
      out.push({ id: Number(u.id), name: String(u.name ?? ''), group_id: gid != null ? Number(gid) : null, active: u.rights?.is_active !== false });
    }
    if (arr.length < 250) break;
  }
  return out;
}

async function loadFields(get: (p: string) => Promise<any>) {
  const fields: Array<{ id: number; name: string; type: string; code: string | null }> = [];
  for (let page = 1; page <= 10; page++) {
    const j = await get(`/api/v4/leads/custom_fields?limit=250&page=${page}`);
    const arr: any[] = j?._embedded?.custom_fields ?? [];
    for (const f of arr) fields.push({ id: Number(f.id), name: String(f.name ?? ''), type: String(f.type ?? ''), code: f.code ? String(f.code) : null });
    if (arr.length < 250) break;
  }
  const lr = await get('/api/v4/leads/loss_reasons').catch(() => null);
  const lossReasons = new Map<number, string>();
  for (const r of lr?._embedded?.loss_reasons ?? []) lossReasons.set(Number(r.id), String(r.name));
  const acc = await get('/api/v4/account?with=users_groups').catch(() => null);
  const groups = ((acc?._embedded?.users_groups ?? []) as any[]).map((g) => ({ id: Number(g.id), name: String(g.name) }));
  return { fields, lossReasons, groups };
}

const iso = (unix: unknown) => (Number(unix) > 0 ? new Date(Number(unix) * 1000).toISOString() : null);

/** Bitimning tanlov maydonlari (select/multiselect) → {field_id: "javob"}. */
export function selectValues(cfs: any[] | null | undefined, selectIds: Set<number>): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const f of cfs ?? []) {
    if (!selectIds.has(Number(f.field_id))) continue;
    const v = (f.values ?? []).map((x: any) => String(x.value ?? '').trim()).filter(Boolean).join(', ');
    if (v) out[String(f.field_id)] = v.slice(0, 120);
  }
  return Object.keys(out).length ? out : null;
}

/** Manba: «Lid manbasi» maydoni, bo'lmasa utm_source. */
export function leadSource(cfs: any[] | null | undefined): { source: string | null; utmSource: string | null; utmContent: string | null; utmCampaign: string | null; utmMedium: string | null } {
  let source: string | null = null;
  let utmSource: string | null = null;
  let utmContent: string | null = null;
  let utmCampaign: string | null = null;
  let utmMedium: string | null = null;
  for (const f of cfs ?? []) {
    const n = normName(f.field_name);
    const code = String(f.field_code ?? '').toUpperCase();
    const v = String(f.values?.[0]?.value ?? '').trim() || null;
    if (!v) continue;
    if (/^lid manbasi|^источник/.test(n)) source = v;
    else if (code === 'UTM_SOURCE' || n === 'utm_source') utmSource = v;
    else if (code === 'UTM_CONTENT' || n === 'utm_content') utmContent = v;
    else if (code === 'UTM_CAMPAIGN' || n === 'utm_campaign') utmCampaign = v;
    else if (code === 'UTM_MEDIUM' || n === 'utm_medium') utmMedium = v;
  }
  return { source: (source ?? utmSource)?.slice(0, 80) ?? null, utmSource, utmContent: utmContent?.slice(0, 120) ?? null, utmCampaign: utmCampaign?.slice(0, 160) ?? null, utmMedium: utmMedium?.slice(0, 80) ?? null };
}

// ---------------------------------------------------------------------------
// Sinxron
// ---------------------------------------------------------------------------
type LeadRow = {
  company_id: string; provider: 'amocrm'; lead_id: number; name: string | null;
  pipeline_id: number; pipeline_name: string | null; status_id: number; status_name: string | null;
  pay_kind: PayKind; price: number; deal_sum: number; debt: number; payment_type: string | null;
  responsible_id: number | null; responsible_name: string | null; contact_id: number | null;
  client_phone9: string | null; operator_ext: string | null; call_id: string | null;
  stage_at: string | null; first_paid_at: string | null; crm_created_at: string | null; crm_updated_at: string | null;
  synced_at: string;
  // crm_03_sales_dashboard.sql (bo'lmasa yozilmaydi)
  source?: string | null; utm_source?: string | null; utm_content?: string | null; loss_reason?: string | null;
  lost_from_status_id?: number | null; group_id?: number | null; closed_at?: string | null; cf?: Record<string, string> | null;
  // crm_04_target_meta.sql
  utm_campaign?: string | null; utm_medium?: string | null;
};
const ROW_COLS = 'company_id, provider, lead_id, name, pipeline_id, pipeline_name, status_id, status_name, pay_kind, price, deal_sum, debt, payment_type, responsible_id, responsible_name, contact_id, client_phone9, operator_ext, call_id, stage_at, first_paid_at, crm_created_at, crm_updated_at, synced_at';
const EXT_COLS = `${ROW_COLS}, source, utm_source, utm_content, loss_reason, lost_from_status_id, group_id, closed_at, cf`;

async function upsertRows(rows: LeadRow[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await supabase.from('crm_leads').upsert(rows.slice(i, i + 200), { onConflict: 'company_id,provider,lead_id' });
    if (error) throw new Error(`crm_leads yozilmadi: ${error.message}`);
  }
}

async function existingRows(companyId: string, ids: number[], cols = ROW_COLS): Promise<Map<number, LeadRow>> {
  const out = new Map<number, LeadRow>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await supabase
      .from('crm_leads').select(cols)
      .eq('company_id', companyId).eq('provider', 'amocrm').in('lead_id', ids.slice(i, i + 200));
    if (error) throw new Error(`crm_leads o'qilmadi: ${error.message}`);
    for (const r of (data || []) as unknown as LeadRow[]) out.set(Number(r.lead_id), r);
  }
  return out;
}

const running = new Set<string>();

export interface SyncResult { leads: number; stored: number; events: number; phones: number; operators: number }

/** Bitta kompaniyaning amoCRM bitimlarini yangilaydi (o'zgarganlarini).
 *  maxPages — bir urinishda o'qiladigan sahifalar (250 tadan). */
export async function syncCompanyDeals(companyId: string, opts: { maxPages?: number } = {}): Promise<SyncResult | null> {
  if (running.has(companyId)) return null;
  running.add(companyId);
  // Kengaytirilgan rejim (crm_03 SQL ishlatilgan): hamma bitim + manba/sabab/maydonlar.
  let extended = true;
  let q = await supabase
    .from('company_integrations')
    .select('id, provider, config, enabled, pull_cursor, pull_events_cursor, pull_meta, sales_settings')
    .eq('company_id', companyId).eq('provider', 'amocrm').maybeSingle();
  if (q.error) {
    extended = false;
    q = await supabase
      .from('company_integrations')
      .select('id, provider, config, enabled, pull_cursor, pull_events_cursor')
      .eq('company_id', companyId).eq('provider', 'amocrm').maybeSingle() as any;
  }
  const integ = q.data as any;
  try {
    if (q.error || !integ || !integ.enabled) return null; // SQL hali yo'q yoki ulanmagan
    const cfg = openConfig(integ) as { subdomain: string; token: string } | null;
    if (!cfg) throw new Error('amoCRM tokeni o\'qilmadi — sozlamada qayta saqlang.');
    const get = makeClient(cfg.subdomain, cfg.token);
    const runStart = Math.floor(Date.now() / 1000);
    const backfillFrom = runStart - BACKFILL_DAYS * 86400;
    const result: SyncResult = { leads: 0, stored: 0, events: 0, phones: 0, operators: 0 };
    const settings = (integ.sales_settings || {}) as { deal_field_id?: number; debt_field_id?: number };
    // crm_04_target_meta.sql ishlatilganmi (utm_campaign ustuni) — bo'lmasa yozilmaydi.
    const hasUtmCampaign = extended && !(await supabase.from('crm_leads').select('utm_campaign').limit(1)).error;

    const [{ map: stages, pipelines }, userList, extra] = await Promise.all([
      loadStages(get), loadUsers(get), extended ? loadFields(get) : Promise.resolve(null),
    ]);
    const users = new Map(userList.map((u) => [u.id, u]));
    const selectIds = new Set((extra?.fields ?? []).filter((f) => f.type === 'select' || f.type === 'multiselect').map((f) => f.id));
    const nameOf = new Map((extra?.fields ?? []).map((f) => [f.id, f.name]));
    const nowIso = new Date().toISOString();
    if (extended && extra) {
      const meta: CrmMeta = {
        pipelines, users: userList, groups: extra.groups,
        fields: extra.fields.filter((f) => selectIds.has(f.id) || f.type === 'monetary' || f.type === 'numeric').map(({ id, name, type }) => ({ id, name, type })),
        updated_at: nowIso,
      };
      await supabase.from('company_integrations').update({ pull_meta: meta }).eq('id', integ.id);
    }
    // Sozlamada boshqa pul maydoni tanlangan bo'lsa — nomini standart nomga almashtiramiz.
    const remapMoney = (cfs: any[] | null | undefined) => (cfs ?? []).map((f: any) => {
      if (settings.deal_field_id && Number(f.field_id) === Number(settings.deal_field_id)) return { ...f, field_name: 'Kelishuv Summasi' };
      if (settings.debt_field_id && Number(f.field_id) === Number(settings.debt_field_id)) return { ...f, field_name: 'Qarzdorlik' };
      if ((settings.deal_field_id || settings.debt_field_id) && /kelishuv summa|^qarzdorlik/i.test(normName(f.field_name ?? nameOf.get(Number(f.field_id))))) return { ...f, field_name: '—' };
      return f;
    });

    // 1) Bitimlar. Birinchi marta (kengaytirilgan) — HAMMASI, ID tartibida
    // sahifama-sahifa (pull_cursor ≤ 0: −N = N-sahifadan davom). updated_at
    // bo'yicha chuqur sahifalash amoCRM'da sakrab ketdi (2026-10-20: 26 500
    // dan 3 700 tasi saqlangan) — to'liq yuklash shuning uchun ID bo'yicha.
    // Keyin — faqat o'zgarganlar (filter[updated_at], kichik to'plam).
    const stored = Number(integ.pull_cursor) || 0;
    const full = extended && stored <= 0;
    let cursor = full ? 0 : stored || backfillFrom;
    const startPage = full && stored < 0 ? Math.max(1, -stored - 1) : 1; // bitta sahifa ustma-ust
    const maxPages = opts.maxPages ?? MAX_LEAD_PAGES;
    const cols = extended ? EXT_COLS : ROW_COLS;
    let lastPage = startPage - 1;
    let finished = false;
    for (let page = startPage; page < startPage + maxPages; page++) {
      const path = full
        ? `/api/v4/leads?with=contacts,loss_reason&limit=250&page=${page}&order[id]=asc`
        : `/api/v4/leads?with=contacts,loss_reason&limit=250&page=${page}&filter[updated_at][from]=${cursor}&order[updated_at]=asc`;
      let j = await get(path);
      // amoCRM ba'zan o'rtadagi sahifani bo'sh (204) qaytaradi — bir marta qayta so'raymiz,
      // aks holda 26 000 bitimdan 3 500 tasida to'xtab qolgan edi (2026-10-20).
      if (page > 1 && !j?._embedded?.leads?.length) { await sleep(2000); j = await get(path); }
      const leads: any[] = j?._embedded?.leads ?? [];
      if (!leads.length) { finished = true; break; }
      lastPage = page;
      result.leads += leads.length;
      const prev = await existingRows(companyId, leads.map((l) => Number(l.id)), cols);
      const rows: LeadRow[] = [];
      for (const l of leads) {
        if (l.is_deleted) continue;
        const id = Number(l.id);
        const st = stages.get(`${l.pipeline_id}:${l.status_id}`);
        const price = Number(l.price) || 0;
        const kind = classifyStage({
          statusId: Number(l.status_id), statusName: st?.statusName ?? '', hasChek: !!st?.hasChek, hasPay: !!st?.hasPay, price,
        });
        const old = prev.get(id);
        if (!extended && !old && !PAY_KINDS.includes(kind)) continue; // eski rejim: faqat pulga aloqadorlar
        const cfs = remapMoney(l.custom_fields_values);
        const { dealSum, debt, payType } = leadMoney(price, cfs);
        const moved = !old || Number(old.status_id) !== Number(l.status_id) || Number(old.pipeline_id) !== Number(l.pipeline_id);
        const fallbackAt = iso(Number(l.status_id) === 142 || Number(l.status_id) === 143 ? l.closed_at || l.updated_at : l.updated_at);
        const stageAt = moved ? fallbackAt : old!.stage_at;
        const contact = (l._embedded?.contacts ?? []).find((c: any) => c.is_main) ?? l._embedded?.contacts?.[0];
        const contactId = contact ? Number(contact.id) : null;
        const sameContact = !!old && Number(old.contact_id) === Number(contactId);
        const rid = Number(l.responsible_user_id) || null;
        const row: LeadRow = {
          company_id: companyId, provider: 'amocrm', lead_id: id, name: l.name ? String(l.name).slice(0, 200) : null,
          pipeline_id: Number(l.pipeline_id), pipeline_name: st?.pipelineName ?? null,
          status_id: Number(l.status_id), status_name: st?.statusName ?? null,
          pay_kind: kind, price, deal_sum: dealSum, debt, payment_type: payType,
          responsible_id: rid, responsible_name: rid ? users.get(rid)?.name ?? null : null,
          contact_id: contactId,
          client_phone9: sameContact ? old!.client_phone9 : null,
          // Bosqich o'zgarsa operator qayta aniqlanadi (to'lovdan oldingi oxirgi qo'ng'iroq).
          operator_ext: sameContact && !moved ? old!.operator_ext : null,
          call_id: sameContact && !moved ? old!.call_id : null,
          stage_at: stageAt,
          first_paid_at: PAY_KINDS.includes(kind)
            ? [old?.first_paid_at, stageAt].filter((x): x is string => !!x).sort()[0] ?? null
            : old?.first_paid_at ?? null,
          crm_created_at: iso(l.created_at), crm_updated_at: iso(l.updated_at), synced_at: nowIso,
        };
        if (extended) {
          const src = leadSource(l.custom_fields_values);
          const lossName = l._embedded?.loss_reason?.[0]?.name ?? (l.loss_reason_id ? extra?.lossReasons.get(Number(l.loss_reason_id)) : null);
          const lostField = (l.custom_fields_values ?? []).find((f: any) => /^lost sababi|причина отказа/.test(normName(f.field_name)));
          Object.assign(row, {
            source: src.source, utm_source: src.utmSource, utm_content: src.utmContent,
            ...(hasUtmCampaign ? { utm_campaign: src.utmCampaign, utm_medium: src.utmMedium } : {}),
            loss_reason: Number(l.status_id) === 143 ? (lossName ?? (lostField?.values?.[0]?.value ? String(lostField.values[0].value) : null)) : null,
            lost_from_status_id: Number(l.status_id) === 143 ? old?.lost_from_status_id ?? null : null,
            group_id: rid ? users.get(rid)?.group_id ?? null : null,
            closed_at: iso(l.closed_at),
            cf: selectValues(l.custom_fields_values, selectIds),
          });
        }
        rows.push(row);
      }
      await upsertRows(rows);
      result.stored += rows.length;
      if (!full) cursor = Math.max(cursor, ...leads.map((l) => Number(l.updated_at) || 0));
      if (leads.length < 250) { finished = true; break; }
    }
    // To'liq yuklash tugadi — endi o'zgarganlar shu paytdan (10 daqiqa zaxira bilan);
    // tugamadi — keyingi urinish shu sahifadan.
    const nextCursor = full ? (finished ? runStart - 600 : -(lastPage + 1)) : cursor;

    // 2) Bosqichga o'tgan aniq vaqt — hodisalardan (to'lov bosqichlari va rad etish)
    const eventsFrom = Number(integ.pull_events_cursor) || runStart - Math.max(BACKFILL_DAYS, 365) * 86400;
    const watch = [...stages.entries()]
      .filter(([k, s]) => {
        const sid = Number(k.split(':')[1]);
        const kind = classifyStage({ statusId: sid, statusName: s.statusName, hasChek: s.hasChek, hasPay: s.hasPay, price: 0 });
        return PAY_KINDS.includes(kind) || (extended && kind === 'lost');
      })
      .map(([k]) => k.split(':').map(Number) as [number, number]);
    const evByLead = new Map<number, Array<{ at: string; pipeline: number; status: number; before: number | null }>>();
    // To'liq yuklash davomida o'tkaziladi — hodisalar u tugagach bir marta (aks holda har urinishda 26 000 hodisa).
    for (let i = 0; full && !finished ? false : i < watch.length; i += 10) {
      const chunk = watch.slice(i, i + 10);
      const filt = chunk.map(([p, s], k) =>
        `&filter[value_after][leads_statuses][${k}][pipeline_id]=${p}&filter[value_after][leads_statuses][${k}][status_id]=${s}`).join('');
      for (let page = 1; page <= 100; page++) {
        const j = await get(`/api/v4/events?limit=100&page=${page}&filter[type]=lead_status_changed&filter[created_at][from]=${eventsFrom}${filt}`);
        const evs: any[] = j?._embedded?.events ?? [];
        for (const e of evs) {
          const after = e.value_after?.[0]?.lead_status;
          if (!after) continue;
          const lid = Number(e.entity_id);
          const before = e.value_before?.[0]?.lead_status?.id;
          evByLead.set(lid, [...(evByLead.get(lid) || []), { at: iso(e.created_at)!, pipeline: Number(after.pipeline_id), status: Number(after.id), before: before != null ? Number(before) : null }]);
        }
        result.events += evs.length;
        if (evs.length < 100) break;
      }
    }
    if (evByLead.size) {
      const rows = await existingRows(companyId, [...evByLead.keys()], cols);
      const changed: LeadRow[] = [];
      for (const [lid, evs] of evByLead) {
        const r = rows.get(lid);
        if (!r) continue;
        const cur = evs.filter((e) => e.pipeline === Number(r.pipeline_id) && e.status === Number(r.status_id)).sort((a, b) => a.at.localeCompare(b.at));
        const payEvs = evs.filter((e) => {
          const s = stages.get(`${e.pipeline}:${e.status}`);
          return s && PAY_KINDS.includes(classifyStage({ statusId: e.status, statusName: s.statusName, hasChek: s.hasChek, hasPay: s.hasPay, price: Number(r.price) || 0 }));
        });
        const first = PAY_KINDS.includes(r.pay_kind)
          ? [r.first_paid_at, ...payEvs.map((e) => e.at)].filter((x): x is string => !!x).sort()[0] ?? null
          : r.first_paid_at;
        const last = cur[cur.length - 1];
        const stageAt = last ? last.at : r.stage_at;
        const lostFrom = extended && Number(r.status_id) === 143 && last?.before ? last.before : r.lost_from_status_id ?? null;
        if (stageAt !== r.stage_at || first !== r.first_paid_at || (extended && lostFrom !== (r.lost_from_status_id ?? null))) {
          changed.push({ ...r, stage_at: stageAt, first_paid_at: first, ...(extended ? { lost_from_status_id: lostFrom } : {}) });
        }
      }
      await upsertRows(changed);
    }

    // 3) Mijoz raqami (kontaktdan) va 4) operator (UTel qo'ng'iroqlaridan)
    const { data: need } = await supabase
      .from('crm_leads').select(cols)
      .eq('company_id', companyId).eq('provider', 'amocrm').in('pay_kind', PAY_KINDS)
      .or('client_phone9.is.null,operator_ext.is.null')
      .order('stage_at', { ascending: false }).limit(1000);
    const pending = (need || []) as unknown as LeadRow[];
    // Target lidlar (kreativ yoki Instagram/Facebook manbasi, so'nggi 120 kun) —
    // raqami AI qo'ng'iroq sifatiga bog'lash uchun kerak (lib/metaAds.ts).
    if (extended) {
      const { data: tl } = await supabase
        .from('crm_leads').select(cols)
        .eq('company_id', companyId).eq('provider', 'amocrm').is('client_phone9', null).not('contact_id', 'is', null)
        .gte('crm_created_at', new Date(Date.now() - 120 * 86400_000).toISOString())
        .or('utm_content.not.is.null,source.ilike.instagram,source.ilike.ig,source.ilike.facebook,source.ilike.target')
        .order('crm_created_at', { ascending: false }).limit(1000);
      const seen = new Set(pending.map((r) => Number(r.lead_id)));
      for (const r of (tl || []) as unknown as LeadRow[]) if (!seen.has(Number(r.lead_id))) pending.push(r);
    }
    const contactIds = [...new Set(pending.filter((r) => r.client_phone9 == null && r.contact_id).map((r) => Number(r.contact_id)))].slice(0, 1500);
    const phoneByContact = new Map<number, string>();
    const fetchedContacts = new Set<number>();
    for (let i = 0; i < contactIds.length; i += 50) {
      const ids = contactIds.slice(i, i + 50).map((id) => `filter[id][]=${id}`).join('&');
      const j = await get(`/api/v4/contacts?limit=50&${ids}`);
      for (const c of j?._embedded?.contacts ?? []) {
        fetchedContacts.add(Number(c.id));
        const ph = (c.custom_fields_values ?? []).find((f: any) => f.field_code === 'PHONE');
        const p9 = phone9(ph?.values?.[0]?.value);
        if (p9) phoneByContact.set(Number(c.id), p9);
      }
    }
    const noPhone = new Set<number>();
    for (const r of pending) {
      if (!r.client_phone9 && r.contact_id && phoneByContact.has(Number(r.contact_id))) {
        r.client_phone9 = phoneByContact.get(Number(r.contact_id))!;
        result.phones += 1;
      } else if (r.client_phone9 == null && r.contact_id && fetchedContacts.has(Number(r.contact_id))) {
        // Kontaktda raqam yo'q — '' (tekshirildi), har 2 daqiqada qayta so'ralmasin.
        r.client_phone9 = '';
        noPhone.add(Number(r.lead_id));
      }
    }
    const byPhone = new Map<string, Array<{ id: string; ext: string; at: string }>>();
    const phones = [...new Set(pending.filter((r) => r.client_phone9 && !r.operator_ext).map((r) => r.client_phone9!))];
    for (let i = 0; i < phones.length; i += 100) {
      const variants = phones.slice(i, i + 100).flatMap((p) => [p, `998${p}`, `+998${p}`]);
      const { data } = await supabase
        .from('calls').select('id, operator_ext, client_phone, created_at')
        .eq('company_id', companyId).in('client_phone', variants).not('operator_ext', 'is', null)
        .order('created_at', { ascending: false }).limit(5000);
      for (const c of (data || []) as any[]) {
        const p = phone9(c.client_phone);
        const ext = String(c.operator_ext ?? '').trim();
        if (!p || !ext) continue;
        byPhone.set(p, [...(byPhone.get(p) || []), { id: c.id, ext, at: c.created_at }]);
      }
    }
    const touched: LeadRow[] = [];
    for (const r of pending) {
      let dirty = noPhone.has(Number(r.lead_id)) || (r.client_phone9 != null && phoneByContact.get(Number(r.contact_id)) === r.client_phone9);
      if (r.client_phone9 && !r.operator_ext) {
        const calls = byPhone.get(r.client_phone9) ?? []; // yangisi birinchi
        const limit = r.stage_at ? new Date(new Date(r.stage_at).getTime() + 86400_000).toISOString() : null;
        const pick = calls.find((c) => !limit || c.at <= limit) ?? calls[0];
        if (pick) { r.operator_ext = pick.ext; r.call_id = pick.id; result.operators += 1; dirty = true; }
      }
      if (dirty) touched.push(r);
    }
    await upsertRows(touched);

    await supabase.from('company_integrations')
      .update({ pull_cursor: nextCursor, pull_events_cursor: full && !finished ? integ.pull_events_cursor ?? null : runStart - 120, pull_at: new Date().toISOString(), pull_error: null })
      .eq('id', integ.id);
    return result;
  } catch (e: any) {
    const msg = String(e?.message || e).slice(0, 300);
    if (integ) await supabase.from('company_integrations').update({ pull_error: msg }).eq('id', integ.id);
    console.warn(`amoCRM bitimlar sinxroni xatosi (company=${companyId}):`, msg);
    throw e;
  } finally {
    running.delete(companyId);
  }
}

/** Worker: hamma ulangan kompaniyalar, har CRM_PULL_MINUTES (standart 2). */
let pullStarted = false;
export function startCrmDealsSync(): void {
  // Standart 2 daqiqa: o'zgarganlarni o'qish arzon (bir necha so'rov), CRM'dagi o'zgarish tez ko'rinadi.
  const minutes = Number(process.env.CRM_PULL_MINUTES ?? 2);
  if (pullStarted || !(minutes > 0)) return;
  pullStarted = true;
  const tick = async () => {
    const { data, error } = await supabase.from('company_integrations').select('company_id').eq('provider', 'amocrm').eq('enabled', true);
    if (error) return;
    for (const r of (data || []) as Array<{ company_id: string }>) {
      try {
        const res = await syncCompanyDeals(r.company_id);
        if (res?.stored) console.log(`💰 amoCRM sinxron (company=${r.company_id}): ${res.leads} bitim ko'rildi, ${res.stored} saqlandi, ${res.operators} operatorga bog'landi.`);
      } catch { /* xato pull_error'ga yozilgan */ }
    }
  };
  setTimeout(() => { void tick().catch(() => {}); }, 30_000).unref();
  setInterval(() => { void tick().catch(() => {}); }, minutes * 60_000).unref();
  console.log(`amoCRM pul ma'lumotlari: har ${minutes} daqiqada sinxron.`);
}

// ---------------------------------------------------------------------------
// Hisobot (dashboard /analytics/crm-money va Telegram kun hisoboti)
// ---------------------------------------------------------------------------
interface Bucket { count: number; sum: number }
const bucket = (): Bucket => ({ count: 0, sum: 0 });

export async function computeCrmMoney(companyId: string, from: string, to: string) {
  const start = dayBounds(from).from;
  const end = dayBounds(addDays(to, 1)).from;
  const { data: integ, error: iErr } = await supabase
    .from('company_integrations').select('enabled, config, pull_at, pull_error')
    .eq('company_id', companyId).eq('provider', 'amocrm').maybeSingle();
  if (iErr) return { ready: false as const };
  if (!integ) return { ready: true as const, connected: false as const };

  const rows: LeadRow[] = [];
  for (let off = 0; off < 10_000; off += 1000) {
    const { data, error } = await supabase
      .from('crm_leads').select(ROW_COLS)
      .eq('company_id', companyId).in('pay_kind', PAY_KINDS)
      .gte('stage_at', start).lt('stage_at', end)
      .order('stage_at', { ascending: false })
      .range(off, off + 999);
    if (error) return { ready: false as const };
    rows.push(...((data || []) as LeadRow[]));
    if (!data || data.length < 1000) break;
  }
  const { data: debtData } = await supabase
    .from('crm_leads').select(ROW_COLS)
    .eq('company_id', companyId).in('pay_kind', PAY_KINDS).gt('debt', 0)
    .order('debt', { ascending: false }).limit(2000);
  const debtors = (debtData || []) as LeadRow[];

  const names = await operatorNamesByExt(companyId);
  const sub = String((integ as any).config?.subdomain ?? '');
  const host = sub.includes('.') ? sub : `${sub}.amocrm.ru`;
  const opName = (ext: string | null) => (ext ? names.get(ext) || `Operator ${ext}` : null);
  const view = (r: LeadRow) => ({
    lead_id: Number(r.lead_id),
    name: r.name,
    pipeline: r.pipeline_name,
    stage: r.status_name,
    kind: r.pay_kind,
    paid: Number(r.price) || 0,
    deal_sum: Number(r.deal_sum) || 0,
    debt: Number(r.debt) || 0,
    payment_type: r.payment_type,
    at: r.stage_at,
    ext: r.operator_ext,
    operator: opName(r.operator_ext),
    manager: cleanManagerName(r.responsible_name),
    url: sub ? `https://${host}/leads/detail/${r.lead_id}` : null,
  });

  const kinds: Record<'partial' | 'pending' | 'full', Bucket> = { partial: bucket(), pending: bucket(), full: bucket() };
  const ops = new Map<string, { ext: string | null; name: string; count: number; full: number; paid: number; debt: number }>();
  const mgrs = new Map<string, { name: string; count: number; full: number; paid: number; debt: number }>();
  const types = new Map<string, Bucket>();
  let paid = 0, deal = 0, debt = 0;
  for (const r of rows) {
    const p = Number(r.price) || 0;
    const d = Number(r.debt) || 0;
    paid += p; deal += Number(r.deal_sum) || 0; debt += d;
    const k = kinds[r.pay_kind as 'partial' | 'pending' | 'full'];
    if (k) { k.count += 1; k.sum += p; }
    const ext = r.operator_ext;
    const ok = ext ?? '—';
    const o = ops.get(ok) || { ext, name: opName(ext) ?? 'Qo\'ng\'iroq topilmadi', count: 0, full: 0, paid: 0, debt: 0 };
    o.count += 1; o.paid += p; o.debt += d; if (r.pay_kind === 'full') o.full += 1;
    ops.set(ok, o);
    const mn = cleanManagerName(r.responsible_name) ?? '—';
    const m = mgrs.get(mn) || { name: mn, count: 0, full: 0, paid: 0, debt: 0 };
    m.count += 1; m.paid += p; m.debt += d; if (r.pay_kind === 'full') m.full += 1;
    mgrs.set(mn, m);
    for (const t of String(r.payment_type ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
      const b = types.get(t) || bucket();
      b.count += 1; b.sum += p;
      types.set(t, b);
    }
  }
  const byPaid = <T extends { paid: number; count: number }>(a: T, b: T) => b.paid - a.paid || b.count - a.count;

  return {
    ready: true as const,
    connected: true as const,
    enabled: !!(integ as any).enabled,
    pull_at: (integ as any).pull_at ?? null,
    pull_error: (integ as any).pull_error ?? null,
    totals: { deals: rows.length, paid, deal_sum: deal, debt, ...kinds },
    debt_all: {
      count: debtors.length,
      sum: debtors.reduce((a, r) => a + (Number(r.debt) || 0), 0),
      top: debtors.slice(0, 10).map(view),
    },
    operators: [...ops.values()].sort(byPaid),
    managers: [...mgrs.values()].sort(byPaid).slice(0, 20),
    payment_types: [...types.entries()].map(([type, b]) => ({ type, ...b })).sort((a, b) => b.sum - a.sum || b.count - a.count),
    recent: rows.slice(0, 30).map(view),
  };
}
