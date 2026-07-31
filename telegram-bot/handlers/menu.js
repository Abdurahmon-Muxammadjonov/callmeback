import { TARIFFS, TARIFF_ORDER, formatSum } from '../pricing.js';
import { MAIN_MENU } from '../keyboards.js';
import { resetSession } from '../session.js';
import { logEvent } from '../db.js';

export async function handleStart(ctx) {
  const firstName = ctx.from?.first_name || 'do\'stim';
  resetSession(ctx);
  await logEvent(ctx.from.id, 'start');
  await ctx.reply(
    `Assalomu alaykum, hurmatli ${firstName}! Bizning platformamizga xush kelibsiz. Qanday yordam kerak?`,
    MAIN_MENU,
  );
}

export async function sendPlatformInfo(ctx) {
  await logEvent(ctx.from.id, 'view_info');
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

export async function sendPricingBrowse(ctx) {
  await logEvent(ctx.from.id, 'view_pricing');
  const lines = TARIFF_ORDER.map((key, i) => {
    const t = TARIFFS[key];
    return `${i + 1}. *${t.name}*${t.popular ? ' ⭐ (eng mashhur)' : ''} — ${formatSum(t.pricePerEmployee)} so'm/xodim/oy\n   ${t.headline.join(' · ')}`;
  });
  await ctx.reply(
    ['*Tariflarimiz* (xodimlar soni 1 dan cheksizgacha):', '', ...lines].join('\n\n'),
    { parse_mode: 'Markdown' },
  );
}

export async function sendAdminContactInfo(ctx) {
  await logEvent(ctx.from.id, 'admin_contact_requested');
  await ctx.reply(
    "Operatorlarimiz tez orada siz bilan bog'lanadi. Shoshilinch bo'lsa, to'g'ridan-to'g'ri administratorga yozing.",
    MAIN_MENU,
  );
}

export async function cancelFlow(ctx) {
  resetSession(ctx);
  await ctx.reply('Amal bekor qilindi.', MAIN_MENU);
}
