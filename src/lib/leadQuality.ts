// ============================================================================
// LID SIFATI — hisob (2026-10-16). Dashboard (/analytics/lead-quality) va
// Telegram kun hisoboti (lib/telegramReport.ts) BIR manbadan.
//
// Manba — AI tahlili: sifatsiz lid — bad_leads_count > 0, sababi
// lost_reasons'da (lib/leadReasons.ts bilan toifalarga); sifatli —
// new_leads_count > 0 va bad_leads_count = 0.
// ============================================================================

import { supabase } from './supabase';
import { addDays, dayBounds } from './tashkentTime';
import { operatorNamesByExt } from './operatorNames';
import { leadReasonCategory } from './leadReasons';

export async function computeLeadQuality(companyId: string, from: string, to: string) {
  const start = dayBounds(from).from;
  const end = dayBounds(addDays(to, 1)).from;
    type Row = { id: string; operator_ext: string | null; created_at: string; new_leads_count: number | null; bad_leads_count: number | null; summary: string | null };
    const rows: Row[] = [];
    for (let off = 0; off < 10_000; off += 1000) {
      const { data, error } = await supabase
        .from('calls')
        .select('id, operator_ext, created_at, new_leads_count, bad_leads_count, summary')
        .eq('company_id', companyId)
        .gte('created_at', start)
        .lt('created_at', end)
        .or('new_leads_count.gt.0,bad_leads_count.gt.0')
        .order('created_at', { ascending: false })
        .range(off, off + 999);
      if (error) throw new Error(`Database Error: ${error.message}`);
      rows.push(...((data || []) as Row[]));
      if (!data || data.length < 1000) break;
    }

    const bad = rows.filter((r) => Number(r.bad_leads_count) > 0);
    const good = rows.filter((r) => Number(r.bad_leads_count) <= 0 && Number(r.new_leads_count) > 0);

    // Sifatsiz lidlarning sabablari (lost_reasons, 200 talab).
    const reasonByCall = new Map<string, string[]>();
    for (let i = 0; i < bad.length; i += 200) {
      const ids = bad.slice(i, i + 200).map((r) => r.id);
      const { data } = await supabase.from('lost_reasons').select('call_id, reason_text').in('call_id', ids);
      for (const lr of (data || []) as Array<{ call_id: string; reason_text: string | null }>) {
        const txt = String(lr.reason_text ?? '').trim();
        if (!txt) continue;
        reasonByCall.set(lr.call_id, [...(reasonByCall.get(lr.call_id) || []), txt]);
      }
    }
    const NO_REASON = 'Sabab yozilmagan';
    const reasonCount = new Map<string, number>();
    // Har qo'ng'iroq toifa bo'yicha bir marta sanaladi (lib/leadReasons.ts).
    for (const r of bad) {
      const list = reasonByCall.get(r.id);
      const cats = new Set((list?.length ? list : [NO_REASON]).map(leadReasonCategory));
      for (const c of cats) reasonCount.set(c, (reasonCount.get(c) || 0) + 1);
    }

    const names = await operatorNamesByExt(companyId);
    const byOp = new Map<string, { ext: string | null; name: string; qualified: number; unqualified: number }>();
    for (const r of rows) {
      const ext = String(r.operator_ext ?? '').trim() || null;
      const k = ext ?? '—';
      const o = byOp.get(k) || { ext, name: ext ? names.get(ext) || `Operator ${ext}` : 'Aniqlanmagan', qualified: 0, unqualified: 0 };
      if (Number(r.bad_leads_count) > 0) o.unqualified += 1;
      else if (Number(r.new_leads_count) > 0) o.qualified += 1;
      byOp.set(k, o);
    }


  return {
    qualified: good.length,
    unqualified: bad.length,
    reasons: [...reasonCount.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
      .slice(0, 12),
    operators: [...byOp.values()].sort((a, b) => b.unqualified + b.qualified - (a.unqualified + a.qualified)),
    recent_unqualified: bad.slice(0, 20).map((r) => ({
      id: r.id,
      ext: r.operator_ext,
      name: r.operator_ext ? names.get(String(r.operator_ext).trim()) || `Operator ${r.operator_ext}` : null,
      created_at: r.created_at,
      reasons: reasonByCall.get(r.id)?.length ? [...new Set(reasonByCall.get(r.id)!.map(leadReasonCategory))] : [NO_REASON],
      summary: r.summary,
    })),
  };
}
