import { Markup } from 'telegraf';
import { supabase } from '../lib/supabase';
import { resetSession, type SessionContext } from './dbSession';
import { bot2 } from './bot2';
import { downloadAndStoreReceipt } from '../lib/receiptStorage';
import { formatSum } from './pricing';
import {
  listTariffs,
  getTariff,
  createKeyRequest,
  createTariffChangeRequest,
  findLatestSubscriptionByPhone,
  computeProratedPrice,
  isSubscriptionActive,
  type TariffRow,
  type LatestSubscription,
} from '../lib/tariffPayments';

// Part D qayta qurilishi: "Kalit olish" (D.3) va "Tarifni o'zgartirish"
// (D.4) — to'liq spec bo'yicha, chek surati + proratsiya bilan.

const PAYMENT_CARD_TEXT = "💳 Karta: 5614 6864 0400 6860 (A.L)";

// Telegram'ning (legacy) 'Markdown' parse_mode'i 4 ta belgini maxsus
// deb hisoblaydi: _ * ` [ — foydalanuvchi matnida (ism, familiya, Telegram
// username) bular JUDA ODATIY (masalan "@abdu_rahmon"), escape qilinmasa
// butun sendPhoto/sendMessage chaqiruvi "can't parse entities" bilan
// muvaffaqiyatsiz tugaydi va Bot 2 so'rovni UMUMAN OLMAYDI (xato faqat
// console.error'ga yoziladi, hech kimga ko'rinmaydi) — adversarial review'da
// topilgan CRITICAL xato, shu sabab har bir interpolatsiya qilingan
// foydalanuvchi matni shu funksiya orqali o'tishi SHART.
function escapeMarkdown(text: string): string {
  return text.replace(/([_*`[])/g, '\\$1');
}

// ============================================================================
// Umumiy: so'rovni Bot 2'ga (adminlarga) yo'llash — chek bo'lsa rasm bilan,
// bo'lmasa (finalPrice=0 — proratsiya to'liq qopladi) oddiy matn bilan.
// ============================================================================
async function forwardToBot2(params: {
  caption: string;
  receiptUrl: string | null;
  approveAction: string;
  rejectAction: string;
}): Promise<void> {
  const adminIds = (process.env.ADMIN_TELEGRAM_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (adminIds.length === 0) {
    console.error("ADMIN_TELEGRAM_IDS sozlanmagan — to'lov so'rovini hech kimga yuborib bo'lmadi.");
    return;
  }

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Tasdiqlash / Ruxsat berish', params.approveAction),
      Markup.button.callback('❌ Rad etish', params.rejectAction),
    ],
  ]);

  for (const adminId of adminIds) {
    try {
      if (params.receiptUrl) {
        await bot2.telegram.sendPhoto(adminId, params.receiptUrl, { caption: params.caption, parse_mode: 'Markdown', ...keyboard });
      } else {
        await bot2.telegram.sendMessage(adminId, params.caption, { parse_mode: 'Markdown', ...keyboard });
      }
    } catch (e: any) {
      console.error(`Bot2'ga so'rov yuborishda xato (adminId=${adminId}):`, e?.message);
    }
  }
}

function tariffSelectKeyboard(tariffs: TariffRow[], prefix: string) {
  return Markup.inlineKeyboard(
    tariffs.map((t) => [Markup.button.callback(`${t.name} — ${formatSum(t.price)} so'm`, `${prefix}:${t.id}`)]),
  );
}

async function getCompanyName(companyId: string): Promise<string> {
  const { data } = await supabase.from('companies').select('name').eq('id', companyId).maybeSingle();
  return data?.name || "Noma'lum kompaniya";
}

// Rasm xabaridan eng katta o'lchamdagi file_id'ni oladi va Bot 1'ning fayl
// URL'iga aylantiradi (downloadAndStoreReceipt shu URL'dan yuklab oladi).
async function extractReceiptUrl(ctx: SessionContext): Promise<string> {
  const photos = (ctx.message as any)?.photo as Array<{ file_id: string }> | undefined;
  if (!photos || photos.length === 0) throw new Error('Rasm topilmadi.');
  const largest = photos[photos.length - 1];
  const fileLink = await ctx.telegram.getFileLink(largest.file_id);
  return downloadAndStoreReceipt(fileLink.toString());
}

// ============================================================================
// Telefon raqami orqali kompaniya topish — deep-link'siz (menyudan to'g'ridan
// -to'g'ri kirilganda).
// ============================================================================
async function findCompanyByPhone(phone: string): Promise<{ id: string; name: string } | null> {
  const { data: user } = await supabase
    .from('users')
    .select('company_id')
    .eq('phone', phone)
    .eq('role', 'director')
    .maybeSingle();
  if (!user) return null;

  const { data: company } = await supabase.from('companies').select('id, name').eq('id', user.company_id).maybeSingle();
  return company || null;
}

// ============================================================================
// Menyudan to'g'ridan-to'g'ri kirish (deep-link'siz)
// ============================================================================
export async function enterGetCodeFlowFromMenu(ctx: SessionContext): Promise<void> {
  await resetSession(ctx);
  ctx.session.step = 'menu_get_code_awaiting_phone';
  await ctx.reply("Hisobingizni topish uchun telefon raqamingizni kiriting (masalan: +998901234567):");
}

export async function handleMenuGetCodePhoneText(ctx: SessionContext, text: string): Promise<void> {
  const phone = text.trim();
  const company = await findCompanyByPhone(phone);
  if (!company) {
    await ctx.reply("Bu raqam bilan hisob topilmadi. Iltimos, admin bilan bog'laning.");
    await resetSession(ctx);
    return;
  }
  await enterGetCodeFlow(ctx, company.id);
  // Kompaniyani aniqlash uchun ishlatilgan raqamni qayta so'ramaslik uchun
  // saqlab qo'yamiz — getcode oqimi buni ko'rib, telefon bosqichini o'tkazib yuboradi.
  ctx.session.phone = phone;
}

export async function enterUpgradeFlowFromMenu(ctx: SessionContext): Promise<void> {
  await enterUpgradeFlow(ctx, '');
}

// ============================================================================
// PART D.3 — "Kalit olish" oqimi (birinchi xarid)
// ============================================================================
export async function enterGetCodeFlow(ctx: SessionContext, companyId: string): Promise<void> {
  const phone = ctx.session.phone; // menyu-orqali kirishda allaqachon aniqlangan bo'lishi mumkin
  await resetSession(ctx);
  ctx.session.flow = 'get_code';
  ctx.session.companyId = companyId;
  if (phone) ctx.session.phone = phone;

  const tariffs = await listTariffs();
  ctx.session.step = 'getcode_selecting_tariff';
  await ctx.reply("Qaysi tarifni tanlaysiz?", tariffSelectKeyboard(tariffs, 'getcode_tariff'));
}

export async function handleGetCodeTariffSelected(ctx: SessionContext & { match: RegExpExecArray }): Promise<void> {
  const tariffId = ctx.match[1];
  await ctx.answerCbQuery();

  const tariff = await getTariff(tariffId);
  if (!tariff) { await ctx.editMessageText("Noma'lum tarif."); return; }

  ctx.session.selectedTariffId = tariffId;
  ctx.session.step = 'getcode_awaiting_name';
  await ctx.editMessageText(`Siz *${tariff.name}* tarifini tanladingiz.`, { parse_mode: 'Markdown' });
  await ctx.reply("Ism va familiyangizni kiriting:");
}

export async function handleGetCodeNameText(ctx: SessionContext, text: string): Promise<void> {
  const name = text.trim();
  if (!name) { await ctx.reply('Iltimos, ism va familiyangizni kiriting.'); return; }
  ctx.session.fullName = name;

  if (ctx.session.phone) {
    await showGetCodePaymentInfo(ctx);
    return;
  }
  ctx.session.step = 'getcode_awaiting_phone';
  await ctx.reply("Telefon raqamingizni kiriting:");
}

export async function handleGetCodePhoneText(ctx: SessionContext, text: string): Promise<void> {
  const phone = text.trim();
  ctx.session.phone = phone;
  await showGetCodePaymentInfo(ctx);
}

async function showGetCodePaymentInfo(ctx: SessionContext): Promise<void> {
  const tariff = await getTariff(ctx.session.selectedTariffId as string);
  if (!tariff) { await ctx.reply("Sessiya eskirgan. Qaytadan boshlang: /start"); await resetSession(ctx); return; }

  ctx.session.step = 'getcode_awaiting_receipt';
  await ctx.reply(
    [
      `Tanlagan tarifingiz: *${tariff.name}* — *${formatSum(tariff.price)} so'm*`,
      '',
      PAYMENT_CARD_TEXT,
      '',
      "To'lov qilgach, chek rasmini (screenshot/rasm) yuboring.",
    ].join('\n'),
    { parse_mode: 'Markdown' },
  );
}

export async function handleGetCodeReceiptPhoto(ctx: SessionContext): Promise<void> {
  const companyId = ctx.session.companyId;
  const tariffId = ctx.session.selectedTariffId;
  const fullName = ctx.session.fullName;
  const phone = ctx.session.phone;
  if (!companyId || !tariffId || !fullName || !phone) {
    await ctx.reply('Sessiya eskirgan. Qaytadan boshlang: /start');
    await resetSession(ctx);
    return;
  }

  let receiptUrl: string;
  try {
    receiptUrl = await extractReceiptUrl(ctx);
  } catch (e: any) {
    console.error('Chek rasmini saqlashda xato:', e?.message);
    await ctx.reply("Rasmni saqlab bo'lmadi. Iltimos, qayta yuboring yoki birozdan so'ng urinib ko'ring.");
    return;
  }

  const tariff = await getTariff(tariffId);
  if (!tariff) { await ctx.reply("Noma'lum tarif. Qaytadan boshlang: /start"); await resetSession(ctx); return; }

  const { id: requestId } = await createKeyRequest({
    companyId,
    tariffId,
    fullName,
    phone,
    telegramId: String(ctx.from!.id),
    receiptFileId: receiptUrl,
  });

  await ctx.reply("So'rovingiz tasdiqlash uchun yuborildi. Tez orada xabar beramiz.");
  await resetSession(ctx);

  const caption = [
    "🆕 *Yangi to'lov tasdiqlash so'rovi (Kalit olish)*",
    '',
    `🏢 Kompaniya: ${escapeMarkdown(await getCompanyName(companyId))}`,
    `👤 Ism: ${escapeMarkdown(fullName)}`,
    `📱 Telefon: ${escapeMarkdown(phone)}`,
    `💬 Telegram: ${ctx.from!.username ? '@' + escapeMarkdown(ctx.from!.username) : "username yo'q"} (id: ${ctx.from!.id})`,
    `📦 Tarif: ${tariff.name} — ${formatSum(tariff.price)} so'm`,
    `🕐 Vaqt: ${new Date().toISOString()}`,
  ].join('\n');

  await forwardToBot2({
    caption,
    receiptUrl,
    approveAction: `key_approve:${requestId}`,
    rejectAction: `key_reject:${requestId}`,
  });
}

// ============================================================================
// PART D.4 — "Tarifni o'zgartirish" oqimi (proratsiya bilan)
// ============================================================================
export async function enterUpgradeFlow(ctx: SessionContext, companyId: string): Promise<void> {
  await resetSession(ctx);
  ctx.session.flow = 'upgrade';
  ctx.session.companyId = companyId || undefined;
  ctx.session.step = 'upgrade_awaiting_name';
  await ctx.reply("Ism va familiyangizni kiriting:");
}

export async function handleUpgradeNameText(ctx: SessionContext, text: string): Promise<void> {
  const name = text.trim();
  if (!name) { await ctx.reply('Iltimos, ism va familiyangizni kiriting.'); return; }
  ctx.session.fullName = name;
  ctx.session.step = 'upgrade_awaiting_phone';
  await ctx.reply("Telefon raqamingizni kiriting:");
}

export async function handleUpgradePhoneText(ctx: SessionContext, text: string): Promise<void> {
  const phone = text.trim();
  ctx.session.phone = phone;

  // D.4 band 2: eng so'nggi subscriptions qatori TELEFON bo'yicha qidiriladi
  // — bu telefon "Kalit olish" orqali birinchi xarid qilinganda ham
  // saqlangan (src/lib/tariffPayments.ts'dagi bootstrap izohiga qarang),
  // shu sabab har qanday oldingi xaridor shu yerda topiladi.
  let sub: LatestSubscription | null;
  try {
    sub = await findLatestSubscriptionByPhone(phone);
  } catch (e: any) {
    console.error('Obuna qidirishda xato:', e?.message);
    await ctx.reply('Xatolik yuz berdi. Birozdan so\'ng qayta urinib ko\'ring.');
    return;
  }

  if (!sub) {
    await ctx.reply("Bu raqam bo'yicha oldingi xarid topilmadi. Avval \"🔑 Kalit olish\" orqali ro'yxatdan o'ting.");
    await resetSession(ctx);
    return;
  }

  ctx.session.companyId = sub.company_id;
  ctx.session.subOldTariffId = sub.tariff_id;
  ctx.session.subPaidAmount = Number(sub.paid_amount);
  ctx.session.subExpiresAt = sub.expires_at;

  const currentTariff = await getTariff(sub.tariff_id);
  const active = isSubscriptionActive(sub);
  const allTariffs = await listTariffs();
  const otherTariffs = allTariffs.filter((t) => t.id !== sub!.tariff_id);

  if (otherTariffs.length === 0) {
    await ctx.reply("Boshqa tarif mavjud emas.");
    await resetSession(ctx);
    return;
  }

  ctx.session.step = 'upgrade_selecting_tariff';
  await ctx.reply(
    [
      `Joriy tarifingiz: *${currentTariff?.name || "belgilanmagan"}*`,
      `To'langan: *${formatSum(sub.paid_amount)} so'm* (${new Date(sub.paid_at).toLocaleDateString('uz-UZ')})`,
      `Amal qilish muddati: ${new Date(sub.expires_at).toLocaleDateString('uz-UZ')}${active ? '' : ' (tugagan)'}`,
      '',
      "Qaysi tarifga o'zgartirmoqchisiz?",
    ].join('\n'),
    { parse_mode: 'Markdown', ...tariffSelectKeyboard(otherTariffs, 'upgrade_tariff') },
  );
}

export async function handleUpgradeTariffSelected(ctx: SessionContext & { match: RegExpExecArray }): Promise<void> {
  const tariffId = ctx.match[1];
  await ctx.answerCbQuery();

  const tariff = await getTariff(tariffId);
  if (!tariff) { await ctx.editMessageText("Noma'lum tarif."); return; }

  const sub: LatestSubscription | null = ctx.session.subPaidAmount !== undefined && ctx.session.subExpiresAt
    ? {
        id: '', company_id: ctx.session.companyId as string, tariff_id: ctx.session.subOldTariffId as string,
        paid_amount: ctx.session.subPaidAmount, paid_at: '', expires_at: ctx.session.subExpiresAt,
      }
    : null;
  const { discount, finalPrice } = computeProratedPrice(tariff.price, sub);

  ctx.session.selectedTariffId = tariffId;
  ctx.session.discount = discount;
  ctx.session.finalPrice = finalPrice;
  ctx.session.step = 'upgrade_confirm_pay';

  const lines = discount > 0
    ? [
        `Yangi tarif narxi: *${formatSum(tariff.price)} so'm*`,
        `Chegirma (oldin to'langan): *-${formatSum(discount)} so'm*`,
        `To'lash kerak: *${formatSum(finalPrice)} so'm*`,
      ]
    : [`Yangi tarif narxi: *${formatSum(finalPrice)} so'm*`];

  await ctx.editMessageText(
    [...lines, '', "To'lov qilamanmi?"].join('\n'),
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Ha', 'upgrade_pay:yes'), Markup.button.callback("❌ Yo'q", 'upgrade_pay:no')],
      ]),
    },
  );
}

export async function handleUpgradeConfirmPay(ctx: SessionContext & { match: RegExpExecArray }): Promise<void> {
  const choice = ctx.match[1];
  await ctx.answerCbQuery();

  if (choice === 'no') {
    const allTariffs = await listTariffs();
    const otherTariffs = allTariffs.filter((t) => t.id !== ctx.session.subOldTariffId);
    ctx.session.step = 'upgrade_selecting_tariff';
    await ctx.editMessageText("Qaysi tarifga o'zgartirmoqchisiz?", tariffSelectKeyboard(otherTariffs, 'upgrade_tariff'));
    return;
  }

  // finalPrice=0 bo'lishi mumkin: oldin faol obunada to'langan summa yangi
  // (pastroq) tarif narxini to'liq qoplasa. Bunda to'lov umuman bo'lmaydi —
  // chek so'rash mantiqsiz (adversarial review'da topilgan xato) — to'g'ridan
  // -to'g'ri so'rovni yaratib, Bot 2'ga yuboramiz.
  if ((ctx.session.finalPrice ?? 0) === 0) {
    await finalizeTariffChangeRequest(ctx, null);
    return;
  }

  ctx.session.step = 'upgrade_awaiting_receipt';
  await ctx.editMessageText([PAYMENT_CARD_TEXT, '', "To'lov qilgach, chek rasmini (screenshot/rasm) yuboring."].join('\n'), {
    parse_mode: 'Markdown',
  });
}

export async function handleUpgradeReceiptPhoto(ctx: SessionContext): Promise<void> {
  let receiptUrl: string;
  try {
    receiptUrl = await extractReceiptUrl(ctx);
  } catch (e: any) {
    console.error('Chek rasmini saqlashda xato:', e?.message);
    await ctx.reply("Rasmni saqlab bo'lmadi. Iltimos, qayta yuboring yoki birozdan so'ng urinib ko'ring.");
    return;
  }
  await finalizeTariffChangeRequest(ctx, receiptUrl);
}

// receiptUrl=null — faqat finalPrice=0 bo'lgan (proratsiya to'liq qoplagan)
// holatda, chek talab qilinmaydi.
async function finalizeTariffChangeRequest(ctx: SessionContext, receiptUrl: string | null): Promise<void> {
  const companyId = ctx.session.companyId;
  const newTariffId = ctx.session.selectedTariffId;
  const fullName = ctx.session.fullName;
  const phone = ctx.session.phone;
  const discount = ctx.session.discount ?? 0;
  const finalPrice = ctx.session.finalPrice;
  const oldTariffId = ctx.session.subOldTariffId ?? null;

  if (!companyId || !newTariffId || !fullName || !phone || finalPrice === undefined) {
    await ctx.reply('Sessiya eskirgan. Qaytadan boshlang: /start');
    await resetSession(ctx);
    return;
  }

  const newTariff = await getTariff(newTariffId);
  if (!newTariff) { await ctx.reply("Noma'lum tarif. Qaytadan boshlang: /start"); await resetSession(ctx); return; }

  const { id: requestId } = await createTariffChangeRequest({
    companyId,
    fullName,
    phone,
    telegramId: String(ctx.from!.id),
    oldTariffId,
    newTariffId,
    discountApplied: discount,
    finalPrice,
    receiptFileId: receiptUrl,
  });

  await ctx.reply("So'rovingiz tasdiqlash uchun yuborildi. Tez orada xabar beramiz.");
  await resetSession(ctx);

  const caption = [
    "🆙 *Tarif yangilash so'rovi*" + (receiptUrl ? '' : " (to'lovsiz — chegirma to'liq qopladi)"),
    '',
    `🏢 Kompaniya: ${escapeMarkdown(await getCompanyName(companyId))}`,
    `👤 Ism: ${escapeMarkdown(fullName)}`,
    `📱 Telefon: ${escapeMarkdown(phone)}`,
    `💬 Telegram: ${ctx.from!.username ? '@' + escapeMarkdown(ctx.from!.username) : "username yo'q"} (id: ${ctx.from!.id})`,
    `📦 Yangi tarif: ${newTariff.name} — ${formatSum(finalPrice)} so'm${discount > 0 ? ` (chegirma: -${formatSum(discount)} so'm)` : ''}`,
    `🕐 Vaqt: ${new Date().toISOString()}`,
  ].join('\n');

  await forwardToBot2({
    caption,
    receiptUrl,
    approveAction: `tariffchange_approve:${requestId}`,
    rejectAction: `tariffchange_reject:${requestId}`,
  });
}
