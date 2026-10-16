import { bot1 } from './bot1Client';
import { supabase } from '../lib/supabase';
import { buildDailyReport, sendReportToChat } from '../lib/telegramReport';
import { dbSession, resetSession, type SessionContext } from './dbSession';
import { resolveDeeplinkToken } from '../lib/deeplinkToken';
import {
  handleStart,
  sendPlatformInfo,
  sendPricingBrowse,
  sendAdminContactInfo,
  enterFeedbackFlow,
  handleFeedbackText,
  cancelFlow,
} from './handlers/menu';
import { handleFreeformQuestion } from './handlers/faq';
import { MENU_INFO, MENU_PRICING, MENU_BUY, MENU_ADMIN, MENU_GET_CODE, MENU_UPGRADE, MENU_FEEDBACK, MENU_REGISTER } from './keyboards';
import {
  enterGetCodeFlow,
  enterUpgradeFlow,
  enterGetCodeFlowFromMenu,
  enterUpgradeFlowFromMenu,
  enterRegisterChoice,
  handleRegisterChoice,
  enterCodeByEmailFlow,
  enterCodeByEmailFlowFromMenu,
  handleCodeEmailPhoneText,
  handleCodeEmailEmailText,
  handleCodeEmailTariffSelected,
  handleCodeEmailEmployeeCountText,
  handleCodeEmailConfirmPay,
  handleCodeEmailReceiptPhoto,
  handleGetCodeTariffSelected,
  handleGetCodeEmployeeCountText,
  handleGetCodeNameText,
  handleGetCodePhoneText,
  handleGetCodeCompanyNameText,
  handleGetCodeReceiptPhoto,
  handleUpgradeEmployeeCountText,
  handleUpgradePhoneText,
  handleUpgradeTariffSelected,
  handleUpgradeReceiptPhoto,
} from './tariffFlow';

bot1.use(dbSession(1));

// --- /start: deep-link (tarif-ochish oqimi) yoki oddiy marketing salomlashish ---
bot1.command('start', async (ctx) => {
  const payload = (ctx as any).startPayload as string | undefined; // "/start <payload>"
  if (payload) {
    const resolved = await resolveDeeplinkToken(payload);
    if (!resolved) {
      await ctx.reply("Havola muddati tugagan yoki allaqachon ishlatilgan. Iltimos, saytdan qayta oching.");
      return;
    }
    // "get_code" deep-link -> "Kod olish" oqimi (Reviziya 6). companyId sayt
    // orqali allaqachon ma'lum, shu sabab email so'ralmaydi — faqat telefon.
    if (resolved.purpose === 'get_code') return enterCodeByEmailFlow(ctx as SessionContext, resolved.companyId);
    if (resolved.purpose === 'upgrade') return enterUpgradeFlow(ctx as SessionContext, resolved.companyId);
    // "report" (2026-10-16) — shu chat (shaxsiy yoki guruh) kompaniyaning kun
    // hisobotlarini oladi (lib/telegramReport.ts).
    if (resolved.purpose === 'report') return linkReportChat(ctx, resolved.companyId);
  }
  return handleStart(ctx as SessionContext);
});

async function linkReportChat(ctx: any, companyId: string): Promise<void> {
  const chat = ctx.chat;
  const title = chat?.title || [chat?.first_name, chat?.last_name].filter(Boolean).join(' ') || chat?.username || null;
  const { error } = await supabase
    .from('telegram_report_chats')
    .upsert({ company_id: companyId, chat_id: chat.id, title, enabled: true }, { onConflict: 'company_id,chat_id' });
  if (error) {
    await ctx.reply("Ulab bo'lmadi. Iltimos, saytdan qayta urinib ko'ring.");
    return;
  }
  await ctx.reply("✅ Ulandi! Har kuni ish yakunida bu yerga kun hisoboti keladi. Istalgan payt /hisobot deb yozsangiz — bugungi hisobot darhol keladi.");
  try {
    await sendReportToChat(chat.id, await buildDailyReport(companyId));
  } catch { /* hisobot keyinroq ham keladi */ }
}

// /ulash <kod> — hisobotga ulash, havola ishlamagan holat uchun (2026-10-16).
// Bot bilan chat avvaldan ochiq bo'lsa, Telegram ilovasi t.me/...?start=KOD
// havolasida kodni ko'pincha yubormaydi — /start kodsiz keladi va bot oddiy
// salomlashadi. Saytdagi kodni shu buyruq bilan yuborish har doim ishlaydi.
bot1.command('ulash', async (ctx) => {
  const code = String((ctx.message as any)?.text ?? '').trim().split(/\s+/)[1] ?? '';
  if (!code) {
    await ctx.reply("Kodni ham yozing: /ulash KOD. Kodni saytdan oling: CRM ulanishi → Telegram hisobot → «Telegramga ulash».");
    return;
  }
  const resolved = await resolveDeeplinkToken(code);
  if (!resolved || resolved.purpose !== 'report') {
    await ctx.reply("Kod noto'g'ri yoki muddati tugagan. Saytda «Telegramga ulash»ni qayta bosing va yangi kodni yuboring.");
    return;
  }
  return linkReportChat(ctx, resolved.companyId);
});

// /hisobot — shu chatga ulangan kompaniya(lar)ning bugungi hisoboti.
bot1.command('hisobot', async (ctx) => {
  const { data } = await supabase.from('telegram_report_chats').select('company_id').eq('chat_id', ctx.chat.id).eq('enabled', true);
  if (!data?.length) {
    await ctx.reply("Bu chat hali hisobotga ulanmagan. Saytda: CRM ulanishi → Telegram hisobot → «Telegramga ulash».");
    return;
  }
  for (const row of data as Array<{ company_id: string }>) {
    try {
      await sendReportToChat(ctx.chat.id, await buildDailyReport(row.company_id));
    } catch {
      await ctx.reply("Hisobotni tayyorlab bo'lmadi, birozdan keyin qayta urinib ko'ring.");
    }
  }
});
bot1.command('cancel', (ctx) => cancelFlow(ctx as SessionContext));

// --- Tarif-ochish oqimi (callback tugmalari) — Part D qayta qurilishi ---
bot1.action(/^getcode_tariff:(.+)$/, (ctx) => handleGetCodeTariffSelected(ctx as any));
bot1.action(/^upgrade_tariff:(.+)$/, (ctx) => handleUpgradeTariffSelected(ctx as any));
bot1.action(/^register_choice:(new|existing)$/, (ctx) => handleRegisterChoice(ctx as any));
bot1.action(/^codeemail_tariff:(.+)$/, (ctx) => handleCodeEmailTariffSelected(ctx as any));
bot1.action(/^codeemail_pay:(yes|no)$/, (ctx) => handleCodeEmailConfirmPay(ctx as any));

// Chek surati — faqat tegishli bosqichda kutilmoqda bo'lsa ishlaydi (D.3/D.4).
bot1.on('photo', async (ctx) => {
  const sctx = ctx as SessionContext;
  const step = sctx.session.step;
  if (step === 'getcode_awaiting_receipt') return handleGetCodeReceiptPhoto(sctx);
  if (step === 'upgrade_awaiting_receipt') return handleUpgradeReceiptPhoto(sctx);
  if (step === 'codeemail_awaiting_receipt') return handleCodeEmailReceiptPhoto(sctx);
  // Kutilmagan rasm — e'tiborsiz qoldiriladi (masalan tasodifiy yuborilgan bo'lsa).
});

bot1.on('text', async (ctx) => {
  const sctx = ctx as SessionContext;
  const text = (ctx.message as any).text.trim();
  const step = sctx.session.step;

  // Matn-kutish bosqichlari.
  if (step === 'getcode_awaiting_employee_count') return handleGetCodeEmployeeCountText(sctx, text);
  if (step === 'getcode_awaiting_name') return handleGetCodeNameText(sctx, text);
  if (step === 'getcode_awaiting_phone') return handleGetCodePhoneText(sctx, text);
  if (step === 'getcode_awaiting_company_name') return handleGetCodeCompanyNameText(sctx, text);
  if (step === 'upgrade_awaiting_phone') return handleUpgradePhoneText(sctx, text);
  if (step === 'upgrade_awaiting_employee_count') return handleUpgradeEmployeeCountText(sctx, text);
  if (step === 'codeemail_awaiting_phone') return handleCodeEmailPhoneText(sctx, text);
  if (step === 'codeemail_awaiting_email') return handleCodeEmailEmailText(sctx, text);
  if (step === 'codeemail_awaiting_employee_count') return handleCodeEmailEmployeeCountText(sctx, text);
  if (step === 'feedback_awaiting_text') return handleFeedbackText(sctx, text);

  if (text === MENU_INFO) return sendPlatformInfo(sctx);
  if (text === MENU_PRICING) return sendPricingBrowse(sctx);
  // "Sotib olmoqchiman" — YANGI mijoz uchun (Kalit olish/Flow A, o'zgarishsiz).
  if (text === MENU_BUY) return enterGetCodeFlowFromMenu(sctx);
  // "Kod olish" — EMAIL orqali kompaniyani topadigan alohida oqim (Reviziya 6,
  // 2026-09-20): telefon -> saytdagi email -> tarif -> xodim -> "To'laysizmi?"
  // -> karta -> chek -> Bot 2 -> kod. Yangi (hali to'lamagan) kompaniya ham topiladi.
  if (text === MENU_GET_CODE) return enterCodeByEmailFlowFromMenu(sctx);
  // "Tarifni oshirish" — o'zgarishsiz: Flow B (telefon -> obuna -> joriy tarif -> yangi tarif).
  if (text === MENU_UPGRADE) return enterUpgradeFlowFromMenu(sctx);
  if (text === MENU_ADMIN) return sendAdminContactInfo(sctx);
  if (text === MENU_FEEDBACK) return enterFeedbackFlow(sctx);
  // "Ro'yxatdan o'tish" — yagona kirish eshigi: yangi/mavjud mijoz
  // tanlovini so'rab, shunga qarab Flow A yoki Flow B'ga yo'naltiradi.
  if (text === MENU_REGISTER) return enterRegisterChoice(sctx);
  if (text === '❌ Bekor qilish') return cancelFlow(sctx);

  return handleFreeformQuestion(sctx, text);
});

bot1.catch((err, ctx) => {
  console.error(`Bot1 xatosi (update ${ctx.updateType}):`, err);
  ctx.reply("Kechirasiz, kutilmagan xatolik yuz berdi. Iltimos, /cancel yuborib qayta urinib ko'ring yoki admin bilan bog'laning.").catch(() => {});
});

export { bot1 };
export async function resetBot1Session(ctx: SessionContext) { await resetSession(ctx); }
