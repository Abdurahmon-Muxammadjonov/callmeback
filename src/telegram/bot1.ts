import { bot1 } from './bot1Client';
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
import { MENU_INFO, MENU_PRICING, MENU_BUY, MENU_ADMIN, MENU_GET_CODE, MENU_UPGRADE, MENU_FEEDBACK } from './keyboards';
import {
  enterGetCodeFlow,
  enterUpgradeFlow,
  enterGetCodeFlowFromMenu,
  enterUpgradeFlowFromMenu,
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
    // "get_code" deep-link ham endi Flow B (mavjud mijoz) semantikasiga
    // ega — companyId sayt orqali (kirgan foydalanuvchi) allaqachon ma'lum,
    // shu sabab telefon-qidiruv bosqichi kerak emas (Reviziya 5).
    if (resolved.purpose === 'get_code') return enterUpgradeFlow(ctx as SessionContext, resolved.companyId);
    if (resolved.purpose === 'upgrade') return enterUpgradeFlow(ctx as SessionContext, resolved.companyId);
  }
  return handleStart(ctx as SessionContext);
});
bot1.command('cancel', (ctx) => cancelFlow(ctx as SessionContext));

// --- Tarif-ochish oqimi (callback tugmalari) — Part D qayta qurilishi ---
bot1.action(/^getcode_tariff:(.+)$/, (ctx) => handleGetCodeTariffSelected(ctx as any));
bot1.action(/^upgrade_tariff:(.+)$/, (ctx) => handleUpgradeTariffSelected(ctx as any));

// Chek surati — faqat tegishli bosqichda kutilmoqda bo'lsa ishlaydi (D.3/D.4).
bot1.on('photo', async (ctx) => {
  const sctx = ctx as SessionContext;
  const step = sctx.session.step;
  if (step === 'getcode_awaiting_receipt') return handleGetCodeReceiptPhoto(sctx);
  if (step === 'upgrade_awaiting_receipt') return handleUpgradeReceiptPhoto(sctx);
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
  if (step === 'feedback_awaiting_text') return handleFeedbackText(sctx, text);

  if (text === MENU_INFO) return sendPlatformInfo(sctx);
  if (text === MENU_PRICING) return sendPricingBrowse(sctx);
  // "Sotib olmoqchiman" — YANGI mijoz uchun (Kalit olish/Flow A, o'zgarishsiz).
  if (text === MENU_BUY) return enterGetCodeFlowFromMenu(sctx);
  // "Kod olish" va "Tarifni oshirish" — endi AYNAN BIR XIL, MAVJUD mijoz
  // uchun Flow B (telefon-qidiruv -> joriy tarif -> yangi tarif), Reviziya 5.
  if (text === MENU_GET_CODE) return enterUpgradeFlowFromMenu(sctx);
  if (text === MENU_UPGRADE) return enterUpgradeFlowFromMenu(sctx);
  if (text === MENU_ADMIN) return sendAdminContactInfo(sctx);
  if (text === MENU_FEEDBACK) return enterFeedbackFlow(sctx);
  if (text === '❌ Bekor qilish') return cancelFlow(sctx);

  return handleFreeformQuestion(sctx, text);
});

bot1.catch((err, ctx) => {
  console.error(`Bot1 xatosi (update ${ctx.updateType}):`, err);
  ctx.reply("Kechirasiz, kutilmagan xatolik yuz berdi. Iltimos, /cancel yuborib qayta urinib ko'ring yoki admin bilan bog'laning.").catch(() => {});
});

export { bot1 };
export async function resetBot1Session(ctx: SessionContext) { await resetSession(ctx); }
