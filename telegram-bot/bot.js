import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { session } from './session.js';
import {
  handleStart,
  sendPlatformInfo,
  sendPricingBrowse,
  sendAdminContactInfo,
  cancelFlow,
} from './handlers/menu.js';
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
} from './handlers/purchase.js';
import { handleFreeformQuestion } from './handlers/faq.js';
import { MENU_INFO, MENU_PRICING, MENU_BUY, MENU_ADMIN } from './keyboards.js';

const token = process.env.TOKEN_BOT;
if (!token) {
  throw new Error('TOKEN_BOT .env faylida belgilanmagan.');
}

const bot = new Telegraf(token);
bot.use(session());

bot.command('start', handleStart);
bot.command('cancel', cancelFlow);

// --- Inline callback tugmalari ---
bot.action(/^tariff:(.+)$/, onTariffSelected);
bot.action(/^tariff_confirm:(yes|no)$/, onTariffConfirm);
bot.action(/^duration:(\d+)$/, onDurationSelected);
bot.action(/^final_confirm:(yes|no)$/, onFinalConfirm);

// --- Telefon raqami (Reply keyboard'dagi "Raqamni yuborish" tugmasi) ---
bot.on('contact', handlePhoneContact);

// --- Matnli xabarlar: FSM bosqichlari > asosiy menyu > erkin savol (FAQ) ---
bot.on('text', async (ctx) => {
  const text = ctx.message.text.trim();
  const state = ctx.session.state;

  if (state === 'awaiting_employee_count') return handleEmployeeCount(ctx, text);
  if (state === 'awaiting_name') return handleName(ctx, text);
  if (state === 'awaiting_phone') return handlePhoneText(ctx, text);
  if (state === 'awaiting_company') return handleCompany(ctx, text);

  if (text === MENU_INFO) return sendPlatformInfo(ctx);
  if (text === MENU_PRICING) return sendPricingBrowse(ctx);
  if (text === MENU_BUY) return startPurchaseFlow(ctx);
  if (text === MENU_ADMIN) return sendAdminContactInfo(ctx);
  if (text === "❌ Bekor qilish") return cancelFlow(ctx);

  return handleFreeformQuestion(ctx, text);
});

bot.catch((err, ctx) => {
  console.error(`Bot xatosi (update ${ctx.updateType}):`, err);
  ctx.reply("Kechirasiz, kutilmagan xatolik yuz berdi. Iltimos, /cancel yuborib qayta urinib ko'ring yoki admin bilan bog'laning.").catch(() => {});
});

bot.launch();
console.log('🤖 SalesPulse Telegram bot ishga tushdi (polling).');

// Ishonchli to'xtatish (Ctrl+C / process manager restart).
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
