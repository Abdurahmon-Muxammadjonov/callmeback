import { bot1 } from './bot1Client';
import { SECTION_LABELS, type LockableSection } from '../lib/companySections';

// Bot 2 (admin) tasdiqlagan/rad etganda mijozga Bot 1 orqali xabar
// yuboriladi — spec Part 3: "Bot 1 sends the user all generated codes" /
// "Bot 1 immediately sends the user: rejection reason".

export async function notifyUserApproved(
  telegramId: string,
  tariffName: string,
  issuedCodes: Array<{ sectionKey: LockableSection; code: string }>,
): Promise<void> {
  const codesText = issuedCodes.length > 0
    ? issuedCodes.map((c) => `• *${SECTION_LABELS[c.sectionKey]}*: \`${c.code}\``).join('\n')
    : "Barcha tegishli bo'limlar allaqachon ochilgan — qo'shimcha kod kerak emas.";

  try {
    await bot1.telegram.sendMessage(
      telegramId,
      [
        `✅ *${tariffName}* tarifi bo'yicha to'lovingiz tasdiqlandi!`,
        '',
        'Quyidagi kodlarni saytdagi tegishli qulflangan bo\'limga kiriting:',
        codesText,
        '',
        "Har bir kod faqat o'zining bo'limini ochadi va bir marta ishlatiladi.",
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
