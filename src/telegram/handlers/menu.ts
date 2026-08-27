import { TARIFFS, TARIFF_ORDER, formatSum } from '../pricing';
import { MAIN_MENU } from '../keyboards';
import { resetSession, type SessionContext } from '../dbSession';
import { logEvent } from '../leadsDb';
import { bot2 } from '../bot2';
import { escapeMarkdown } from '../tariffFlow';

export async function handleStart(ctx: SessionContext): Promise<void> {
  const firstName = (ctx.from as any)?.first_name || "do'stim";
  await resetSession(ctx);
  await logEvent(ctx.from!.id, 'start');
  await ctx.reply(
    `Assalomu alaykum, hurmatli ${firstName}! Bizning platformamizga xush kelibsiz. Qanday yordam kerak?`,
    MAIN_MENU,
  );
}

export async function sendPlatformInfo(ctx: SessionContext): Promise<void> {
  await logEvent(ctx.from!.id, 'view_info');
  await ctx.reply(
    [
      "*SalesPulse* — sotuv/call-markaz jamoalari uchun AI asosidagi qo'ng'iroqlarni audit qilish platformasi.",
      '',
      'Asosiy imkoniyatlar:',
      "🎙️ *Audio tahlil* — har bir qo'ng'iroqni transkripsiya qilish, ohang va his-tuyg'uni aniqlash",
      '📈 *Sotuv jarayoni nazorati* — bosqichlar, skript va konversiyani kuzatish',
      "✅ *Vazifa/jarayon monitoringi* — xodimlar faoliyatini avtomatik kuzatish",
      "⏱️ *Konversiya va vaqt metrikalari* — KPI, javob vaqti, jarima/bonus hisob-kitobi",
      "🤖 *AI chat yordamchi* (yuqori tarifda) — jamoa bilan interaktiv AI muloqot",
      '',
      "Batafsil ma'lumot uchun 📊 *Tariflar bilan tanishish* yoki 🛒 *Sotib olmoqchiman* tugmasini bosing.",
    ].join('\n'),
    { parse_mode: 'Markdown' },
  );
}

export async function sendPricingBrowse(ctx: SessionContext): Promise<void> {
  await logEvent(ctx.from!.id, 'view_pricing');
  const lines = TARIFF_ORDER.map((key, i) => {
    const t = TARIFFS[key];
    return `${i + 1}. *${t.name}*${t.popular ? ' ⭐ (eng mashhur)' : ''} — ${formatSum(t.pricePerEmployee)} so'm/xodim/oy\n   ${t.headline.join(' · ')}`;
  });
  await ctx.reply(
    ['*Tariflarimiz* (xodimlar soni 1 dan cheksizgacha):', '', ...lines].join('\n\n'),
    { parse_mode: 'Markdown' },
  );
}

export async function sendAdminContactInfo(ctx: SessionContext): Promise<void> {
  await logEvent(ctx.from!.id, 'admin_contact_requested');
  await ctx.reply(
    "Operatorlarimiz tez orada siz bilan bog'lanadi. Shoshilinch bo'lsa, to'g'ridan-to'g'ri administratorga yozing.",
    MAIN_MENU,
  );
}

// ============================================================================
// "Etiroz/Tavsiya" — xodim/mijoz fikr yozadi, matn to'g'ridan-to'g'ri
// Bot 2'ga (adminlarga) forward qilinadi. Hech qanday DB'ga yozilmaydi —
// faqat oddiy relay (foydalanuvchi shunday so'radi).
// ============================================================================
export async function enterFeedbackFlow(ctx: SessionContext): Promise<void> {
  await resetSession(ctx);
  ctx.session.step = 'feedback_awaiting_text';
  await ctx.reply("Fikr-mulohaza, taklif yoki shikoyatingizni yozing:");
}

export async function handleFeedbackText(ctx: SessionContext, text: string): Promise<void> {
  const adminIds = (process.env.ADMIN_TELEGRAM_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (adminIds.length === 0) {
    console.error("ADMIN_TELEGRAM_IDS sozlanmagan — fikr-mulohazani hech kimga yuborib bo'lmadi.");
  } else {
    const message = [
      "📝 *Yangi etiroz/tavsiya*",
      '',
      `💬 Telegram: ${ctx.from!.username ? '@' + escapeMarkdown(ctx.from!.username) : "username yo'q"} (id: ${ctx.from!.id})`,
      `🕐 Vaqt: ${new Date().toISOString()}`,
      '',
      escapeMarkdown(text),
    ].join('\n');
    for (const adminId of adminIds) {
      try {
        await bot2.telegram.sendMessage(adminId, message, { parse_mode: 'Markdown' });
      } catch (e: any) {
        console.error(`Bot2'ga fikr-mulohaza yuborishda xato (adminId=${adminId}):`, e?.message);
      }
    }
  }

  await ctx.reply('Rahmat! Fikringiz yuborildi.', MAIN_MENU);
  await resetSession(ctx);
}

export async function cancelFlow(ctx: SessionContext): Promise<void> {
  await resetSession(ctx);
  await ctx.reply('Amal bekor qilindi.', MAIN_MENU);
}
