import { Markup } from 'telegraf';
import { TARIFFS, TARIFF_ORDER, DURATIONS, DURATION_DISCOUNT_LABELS, monthlyTotal, formatSum } from './pricing.js';

export const MENU_INFO = "ℹ️ Platforma haqida ma'lumot";
export const MENU_PRICING = '📊 Tariflar bilan tanishish';
export const MENU_BUY = '🛒 Sotib olmoqchiman';
export const MENU_ADMIN = "👨‍💼 Admin bilan bog'lanish";

export const MAIN_MENU = Markup.keyboard([[MENU_INFO], [MENU_PRICING], [MENU_BUY], [MENU_ADMIN]])
  .resize()
  .persistent();

export const PHONE_REQUEST_KEYBOARD = Markup.keyboard([
  [Markup.button.contactRequest('📱 Raqamni yuborish')],
])
  .resize()
  .oneTime();

export function tariffInlineKeyboard() {
  const rows = TARIFF_ORDER.map((key, i) => {
    const t = TARIFFS[key];
    const label = `${i + 1}️⃣ ${t.name}${t.popular ? ' ⭐' : ''} — ${formatSum(t.pricePerEmployee)} so'm`;
    return [Markup.button.callback(label, `tariff:${key}`)];
  });
  return Markup.inlineKeyboard(rows);
}

export const TARIFF_CONFIRM_KEYBOARD = Markup.inlineKeyboard([
  [Markup.button.callback('✅ Ha, tanladim', 'tariff_confirm:yes')],
  [Markup.button.callback('❌ Bekor qilish', 'tariff_confirm:no')],
]);

export function durationInlineKeyboard(tariffKey, employeeCount) {
  const rows = DURATIONS.map((d) => {
    const total = monthlyTotal(tariffKey, d, employeeCount);
    const discount = DURATION_DISCOUNT_LABELS[d];
    const label = discount
      ? `${d} oy — ${formatSum(total)} so'm/oy (${discount})`
      : `${d} oy — ${formatSum(total)} so'm/oy`;
    return [Markup.button.callback(label, `duration:${d}`)];
  });
  return Markup.inlineKeyboard(rows);
}

export const FINAL_CONFIRM_KEYBOARD = Markup.inlineKeyboard([
  [Markup.button.callback('✅ Ha', 'final_confirm:yes')],
  [Markup.button.callback("❌ Yo'q", 'final_confirm:no')],
]);
