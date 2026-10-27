// ============================================================================
// TARGET TAHLIL — Meta Ads (2026-10-27, foydalanuvchi talabi: "target analiz
// qo'sh"; xarajat manbai — Meta Ads ulanishi).
//
//   Ulanish   — company_integrations provider='meta': config { account_id,
//               account_name, currency, token_enc } (token AES-GCM, crmPush
//               bilan bir xil maqsad kaliti).
//   Sinxron   — worker har META_PULL_MINUTES (standart 60): ad darajasida
//               kunlik insights (birinchi marta 90 kun, keyin oxirgi 3 kun —
//               Meta kechikkan konversiyalarni qayta hisoblaydi) → meta_ad_insights;
//               kreativlar (nom, holat, rasm) → meta_ads.
//   Bog'lash  — amoCRM lidi: utm_content = kreativ nomi ("reels2" ↔ "Reels 2"),
//               normKey bilan; utm_content'siz target lidlar (manba
//               Instagram/Facebook) faqat umumiy CPL'ga kiradi.
//   Sifat     — lid telefoni bo'yicha AI qo'ng'iroq tahlili (sifatli/sifatsiz).
//   Valyuta   — hisob USD bo'lsa so'mga CBU kursi bilan (kuniga bir marta).
// ============================================================================

import { supabase } from './supabase';
import { addDays, dayBounds, tashkentDay } from './tashkentTime';
import { decryptFor } from './passwordVault';
import { CRM_SECRET_PURPOSE } from './crmPush';
import { PAY_KINDS } from './crmDeals';

const GRAPH = `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || 'v23.0'}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function metaGet(path: string, token: string, params: Record<string, string> = {}): Promise<any> {
  const url = path.startsWith('http') ? new URL(path) : new URL(`${GRAPH}${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  if (!url.searchParams.has('access_token')) url.searchParams.set('access_token', token);
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    const j: any = await r.json().catch(() => ({}));
    if (r.ok) return j;
    const code = Number(j?.error?.code);
    // 4/17/32/613 — so'rov chegarasi: kutib qayta urinamiz.
    if ([4, 17, 32, 613].includes(code) && attempt < 3) { await sleep(5_000 * (attempt + 1)); continue; }
    const msg = j?.error?.message ? String(j.error.message) : `HTTP ${r.status}`;
    throw new Error(code === 190 ? `Meta token yaroqsiz yoki muddati tugagan: ${msg}` : `Meta: ${msg}`);
  }
}

export const normAccountId = (v: unknown) => {
  const d = String(v ?? '').replace(/^act_/, '').replace(/\D/g, '');
  return d ? `act_${d}` : null;
};

/** Token egasiga ochiq reklama hisoblari (ulashda tanlash uchun). */
export async function listAdAccounts(token: string) {
  const j = await metaGet('/me/adaccounts', token, { fields: 'account_id,name,currency,account_status', limit: '100' });
  return ((j?.data ?? []) as any[]).map((a) => ({ id: `act_${a.account_id}`, name: String(a.name ?? a.account_id), currency: String(a.currency ?? ''), active: Number(a.account_status) === 1 }));
}

export async function accountInfo(token: string, accountId: string) {
  const a = await metaGet(`/${accountId}`, token, { fields: 'name,currency,account_status,timezone_name' });
  return { id: accountId, name: String(a?.name ?? accountId), currency: String(a?.currency ?? 'USD'), active: Number(a?.account_status) === 1, timezone: a?.timezone_name ?? null };
}

/** Kreativ nomini solishtirish kaliti: "Reels 2" / "reels-2" / "REELS_2" → "reels2". */
export const normKey = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9а-яёўқғҳ]/gi, '');

/** Meta "actions" ichidan lid va yozishuv sonlari. */
export function actionCounts(actions: Array<{ action_type?: string; value?: string }> | null | undefined) {
  let leads = 0;
  let messages = 0;
  for (const a of actions ?? []) {
    const t = String(a.action_type ?? '');
    const v = Number(a.value) || 0;
    if (t === 'lead' || t === 'onsite_conversion.lead_grouped') leads = Math.max(leads, v);
    if (t === 'onsite_conversion.messaging_conversation_started_7d') messages += v;
  }
  return { leads, messages };
}

// ---------------------------------------------------------------- valyuta
let usdRate: { day: string; rate: number } | null = null;
/** CBU rasmiy kursi (1 USD = N so'm); olinmasa META_USD_RATE yoki 12 800. */
export async function usdToUzs(): Promise<number> {
  const today = tashkentDay(new Date());
  if (usdRate?.day === today) return usdRate.rate;
  try {
    const r = await fetch('https://cbu.uz/uz/arkhiv-kursov-valyut/json/USD/', { signal: AbortSignal.timeout(10_000) });
    const j: any = await r.json();
    const rate = Number(String(j?.[0]?.Rate ?? '').replace(',', '.'));
    if (rate > 1000) { usdRate = { day: today, rate }; return rate; }
  } catch { /* zaxira kurs */ }
  return usdRate?.rate ?? (Number(process.env.META_USD_RATE) || 12_800);
}

// ---------------------------------------------------------------- sinxron
interface MetaRow { id: string; config: any; enabled: boolean; pull_at?: string | null }

const running = new Set<string>();

export async function syncMetaAds(companyId: string): Promise<{ rows: number; ads: number } | null> {
  if (running.has(companyId)) return null;
  running.add(companyId);
  const { data: integ } = await supabase
    .from('company_integrations').select('id, config, enabled, pull_at')
    .eq('company_id', companyId).eq('provider', 'meta').maybeSingle();
  const row = integ as MetaRow | null;
  try {
    if (!row || !row.enabled) return null;
    const token = decryptFor(CRM_SECRET_PURPOSE, row.config?.token_enc);
    const account = normAccountId(row.config?.account_id);
    if (!token || !account) throw new Error('Meta token yoki reklama hisobi sozlanmagan.');
    const today = tashkentDay(new Date());
    const since = row.pull_at ? addDays(today, -3) : addDays(today, -90);
    let next: string | null = `${GRAPH}/${account}/insights`;
    const params: Record<string, string> = {
      level: 'ad',
      time_increment: '1',
      time_range: JSON.stringify({ since, until: today }),
      fields: 'date_start,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,spend,impressions,clicks,reach,actions,account_currency',
      limit: '500',
    };
    const out: any[] = [];
    for (let page = 0; next && page < 60; page++) {
      const j = await metaGet(next, token, page === 0 ? params : {});
      for (const r of (j?.data ?? []) as any[]) {
        const { leads, messages } = actionCounts(r.actions);
        out.push({
          company_id: companyId, day: r.date_start, ad_id: String(r.ad_id),
          ad_name: r.ad_name ?? null, adset_id: r.adset_id ?? null, adset_name: r.adset_name ?? null,
          campaign_id: r.campaign_id ?? null, campaign_name: r.campaign_name ?? null,
          spend: Number(r.spend) || 0, impressions: Number(r.impressions) || 0, clicks: Number(r.clicks) || 0, reach: Number(r.reach) || 0,
          leads, messages, currency: r.account_currency ?? row.config?.currency ?? null, synced_at: new Date().toISOString(),
        });
      }
      next = j?.paging?.next ?? null;
    }
    for (let i = 0; i < out.length; i += 500) {
      const { error } = await supabase.from('meta_ad_insights').upsert(out.slice(i, i + 500), { onConflict: 'company_id,day,ad_id' });
      if (error) throw new Error(`meta_ad_insights: ${error.message}`);
    }
    // Kreativlar: nom, holat, kichik rasm.
    const ads: any[] = [];
    let nextAds: string | null = `${GRAPH}/${account}/ads`;
    for (let page = 0; nextAds && page < 20; page++) {
      const j = await metaGet(nextAds, token, page === 0 ? { fields: 'id,name,effective_status,campaign_id,adset_id,creative{thumbnail_url,image_url}', limit: '200' } : {});
      for (const a of (j?.data ?? []) as any[]) {
        ads.push({
          company_id: companyId, ad_id: String(a.id), name: a.name ?? null, status: a.effective_status ?? null,
          campaign_id: a.campaign_id ?? null, adset_id: a.adset_id ?? null,
          thumbnail_url: a.creative?.thumbnail_url ?? a.creative?.image_url ?? null, updated_at: new Date().toISOString(),
        });
      }
      nextAds = j?.paging?.next ?? null;
    }
    for (let i = 0; i < ads.length; i += 500) {
      const { error } = await supabase.from('meta_ads').upsert(ads.slice(i, i + 500), { onConflict: 'company_id,ad_id' });
      if (error) throw new Error(`meta_ads: ${error.message}`);
    }
    await supabase.from('company_integrations').update({ pull_at: new Date().toISOString(), pull_error: null, last_error: null }).eq('id', row.id);
    return { rows: out.length, ads: ads.length };
  } catch (e: any) {
    const msg = String(e?.message || e).slice(0, 300);
    if (row) await supabase.from('company_integrations').update({ pull_error: msg }).eq('id', row.id);
    console.warn(`Meta Ads sinxroni xatosi (company=${companyId}):`, msg);
    throw e;
  } finally {
    running.delete(companyId);
  }
}

let metaStarted = false;
export function startMetaAdsSync(): void {
  const minutes = Number(process.env.META_PULL_MINUTES ?? 60);
  if (metaStarted || !(minutes > 0)) return;
  metaStarted = true;
  const tick = async () => {
    const { data, error } = await supabase.from('company_integrations').select('company_id').eq('provider', 'meta').eq('enabled', true);
    if (error) return;
    for (const r of (data || []) as Array<{ company_id: string }>) {
      try {
        const res = await syncMetaAds(r.company_id);
        if (res) console.log(`📣 Meta Ads sinxron (company=${r.company_id}): ${res.rows} kunlik qator, ${res.ads} kreativ.`);
      } catch { /* pull_error'ga yozilgan */ }
    }
  };
  setTimeout(() => { void tick().catch(() => {}); }, 45_000).unref();
  setInterval(() => { void tick().catch(() => {}); }, minutes * 60_000).unref();
  console.log(`Meta Ads (target): har ${minutes} daqiqada sinxron.`);
}

// ---------------------------------------------------------------- hisobot
/** Target lid: kreativi bor yoki manba Instagram/Facebook/target. */
export const TARGET_SOURCE_RE = /^(instagram|ig|insta|facebook|fb|target|meta)$/i;

const r1 = (v: number) => Math.round(v * 10) / 10;

interface Agg { spend: number; impressions: number; clicks: number; metaLeads: number; messages: number; leads: number; qualified: number; unqualified: number; sales: number; revenue: number; paid: number }
const agg = (): Agg => ({ spend: 0, impressions: 0, clicks: 0, metaLeads: 0, messages: 0, leads: 0, qualified: 0, unqualified: 0, sales: 0, revenue: 0, paid: 0 });

function metrics(a: Agg) {
  // Xarajat yo'q (Meta ulanmagan yoki bu kreativga sarflanmagan) — narxlar "0" emas, null.
  const paidAds = a.spend > 0;
  return {
    ...a,
    spend: Math.round(a.spend),
    ctr: a.impressions ? r1((a.clicks / a.impressions) * 100) : null,
    cpc: paidAds && a.clicks ? Math.round(a.spend / a.clicks) : null,
    cpl: paidAds && a.leads ? Math.round(a.spend / a.leads) : null,
    cpql: paidAds && a.qualified ? Math.round(a.spend / a.qualified) : null,
    cps: paidAds && a.sales ? Math.round(a.spend / a.sales) : null,
    conv: a.leads ? r1((a.sales / a.leads) * 100) : null,
    qualifiedShare: a.qualified + a.unqualified ? r1((a.qualified / (a.qualified + a.unqualified)) * 100) : null,
    roas: a.spend > 0 ? Math.round((a.revenue / a.spend) * 100) / 100 : null,
    romi: a.spend > 0 ? r1(((a.revenue - a.spend) / a.spend) * 100) : null,
  };
}

async function loadAll<T>(build: (from: number, to: number) => any, cap = 50_000): Promise<T[]> {
  const out: T[] = [];
  for (let off = 0; off < cap; off += 1000) {
    const { data, error } = await build(off, off + 999);
    if (error) throw new Error(error.message);
    out.push(...((data || []) as T[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

/** Lid telefonlari bo'yicha AI sifati: phone9 → 'qualified' | 'unqualified'. */
async function qualityByPhone(companyId: string, phones: string[]): Promise<Map<string, 'qualified' | 'unqualified'>> {
  const out = new Map<string, 'qualified' | 'unqualified'>();
  for (let i = 0; i < phones.length; i += 100) {
    const variants = phones.slice(i, i + 100).flatMap((p) => [p, `998${p}`, `+998${p}`]);
    const { data } = await supabase
      .from('calls').select('client_phone, new_leads_count, bad_leads_count, kpi_score')
      .eq('company_id', companyId).in('client_phone', variants).gt('kpi_score', 0).limit(5000);
    for (const c of (data || []) as any[]) {
      const p = String(c.client_phone ?? '').replace(/\D/g, '').slice(-9);
      if (Number(c.bad_leads_count) > 0) { if (!out.has(p)) out.set(p, 'unqualified'); }
      else if (Number(c.new_leads_count) > 0) out.set(p, 'qualified');
    }
  }
  return out;
}

export async function computeTarget(companyId: string, from: string, to: string) {
  const { data: integ, error: iErr } = await supabase
    .from('company_integrations').select('enabled, config, pull_at, pull_error')
    .eq('company_id', companyId).eq('provider', 'meta').maybeSingle();
  if (iErr) return { ready: false as const };
  const start = dayBounds(from).from;
  const end = dayBounds(addDays(to, 1)).from;
  const currency = String((integ as any)?.config?.currency ?? 'USD');
  const rate = currency === 'UZS' ? 1 : await usdToUzs();

  const [ins, ads, leads] = await Promise.all([
    integ ? loadAll<any>((a, b) => supabase.from('meta_ad_insights')
      .select('day, ad_id, ad_name, campaign_id, campaign_name, adset_name, spend, impressions, clicks, leads, messages')
      .eq('company_id', companyId).gte('day', from).lte('day', to).order('day').range(a, b)) : Promise.resolve([]),
    integ ? loadAll<any>((a, b) => supabase.from('meta_ads').select('ad_id, name, status, thumbnail_url').eq('company_id', companyId).range(a, b), 5000) : Promise.resolve([]),
    loadAll<any>((a, b) => supabase.from('crm_leads')
      .select('lead_id, crm_created_at, first_paid_at, pay_kind, price, deal_sum, source, utm_source, utm_content, client_phone9')
      .eq('company_id', companyId).gte('crm_created_at', start).lt('crm_created_at', end).range(a, b)),
  ]);
  // Meta ulanmagan bo'lsa ham CRM tomoni (lid, sifat, sotuv) ko'rinadi — xarajatsiz.
  const isTarget = (l: any) => !!l.utm_content || TARGET_SOURCE_RE.test(String(l.source ?? '').trim()) || TARGET_SOURCE_RE.test(String(l.utm_source ?? '').trim());
  const tLeads = (leads as any[]).filter(isTarget);
  const quality = await qualityByPhone(companyId, [...new Set(tLeads.map((l) => l.client_phone9).filter(Boolean))] as string[]);
  const sold = (l: any) => PAY_KINDS.includes(l.pay_kind) && l.first_paid_at;
  const amount = (l: any) => (Number(l.deal_sum) > 0 ? Number(l.deal_sum) : Number(l.price) || 0);

  // Kreativ kaliti: ad nomi (normKey) ↔ utm_content.
  const adMeta = new Map((ads as any[]).map((a) => [String(a.ad_id), a]));
  const byAd = new Map<string, Agg & { id: string; name: string; campaign: string | null; status: string | null; thumb: string | null }>();
  const byCampaign = new Map<string, Agg & { id: string; name: string }>();
  const byDay = new Map<string, Agg>();
  const keyToAd = new Map<string, string>();
  const total = agg();

  for (const r of ins as any[]) {
    const spend = (Number(r.spend) || 0) * rate;
    const id = String(r.ad_id);
    const m = adMeta.get(id);
    const name = String(r.ad_name ?? m?.name ?? id);
    let a = byAd.get(id);
    if (!a) { a = { ...agg(), id, name, campaign: r.campaign_name ?? null, status: m?.status ?? null, thumb: m?.thumbnail_url ?? null }; byAd.set(id, a); }
    const cid = String(r.campaign_id ?? '—');
    let c = byCampaign.get(cid);
    if (!c) { c = { ...agg(), id: cid, name: String(r.campaign_name ?? cid) }; byCampaign.set(cid, c); }
    const d = byDay.get(r.day) ?? agg();
    for (const x of [a, c, d, total]) {
      x.spend += spend; x.impressions += Number(r.impressions) || 0; x.clicks += Number(r.clicks) || 0;
      x.metaLeads += Number(r.leads) || 0; x.messages += Number(r.messages) || 0;
    }
    byDay.set(r.day, d);
    const k = normKey(name);
    if (k && !keyToAd.has(k)) keyToAd.set(k, id);
    keyToAd.set(normKey(id), id); // utm_content ba'zan reklama ID'si (120245426592130623)
  }

  // CRM lidlari: kreativga (utm_content), bo'lmasa faqat umumiyga.
  const unmatched = new Map<string, Agg & { name: string }>();
  for (const l of tLeads) {
    const q = l.client_phone9 ? quality.get(l.client_phone9) : undefined;
    const s = sold(l);
    const rev = s ? amount(l) : 0;
    const paid = s ? Number(l.price) || 0 : 0;
    const add = (x: Agg) => {
      x.leads += 1;
      if (q === 'qualified') x.qualified += 1;
      if (q === 'unqualified') x.unqualified += 1;
      if (s) { x.sales += 1; x.revenue += rev; x.paid += paid; }
    };
    add(total);
    const day = tashkentDay(l.crm_created_at);
    const d = byDay.get(day) ?? agg();
    add(d);
    byDay.set(day, d);
    const adId = l.utm_content ? keyToAd.get(normKey(l.utm_content)) : undefined;
    if (adId) {
      const a = byAd.get(adId)!;
      add(a);
      const c = [...byCampaign.values()].find((x) => x.name === a.campaign);
      if (c) add(c);
    } else if (l.utm_content) {
      const k = String(l.utm_content);
      const u = unmatched.get(k) ?? { ...agg(), name: k };
      add(u);
      unmatched.set(k, u);
    }
  }

  const days: string[] = [];
  for (let d = from; d <= to && days.length < 400; d = addDays(d, 1)) days.push(d);
  const creatives = [...byAd.values()].map((a) => ({ id: a.id, name: a.name, campaign: a.campaign, status: a.status, thumb: a.thumb, ...metrics(a) }))
    .sort((x, y) => y.spend - x.spend || y.leads - x.leads);
  const T = metrics(total);

  // Qoidaga asoslangan tavsiyalar (kalit + qiymat — matn frontendda).
  const recs: Array<{ key: string; v: Record<string, string | number> }> = [];
  const withSpend = creatives.filter((c) => c.spend > 0);
  const best = [...withSpend].filter((c) => c.cpl != null && c.leads >= 3).sort((a, b) => a.cpl! - b.cpl!)[0];
  const worst = [...withSpend].filter((c) => c.cpl != null && c.leads >= 3).sort((a, b) => b.cpl! - a.cpl!)[0];
  if (best) recs.push({ key: 'bestCpl', v: { name: best.name, cpl: best.cpl!, leads: best.leads } });
  if (worst && worst !== best && best && worst.cpl! > best.cpl! * 2) recs.push({ key: 'worstCpl', v: { name: worst.name, cpl: worst.cpl!, x: r1(worst.cpl! / best.cpl!) } });
  const noLeads = withSpend.filter((c) => c.leads === 0 && c.spend >= (T.cpl ?? 0) * 2 && c.spend > 0);
  if (noLeads.length) recs.push({ key: 'noLeads', v: { n: noLeads.length, sum: Math.round(noLeads.reduce((s, c) => s + c.spend, 0)), names: noLeads.slice(0, 3).map((c) => c.name).join(', ') } });
  const junk = withSpend.filter((c) => c.qualified + c.unqualified >= 5 && (c.qualifiedShare ?? 100) < 40);
  if (junk.length) recs.push({ key: 'lowQuality', v: { names: junk.slice(0, 3).map((c) => c.name).join(', '), p: junk[0].qualifiedShare ?? 0 } });
  const topRoas = [...withSpend].filter((c) => c.roas != null && c.sales > 0).sort((a, b) => b.roas! - a.roas!)[0];
  if (topRoas) recs.push({ key: 'scale', v: { name: topRoas.name, roas: topRoas.roas! } });
  const noUtm = total.leads ? tLeads.filter((l) => !l.utm_content).length / total.leads : 0;
  if (noUtm >= 0.3) recs.push({ key: 'utm', v: { p: Math.round(noUtm * 100) } });
  if (unmatched.size) recs.push({ key: 'unmatched', v: { names: [...unmatched.keys()].slice(0, 4).join(', ') } });

  return {
    ready: true as const,
    connected: !!integ,
    enabled: !!(integ as any)?.enabled,
    account: integ ? { id: (integ as any).config?.account_id ?? null, name: (integ as any).config?.account_name ?? null, currency } : null,
    rate,
    pull_at: (integ as any)?.pull_at ?? null,
    pull_error: (integ as any)?.pull_error ?? null,
    totals: { ...T, leadsNoCreative: tLeads.filter((l) => !l.utm_content).length },
    daily: days.map((d) => ({ day: d, ...metrics(byDay.get(d) ?? agg()) })),
    campaigns: [...byCampaign.values()].map((c) => ({ id: c.id, name: c.name, ...metrics(c) })).sort((x, y) => y.spend - x.spend),
    creatives,
    unmatched: [...unmatched.values()].map((u) => ({ name: u.name, ...metrics(u) })).sort((x, y) => y.leads - x.leads),
    recs,
  };
}
