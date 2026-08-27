import { bot1 } from './bot1Client';

// Bot 2 (admin) tasdiqlagan/rad etganda mijozga Bot 1 orqali xabar
// yuboriladi — D.5: "Bot 1 -> user: To'lovingiz tasdiqlandi! Kalitingiz: <code>".

export async function notifyUserApproved(telegramId: string, tariffName: string, code: string, upgraded: boolean): Promise<void> {
  const headline = upgraded ? `✅ Tarifingiz *${tariffName}*ga o'zgartirildi!` : `✅ *${tariffName}* tarifi bo'yicha to'lovingiz tasdiqlandi!`;
  try {
    await bot1.telegram.sendMessage(
      telegramId,
      [
        headline,
        '',
        `Kalitingiz: \`${code}\``,
        '',
        '1 soat amal qiladi, faqat 1 marta ishlaydi. Saytda tegishli joyga kiritib, tarifingizni faollashtiring.',
      ].join('\n'),
      { parse_mode: 'Markdown' },
    );
  } catch (e: any) {
    console.error(`notifyUserApproved: xabar yuborib bo'lmadi (telegramId=${telegramId}):`, e?.message);
  }
}

export async function notifyUserRejected(telegramId: string, reason: string): Promise<void> {
  try {
    await bot1.telegram.sendMessage(
      telegramId,
      `❌ So'rovingiz rad etildi.\n\nSabab: ${reason}\n\nSavollaringiz bo'lsa, admin bilan bog'laning.`,
    );
  } catch (e: any) {
    console.error(`notifyUserRejected: xabar yuborib bo'lmadi (telegramId=${telegramId}):`, e?.message);
  }
}
