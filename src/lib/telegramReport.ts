// ============================================================================
// TELEGRAM KUN HISOBOTI (2026-10-16, foydalanuvchi talabi: "Telegramdan
// hisobot qo'shish, bot qilish").
//
// Matn — kompaniyaning tanlangan kuni: qo'ng'iroqlar, tahlil va o'rtacha
// ball, lid sifati (sifatli/sifatsiz + sabablar), eng yaxshi va e'tibor
// talab qiladigan operatorlar, operatorlar ro'yxati. Raqamlar dashboard
// bilan BIR manbadan (calls_operator_day_stats, lib/leadQuality.ts);
// ismlar — "Xodimlarni boshqarish"dagi (lib/operatorNames.ts).
//
// Yuborish: SalesPulse boti (TELEGRAM_BOT1) — chatlar telegram_report_chats
// jadvalida (supabase/tg_01_report_chats.sql). Kunlik avtomatik yuborish —
// worker (startTelegramReportScheduler), standart 20:05 Toshkent vaqti.
// ============================================================================

import { supabase } from './supabase';
import { reportRpc } from './reportRpc';
import { addDays, dayBounds, tashkentDay } from './tashkentTime';
import { getCompanySettings } from './companySettings';
import { operatorNamesByExt } from './operatorNames';
import { computeLeadQuality } from './leadQuality';
import { computeCrmMoney } from './crmDeals';
import { bot1 } from '../telegram/bot1Client';

interface OpItem { key: string; ext: string | null; calls: number; long_calls: number; scored: number; score10_sum: number; talk_sec: number }

const MONTHS_UZ = ['yanvar', 'fevral', 'mart', 'aprel', 'may', 'iyun', 'iyul', 'avgust', 'sentabr', 'oktabr', 'noyabr', 'dekabr'];

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const dayLabel = (day: string) => `${Number(day.slice(8, 10))}-${MONTHS_UZ[Number(day.slice(5, 7)) - 1]}`;
const sum = (v: number) => Math.round(v).toLocaleString('ru-RU').replace(/\u00a0/g, ' ');
const hm = (sec: number) => `${Math.floor(sec / 3600)}:${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}`;

/** Kun hisoboti matni (Telegram HTML). */
export async function buildDailyReport(companyId: string, day: string = tashkentDay(new Date())): Promise<string> {
  const settings = await getCompanySettings(supabase, companyId);
  const longSec = Math.max(1, Number(settings.qualified_call_seconds) || 60);
  const [company, items, names, lq] = await Promise.all([
    supabase.from('companies').select('name').eq('id', companyId).maybeSingle(),
    reportRpc<OpItem[]>('calls_operator_day_stats', {
      p_company_id: companyId, p_from: dayBounds(day).from, p_to: dayBounds(addDays(day, 1)).from, p_long_sec: longSec,
    }),
    operatorNamesByExt(companyId),
    computeLeadQuality(companyId, day, day),
  ]);

  const ops = (items || []).map((o) => {
    const ext = String(o.ext ?? '').trim() || null;
    const scored = n(o.scored);
    return {
      name: ext ? names.get(ext) || `Operator ${ext}` : 'Aniqlanmagan',
      calls: n(o.calls),
      long: n(o.long_calls),
      scored,
      s10: scored ? Math.round((n(o.score10_sum) / scored) * 10) / 10 : null,
      talk: n(o.talk_sec),
    };
  });
  const calls = ops.reduce((a, o) => a + o.calls, 0);
  const scored = ops.reduce((a, o) => a + o.scored, 0);
  const scoreSum = (items || []).reduce((a, o) => a + n(o.score10_sum), 0);
  const avg = scored ? Math.round((scoreSum / scored) * 10) / 10 : null;
  const talk = ops.reduce((a, o) => a + o.talk, 0);
  const ranked = ops.filter((o) => o.s10 != null && o.scored >= 1).sort((a, b) => (b.s10 ?? 0) - (a.s10 ?? 0));

  const lines: string[] = [];
  lines.push(`📊 <b>${esc(String(company.data?.name || 'Kompaniya'))}</b> — ${dayLabel(day)} hisoboti`);
  lines.push('');
  lines.push(`📞 Qo'ng'iroqlar: <b>${calls}</b> · gaplashuv ${hm(talk)}`);
  lines.push(`✅ Tahlil qilingan: <b>${scored}</b>${avg != null ? ` · o'rtacha ball <b>${avg}</b>/10` : ''}`);
  if (lq.qualified + lq.unqualified > 0) {
    lines.push(`🎯 Lidlar: <b>${lq.qualified}</b> sifatli · <b>${lq.unqualified}</b> sifatsiz`);
    const top = lq.reasons.slice(0, 3).map((r) => `${esc(r.reason)} — ${r.count}`);
    if (top.length) lines.push(`   Sifatsiz sabablari: ${top.join('; ')}`);
  }
  // CRM'dagi pul (amoCRM ulangan bo'lsa; lib/crmDeals.ts).
  const money = await computeCrmMoney(companyId, day, day).catch(() => null);
  if (money && 'totals' in money && money.totals && money.totals.deals > 0) {
    const t = money.totals;
    lines.push(`💰 To'lovlar: <b>${t.deals}</b> ta · <b>${sum(t.paid)}</b> so'm (to'liq ${t.full.count}, chek kutilmoqda ${t.pending.count}, qisman ${t.partial.count})`);
    if (t.debt > 0) lines.push(`   Qarzdorlik: ${sum(t.debt)} so'm`);
  }
  if (ranked.length) {
    const best = ranked[0];
    lines.push(`🏆 Eng yaxshi: ${esc(best.name)} — ${best.s10}/10 (${best.scored} ta baholangan)`);
    const worst = ranked[ranked.length - 1];
    if (ranked.length > 1 && (worst.s10 ?? 10) < 6) lines.push(`⚠️ E'tibor bering: ${esc(worst.name)} — ${worst.s10}/10`);
  }
  if (ops.length) {
    lines.push('');
    lines.push('👥 <b>Operatorlar</b>');
    for (const o of [...ops].sort((a, b) => b.calls - a.calls).slice(0, 15)) {
      lines.push(` • ${esc(o.name)} — ${o.calls} qo'ng'iroq, ${o.long} uzun${o.s10 != null ? `, ball ${o.s10}` : ''}`);
    }
  } else {
    lines.push('');
    lines.push("Bu kuni qo'ng'iroq bo'lmadi.");
  }
  lines.push('');
  lines.push(`🔗 https://www.procell.uz/dashboard?date=${day}`);
  return lines.join('\n');
}

export async function sendReportToChat(chatId: number | string, text: string): Promise<void> {
  await bot1.telegram.sendMessage(chatId, text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
}

/** Kompaniyaning hamma yoqilgan chatlariga yuboradi; yuborilganlar soni. */
export async function sendCompanyReport(companyId: string, day?: string): Promise<number> {
  const { data: chats, error } = await supabase
    .from('telegram_report_chats').select('id, chat_id').eq('company_id', companyId).eq('enabled', true);
  if (error) throw new Error(error.message);
  if (!chats?.length) return 0;
  const text = await buildDailyReport(companyId, day);
  let sent = 0;
  for (const c of chats as Array<{ id: string; chat_id: number }>) {
    try {
      await sendReportToChat(c.chat_id, text);
      sent += 1;
    } catch (e: any) {
      console.warn(`Telegram hisobot yuborilmadi (chat=${c.chat_id}):`, e?.message || e);
    }
  }
  return sent;
}

// ---------------------------------------------------------------------------
// Kunlik avtomatik yuborish (worker). Har daqiqa tekshiradi: Toshkent vaqti
// REPORT_HOUR:REPORT_MINUTE dan o'tgan va bugun hali yuborilmagan chatlarga
// — kun hisoboti. last_sent_day bazada: restart bo'lsa ham takror yuborilmaydi.
// ---------------------------------------------------------------------------
const REPORT_HOUR = Number(process.env.TELEGRAM_REPORT_HOUR ?? 20);
const REPORT_MINUTE = Number(process.env.TELEGRAM_REPORT_MINUTE ?? 5);

function tashkentHm(d = new Date()): { h: number; m: number } {
  const t = new Date(d.getTime() + 5 * 3600_000);
  return { h: t.getUTCHours(), m: t.getUTCMinutes() };
}

async function runDueReports(): Promise<void> {
  const { h, m } = tashkentHm();
  if (h < REPORT_HOUR || (h === REPORT_HOUR && m < REPORT_MINUTE)) return;
  const today = tashkentDay(new Date());
  const { data: due, error } = await supabase
    .from('telegram_report_chats')
    .select('id, company_id, chat_id, last_sent_day')
    .eq('enabled', true)
    .or(`last_sent_day.is.null,last_sent_day.lt.${today}`);
  if (error || !due?.length) return;
  const byCompany = new Map<string, Array<{ id: string; chat_id: number }>>();
  for (const c of due as Array<{ id: string; company_id: string; chat_id: number }>) {
    byCompany.set(c.company_id, [...(byCompany.get(c.company_id) || []), c]);
  }
  for (const [companyId, chats] of byCompany) {
    let text: string;
    try {
      text = await buildDailyReport(companyId, today);
    } catch (e: any) {
      console.warn(`Telegram hisobot tayyorlanmadi (company=${companyId}):`, e?.message || e);
      continue;
    }
    for (const c of chats) {
      try {
        await sendReportToChat(c.chat_id, text);
      } catch (e: any) {
        console.warn(`Telegram hisobot yuborilmadi (chat=${c.chat_id}):`, e?.message || e);
      }
      // Yuborilmasa ham belgilanadi — bloklangan chatga har daqiqa urinilmasin.
      await supabase.from('telegram_report_chats').update({ last_sent_day: today }).eq('id', c.id);
    }
  }
}

let schedulerStarted = false;
export function startTelegramReportScheduler(): void {
  if (schedulerStarted || (!process.env.TELEGRAM_BOT1_TOKEN && !process.env.TOKEN_BOT)) return;
  schedulerStarted = true;
  setInterval(() => { void runDueReports().catch(() => {}); }, 60_000);
  console.log(`Telegram kun hisoboti: har kuni ${String(REPORT_HOUR).padStart(2, '0')}:${String(REPORT_MINUTE).padStart(2, '0')} (Toshkent).`);
}
