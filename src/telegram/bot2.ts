import { Telegraf } from 'telegraf';
import { dbSession, type SessionContext } from './dbSession';
import {
  approveKeyRequest,
  rejectKeyRequest,
  approveTariffChangeRequest,
  rejectTariffChangeRequest,
} from '../lib/tariffPayments';
import { notifyUserApproved, notifyUserRejected } from './notifyUser';

const token = process.env.TELEGRAM_BOT2_TOKEN;
if (!token) {
  // Modul yuklanganda darhol qulamaydi (server.ts boshqa narsalarni ham import
  // qiladi) — webhook route chaqirilganda aniq xabar bilan qulaydi.
  console.warn('TELEGRAM_BOT2_TOKEN sozlanmagan — Bot 2 (admin) ishlamaydi.');
}

export const bot2 = new Telegraf<SessionContext>(token || 'MISSING_TOKEN');

function isWhitelistedAdmin(telegramId: number | string): boolean {
  const raw = process.env.ADMIN_TELEGRAM_IDS || '';
  const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return ids.includes(String(telegramId));
}

bot2.use(dbSession(2));

// Har bir yangilanishda: whitelist'da yo'q foydalanuvchidan kelgan
// HAR QANDAY narsa (matn ham, callback ham) e'tiborsiz qoldiriladi —
// spec D.7 band 8: "Non-whitelisted Telegram ID cannot trigger Bot 2 actions."
bot2.use(async (ctx, next) => {
  const id = ctx.from?.id;
  if (!id || !isWhitelistedAdmin(id)) {
    if (ctx.callbackQuery) await ctx.answerCbQuery("Ruxsat yo'q.").catch(() => {});
    return; // next() chaqirilmaydi — hech qanday handler ishlamaydi
  }
  return next();
});

bot2.command('start', async (ctx) => {
  await ctx.reply("SalesPulse admin tasdiqlash boti. Yangi to'lov so'rovlari (chek surati bilan) shu yerga tushadi.");
});

// Rad etish sababi kutilayotganda emas — tasdiqlash tugmasi bosilganda,
// chek surati ostidagi caption'ni "TASDIQLANDI" deb belgilab qo'yamiz.
async function markCaptionResolved(ctx: any, verdict: string): Promise<void> {
  try {
    const original = (ctx.callbackQuery?.message as any)?.caption || '';
    await ctx.editMessageCaption(`${original}\n\n${verdict} (${new Date().toLocaleString('uz-UZ')})`, { parse_mode: 'Markdown' });
  } catch {
    // caption o'zgartirib bo'lmasa ham (masalan 48 soatdan eski xabar) — asosiy amal davom etadi
  }
}

// ============================================================================
// "Kalit olish" (key_requests) — D.5
// ============================================================================
bot2.action(/^key_approve:(.+)$/, async (ctx) => {
  const requestId = ctx.match[1];
  await ctx.answerCbQuery();
  try {
    const result = await approveKeyRequest(requestId, String(ctx.from!.id));
    await markCaptionResolved(ctx, '✅ *TASDIQLANDI*');
    await ctx.reply(`Tasdiqlandi. Foydalanuvchiga yuborilgan kalit: \`${result.code}\``, { parse_mode: 'Markdown' });
    await notifyUserApproved(result.telegramId, result.tariffName, result.code, false);
  } catch (e: any) {
    await ctx.reply(`Xato: ${e?.message || 'tasdiqlab bo\'lmadi'}`);
  }
});

bot2.action(/^key_reject:(.+)$/, async (ctx) => {
  const requestId = ctx.match[1];
  await ctx.answerCbQuery();
  ctx.session.rejectingRequestId = requestId;
  ctx.session.step = 'awaiting_key_rejection_reason';
  await ctx.reply("Rad etish sababini yozing:");
});

// ============================================================================
// "Tarifni o'zgartirish" (tariff_change_requests) — D.5
// ============================================================================
bot2.action(/^tariffchange_approve:(.+)$/, async (ctx) => {
  const requestId = ctx.match[1];
  await ctx.answerCbQuery();
  try {
    const result = await approveTariffChangeRequest(requestId, String(ctx.from!.id));
    await markCaptionResolved(ctx, '✅ *TASDIQLANDI*');
    await ctx.reply(`Tasdiqlandi. Foydalanuvchiga yuborilgan kalit: \`${result.code}\``, { parse_mode: 'Markdown' });
    await notifyUserApproved(result.telegramId, result.tariffName, result.code, true);
  } catch (e: any) {
    await ctx.reply(`Xato: ${e?.message || 'tasdiqlab bo\'lmadi'}`);
  }
});

bot2.action(/^tariffchange_reject:(.+)$/, async (ctx) => {
  const requestId = ctx.match[1];
  await ctx.answerCbQuery();
  ctx.session.rejectingRequestId = requestId;
  ctx.session.step = 'awaiting_tariffchange_rejection_reason';
  await ctx.reply("Rad etish sababini yozing:");
});

// ============================================================================
// Rad etish sababi — matn xabari orqali (har ikkala oqim uchun umumiy)
// ============================================================================
bot2.on('text', async (ctx) => {
  const step = ctx.session.step;
  const requestId = ctx.session.rejectingRequestId as string | undefined;

  if ((step !== 'awaiting_key_rejection_reason' && step !== 'awaiting_tariffchange_rejection_reason') || !requestId) {
    await ctx.reply("Hozircha kutilayotgan amal yo'q. Yangi so'rovlar avtomatik shu yerga tushadi.");
    return;
  }

  const reason = (ctx.message as any).text.trim();
  ctx.session.rejectingRequestId = undefined;
  ctx.session.step = undefined;

  try {
    if (step === 'awaiting_key_rejection_reason') {
      const result = await rejectKeyRequest(requestId, String(ctx.from!.id), reason);
      await ctx.reply(`Rad etildi. Sabab foydalanuvchiga yuborildi: "${reason}"`);
      await notifyUserRejected(result.telegramId, reason);
    } else {
      const result = await rejectTariffChangeRequest(requestId, String(ctx.from!.id), reason);
      await ctx.reply(`Rad etildi. Sabab foydalanuvchiga yuborildi: "${reason}"`);
      await notifyUserRejected(result.telegramId, reason);
    }
  } catch (e: any) {
    await ctx.reply(`Xato: ${e?.message || 'rad etib bo\'lmadi'}`);
  }
});

bot2.catch((err, ctx) => {
  console.error(`Bot2 xatosi (update ${ctx.updateType}):`, err);
});
