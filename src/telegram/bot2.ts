import { Telegraf } from 'telegraf';
import { dbSession, type SessionContext } from './dbSession';
import { approveTariffRequest, rejectTariffRequest } from '../lib/tariffRequests';
import { SECTION_LABELS, type LockableSection } from '../lib/companySections';
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
// spec 6-band: "reject/ignore any callback from other users."
bot2.use(async (ctx, next) => {
  const id = ctx.from?.id;
  if (!id || !isWhitelistedAdmin(id)) {
    if (ctx.callbackQuery) await ctx.answerCbQuery("Ruxsat yo'q.").catch(() => {});
    return; // next() chaqirilmaydi — hech qanday handler ishlamaydi
  }
  return next();
});

bot2.command('start', async (ctx) => {
  await ctx.reply("SalesPulse admin tasdiqlash boti. Yangi to'lov so'rovlari shu yerga tushadi.");
});

bot2.action(/^tariff_approve:(.+)$/, async (ctx) => {
  const requestId = ctx.match[1];
  await ctx.answerCbQuery();
  try {
    const result = await approveTariffRequest(requestId, String(ctx.from!.id));
    const codesText = result.issuedCodes.length > 0
      ? result.issuedCodes.map((c) => `• *${SECTION_LABELS[c.sectionKey as LockableSection]}*: \`${c.code}\``).join('\n')
      : '(barcha kiritilgan bo\'limlar allaqachon ochilgan — yangi kod kerak emas)';
    await ctx.editMessageText(
      `${(ctx.callbackQuery.message as any)?.text || ''}\n\n✅ *TASDIQLANDI* (${new Date().toLocaleString('uz-UZ')})`,
      { parse_mode: 'Markdown' },
    ).catch(() => {});
    await ctx.reply(`Tasdiqlandi. Foydalanuvchiga yuborilgan kodlar:\n${codesText}`, { parse_mode: 'Markdown' });
    await notifyUserApproved(result.telegramId, result.tariffName, result.issuedCodes);
  } catch (e: any) {
    await ctx.reply(`Xato: ${e?.message || 'tasdiqlab bo\'lmadi'}`);
  }
});

bot2.action(/^tariff_reject:(.+)$/, async (ctx) => {
  const requestId = ctx.match[1];
  await ctx.answerCbQuery();
  ctx.session.rejectingRequestId = requestId;
  ctx.session.step = 'awaiting_rejection_reason';
  await ctx.reply("Rad etish sababini yozing:");
});

bot2.on('text', async (ctx) => {
  if (ctx.session.step !== 'awaiting_rejection_reason' || !ctx.session.rejectingRequestId) {
    await ctx.reply("Hozircha kutilayotgan amal yo'q. Yangi so'rovlar avtomatik shu yerga tushadi.");
    return;
  }

  const reason = (ctx.message as any).text.trim();
  const requestId = ctx.session.rejectingRequestId as string;
  ctx.session.rejectingRequestId = undefined;
  ctx.session.step = undefined;

  try {
    const result = await rejectTariffRequest(requestId, String(ctx.from!.id), reason);
    await ctx.reply(`Rad etildi. Sabab foydalanuvchiga yuborildi: "${reason}"`);
    await notifyUserRejected(result.telegramId, reason);
  } catch (e: any) {
    await ctx.reply(`Xato: ${e?.message || 'rad etib bo\'lmadi'}`);
  }
});

bot2.catch((err, ctx) => {
  console.error(`Bot2 xatosi (update ${ctx.updateType}):`, err);
});
