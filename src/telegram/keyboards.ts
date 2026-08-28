import { Markup } from 'telegraf';

export const MENU_INFO = "ℹ️ Platforma haqida ma'lumot";
export const MENU_PRICING = '📊 Tariflar bilan tanishish';
// "Sotib olmoqchiman" — bot1.ts'da MENU_GET_CODE bilan AYNAN bir xil
// oqimga (tariffFlow.ts'dagi enterGetCodeFlowFromMenu) yo'naltiriladi —
// eski, alohida narx-hisoblovchi/lid yig'uvchi oqim (handlers/purchase.ts)
// olib tashlandi, chunki ikkalasi funksional jihatdan bir xil bo'lib qoldi.
export const MENU_BUY = '🛒 Sotib olmoqchiman';
export const MENU_ADMIN = "👨‍💼 Admin bilan bog'lanish";
// To'g'ridan-to'g'ri botga yozib kirilganda (deep-link'siz) ham "Kalit
// olish"/"Tarifni o'zgartirish" oqimlari ishlashi uchun (tariffFlow.ts).
export const MENU_GET_CODE = '🎟 Kod olish';
export const MENU_UPGRADE = '⬆️ Tarifni oshirish';
// Xodim/mijoz fikr-mulohaza, taklif yoki shikoyat yozadi — matn to'g'ridan
// -to'g'ri Bot 2'ga (adminlarga) yuboriladi (handlers/menu.ts'dagi
// enterFeedbackFlow/handleFeedbackText'ga qarang).
export const MENU_FEEDBACK = '📝 Etiroz/Tavsiya';

// Joylashuv: 1-tugma (kompaniya/platforma haqida) TO'LIQ qatorni egallaydi,
// qolgan 6 tasi 2 USTUN qilib (chapda 3, o'ngda 3 — har qatorda bittadan
// juft) joylashadi (foydalanuvchi shunday so'radi).
export const MAIN_MENU = Markup.keyboard([
  [MENU_INFO],
  [MENU_PRICING, MENU_UPGRADE],
  [MENU_BUY, MENU_ADMIN],
  [MENU_GET_CODE, MENU_FEEDBACK],
])
  .resize()
  .persistent();

