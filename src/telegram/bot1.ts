import { bot1 } from './bot1Client';
import { dbSession, resetSession, type SessionContext } from './dbSession';
import { resolveDeeplinkToken } from '../lib/deeplinkToken';
import {
  handleStart,
  sendPlatformInfo,
  sendPricingBrowse,
  sendAdminContactInfo,
  cancelFlow,
} from './handlers/menu';
import {
  startPurchaseFlow,
  onTariffSelected,
  onTariffConfirm,
  handleEmployeeCount,
  onDurationSelected,
  onFinalConfirm,
  handleName,
  handlePhoneContact,
  handlePhoneText,
  handleCompany,
} from './handlers/purchase';
import { handleFreeformQuestion } from './handlers/faq';
import { MENU_INFO, MENU_PRICING, MENU_BUY, MENU_ADMIN, MENU_GET_CODE, MENU_UPGRADE } from './keyboards';
import {
  enterGetCodeFlow,
  enterUpgradeFlow,
  enterGetCodeFlowFromMenu,
  enterUpgradeFlowFromMenu,
  handleMenuGetCodePhoneText,
  handlePaidNo,
  handlePaidYes,
  handleGetCodeTariffSelected,
  handleUpgradePhoneText,
  handleUpgradeTariffSelected,
  handleUpgradeConfirm,
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
    if (resolved.purpose === 'get_code') return enterGetCodeFlow(ctx as SessionContext, resolved.companyId);
    if (resolved.purpose === 'upgrade') return enterUpgradeFlow(ctx as SessionContext, resolved.companyId);
  }
  return handleStart(ctx as SessionContext);
});
bot1.command('cancel', (ctx) => cancelFlow(ctx as SessionContext));

// --- Eski marketing oqimi (callback tugmalari) ---
bot1.action(/^tariff:(.+)$/, (ctx) => onTariffSelected(ctx as any));
bot1.action(/^tariff_confirm:(yes|no)$/, (ctx) => onTariffConfirm(ctx as any));
bot1.action(/^duration:(\d+)$/, (ctx) => onDurationSelected(ctx as any));
bot1.action(/^final_confirm:(yes|no)$/, (ctx) => onFinalConfirm(ctx as any));

// --- Yangi tarif-ochish oqimi (callback tugmalari) ---
bot1.action('paid:no', (ctx) => handlePaidNo(ctx as SessionContext));
bot1.action('paid:yes', (ctx) => handlePaidYes(ctx as SessionContext));
bot1.action(/^get_code_tariff:(.+)$/, (ctx) => handleGetCodeTariffSelected(ctx as any));
bot1.action(/^upgrade_tariff:(.+)$/, (ctx) => handleUpgradeTariffSelected(ctx as any));
bot1.action(/^upgrade_confirm:(yes|no)$/, (ctx) => handleUpgradeConfirm(ctx as any));

bot1.on('contact', (ctx) => handlePhoneContact(ctx as SessionContext));

bot1.on('text', async (ctx) => {
  const sctx = ctx as SessionContext;
  const text = (ctx.message as any).text.trim();
  const step = sctx.session.step;
  const state = sctx.session.state;

  // Yangi oqim matn-kutish bosqichlari — eng avval tekshiriladi.
  if (step === 'upgrade_awaiting_phone') return handleUpgradePhoneText(sctx, text);
  if (step === 'menu_get_code_awaiting_phone') return handleMenuGetCodePhoneText(sctx, text);

  // Eski marketing oqimi bosqichlari.
  if (state === 'awaiting_employee_count') return handleEmployeeCount(sctx, text);
  if (state === 'awaiting_name') return handleName(sctx, text);
  if (state === 'awaiting_phone') return handlePhoneText(sctx, text);
  if (state === 'awaiting_company') return handleCompany(sctx, text);

  if (text === MENU_INFO) return sendPlatformInfo(sctx);
  if (text === MENU_PRICING) return sendPricingBrowse(sctx);
  if (text === MENU_BUY) return startPurchaseFlow(sctx);
  if (text === MENU_GET_CODE) return enterGetCodeFlowFromMenu(sctx);
  if (text === MENU_UPGRADE) return enterUpgradeFlowFromMenu(sctx);
  if (text === MENU_ADMIN) return sendAdminContactInfo(sctx);
  if (text === '❌ Bekor qilish') return cancelFlow(sctx);

  return handleFreeformQuestion(sctx, text);
});

bot1.catch((err, ctx) => {
  console.error(`Bot1 xatosi (update ${ctx.updateType}):`, err);
  ctx.reply("Kechirasiz, kutilmagan xatolik yuz berdi. Iltimos, /cancel yuborib qayta urinib ko'ring yoki admin bilan bog'laning.").catch(() => {});
});

export { bot1 };
export async function resetBot1Session(ctx: SessionContext) { await resetSession(ctx); }
