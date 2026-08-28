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
  type TariffRow,
  type LatestSubscription,
} from '../lib/tariffPayments';

// Part D qayta qurilishi — REVIZIYA 5 (yakuniy, foydalanuvchi tasdiqladi):
// endi ikkita AJRALGAN oqim bor, ikkalasi ham bitta umumiy kartaga to'laydi
// (PAYMENT_CARD_TEXT):
//
//  A) "🛒 Sotib olmoqchiman" — YANGI mijoz, hech narsa oldindan ma'lum emas:
//     tarif tanlash -> xodimlar soni -> ism -> telefon -> kompaniya nomi
//     (companies.name bo'yicha qidiriladi — kompaniya SAYTDA allaqachon
//     ro'yxatdan o'tgan bo'lishi SHART) -> narx+karta -> chek rasmi ->
//     Bot 2'ga forward. Quyida "Kalit olish" nomi bilan qoldirilgan (D.3).
//
//  B) "🎟 Kod olish" VA "⬆️ Tarifni oshirish" — endi AYNAN BIR XIL, MAVJUD
//     mijoz uchun: telefon raqam (faqat menyudan kirilganda so'raladi) ->
//     shu raqam bo'yicha OXIRGI obuna (subscriptions) qidiriladi ->
//     topilmasa "avval Sotib olmoqchiman orqali ro'yxatdan o'ting" ->
//     topilsa "Sizning tarifingiz: X" ko'rsatiladi -> yangi tarif tanlanadi
//     (joriysidan boshqalari) -> xodimlar soni -> narx+karta (CHEGIRMASIZ —
//     proratsiya olib tashlandi) -> chek rasmi -> Bot 2'ga forward. Ism
//     alohida so'RALMAYDI — Telegram profilidan olinadi (telegramDisplayName).

const PAYMENT_CARD_TEXT = "💳 Karta: 8600 1404 7274 5281 (A.X.M)";

// Telegram'ning (legacy) 'Markdown' parse_mode'i 4 ta belgini maxsus
// deb hisoblaydi: _ * ` [ — foydalanuvchi matnida (ism, familiya, Telegram
// username) bular JUDA ODATIY (masalan "@abdu_rahmon"), escape qilinmasa
// butun sendPhoto/sendMessage chaqiruvi "can't parse entities" bilan
// muvaffaqiyatsiz tugaydi va Bot 2 so'rovni UMUMAN OLMAYDI (xato faqat
// console.error'ga yoziladi, hech kimga ko'rinmaydi) — adversarial review'da
// topilgan CRITICAL xato, shu sabab har bir interpolatsiya qilingan
// foydalanuvchi matni shu funksiya orqali o'tishi SHART.
export function escapeMarkdown(text: string): string {
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

// tariffs.price — bitta xodimga narx — tugmada shunday ko'rsatiladi.
function tariffSelectKeyboard(tariffs: TariffRow[], prefix: string) {
  return Markup.inlineKeyboard(
    tariffs.map((t) => [Markup.button.callback(`${t.name} — ${formatSum(t.price)} so'm/xodim`, `${prefix}:${t.id}`)]),
  );
}

async function getCompanyName(companyId: string): Promise<string> {
  const { data } = await supabase.from('companies').select('name').eq('id', companyId).maybeSingle();
  return data?.name || "Noma'lum kompaniya";
}

// Kompaniya NOMI bo'yicha qidiradi (avval aniq — katta-kichik harfsiz mos
// kelish, topilmasa qisman mos kelish). Faqat MAVJUD companies qatorini
// topadi, yangisini yaratmaydi — kod faqat saytga KIRGAN (parolli hisobga
// ega) foydalanuvchi tomonidan ishlatilishi mumkin, bot orqali yangi hisob
// yaratilmaydi.
async function findCompanyByName(name: string): Promise<{ id: string; name: string } | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;

  const { data: exact } = await supabase.from('companies').select('id, name').ilike('name', trimmed).limit(1).maybeSingle();
  if (exact) return exact;

  const { data: partial } = await supabase.from('companies').select('id, name').ilike('name', `%${trimmed}%`).limit(1).maybeSingle();
  return partial || null;
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

function parsePositiveInt(text: string): number | null {
  const n = Number.parseInt(text.replace(/\D/g, ''), 10);
  return Number.isFinite(n) && n >= 1 ? n : null;
}

// "Kod olish"/"Tarifni oshirish" oqimida (Reviziya 5) ism alohida
// so'RALMAYDI — mijoz allaqachon telefon/companyId orqali aniqlangan, shu
// sabab Telegram profilidagi ism Bot 2'ga ko'rsatish uchun ishlatiladi.
function telegramDisplayName(ctx: SessionContext): string {
  const first = ctx.from?.first_name || '';
  const last = ctx.from?.last_name || '';
  const full = `${first} ${last}`.trim();
  return full || ctx.from?.username || "Noma'lum";
}

// ============================================================================
// Menyudan to'g'ridan-to'g'ri kirish (deep-link'siz) — ikkalasi ham darhol
// bir xil bosqichlar ketma-ketligini boshlaydi (companyId hali noma'lum,
// 4-bosqichda kompaniya nomi orqali aniqlanadi).
// ============================================================================
export async function enterGetCodeFlowFromMenu(ctx: SessionContext): Promise<void> {
  await enterGetCodeFlow(ctx, '');
}

export async function enterUpgradeFlowFromMenu(ctx: SessionContext): Promise<void> {
  await enterUpgradeFlow(ctx, '');
}

// ============================================================================
// PART D.3 — "Kalit olish" oqimi (birinchi xarid)
// ============================================================================
export async function enterGetCodeFlow(ctx: SessionContext, companyId: string): Promise<void> {
  await resetSession(ctx);
  ctx.session.flow = 'get_code';
  ctx.session.companyId = companyId || undefined;

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
  ctx.session.step = 'getcode_awaiting_employee_count';
  await ctx.editMessageText(`Siz *${tariff.name}* tarifini tanladingiz.`, { parse_mode: 'Markdown' });
  await ctx.reply("Nechta xodimingiz bor?");
}

export async function handleGetCodeEmployeeCountText(ctx: SessionContext, text: string): Promise<void> {
  const n = parsePositiveInt(text);
  if (!n) { await ctx.reply('Iltimos, ijobiy butun son kiriting (masalan: 5).'); return; }
  ctx.session.employeeCount = n;
  ctx.session.step = 'getcode_awaiting_name';
  await ctx.reply("Ism va familiyangizni kiriting:");
}

export async function handleGetCodeNameText(ctx: SessionContext, text: string): Promise<void> {
  const name = text.trim();
  if (!name) { await ctx.reply('Iltimos, ism va familiyangizni kiriting.'); return; }
  ctx.session.fullName = name;
  ctx.session.step = 'getcode_awaiting_phone';
  await ctx.reply("Telefon raqamingizni kiriting:");
}

export async function handleGetCodePhoneText(ctx: SessionContext, text: string): Promise<void> {
  ctx.session.phone = text.trim();
  ctx.session.step = 'getcode_awaiting_company_name';
  await ctx.reply("Kompaniyangiz nomini kiriting:");
}

export async function handleGetCodeCompanyNameText(ctx: SessionContext, text: string): Promise<void> {
  if (!ctx.session.companyId) {
    const company = await findCompanyByName(text);
    if (!company) {
      await ctx.reply("Bunday nomdagi kompaniya topilmadi. Iltimos, avval saytda ro'yxatdan o'ting yoki admin bilan bog'laning.");
      await resetSession(ctx);
      return;
    }
    ctx.session.companyId = company.id;
  }
  await showGetCodePaymentInfo(ctx);
}

async function showGetCodePaymentInfo(ctx: SessionContext): Promise<void> {
  const tariff = await getTariff(ctx.session.selectedTariffId as string);
  const employeeCount = ctx.session.employeeCount;
  if (!tariff || !employeeCount) { await ctx.reply("Sessiya eskirgan. Qaytadan boshlang: /start"); await resetSession(ctx); return; }

  const total = tariff.price * employeeCount;
  ctx.session.step = 'getcode_awaiting_receipt';
  await ctx.reply(
    [
      `Tanlagan tarifingiz: *${tariff.name}*`,
      `${formatSum(tariff.price)} so'm/xodim × ${employeeCount} xodim = *${formatSum(total)} so'm*`,
      '',
      "To'lov qiling:",
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
  const employeeCount = ctx.session.employeeCount;
  if (!companyId || !tariffId || !fullName || !phone || !employeeCount) {
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
    employeeCount,
  });

  await ctx.reply("So'rovingiz qabul qilindi. Tez orada kodingizni beramiz.");
  await resetSession(ctx);

  const total = tariff.price * employeeCount;
  const caption = [
    "🆕 *Yangi to'lov tasdiqlash so'rovi (Kalit olish)*",
    '',
    `🏢 Kompaniya: ${escapeMarkdown(await getCompanyName(companyId))}`,
    `👤 Ism: ${escapeMarkdown(fullName)}`,
    `📱 Telefon: ${escapeMarkdown(phone)}`,
    `💬 Telegram: ${ctx.from!.username ? '@' + escapeMarkdown(ctx.from!.username) : "username yo'q"} (id: ${ctx.from!.id})`,
    `📦 Tarif: ${tariff.name} — ${formatSum(tariff.price)} so'm/xodim × ${employeeCount} xodim = ${formatSum(total)} so'm`,
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
// "Kod olish" (menyu) + "Tarifni oshirish" (menyu, deep-link) — MAVJUD
// mijoz uchun bitta oqim (Reviziya 5, foydalanuvchi tasdiqladi):
//   1. [faqat menyu-orqali kirishda] Telefon raqam -> shu bo'yicha OXIRGI
//      obuna (subscriptions) qidiriladi -> topilmasa "avval Sotib
//      olmoqchiman orqali ro'yxatdan o'ting" -> bekor.
//   2. "Sizning tarifingiz: <joriy tarif>" ko'rsatiladi.
//   3. "Qaysi tarifga o'zgartirmoqchisiz?" — joriy tarifdan boshqalari.
//   4. Xodimlar soni.
//   5. Narx (CHEGIRMASIZ — tarif.narx x xodim) + karta + to'lov.
//   6. Chek rasmi -> "So'rovingiz qabul qilindi" -> Bot 2'ga forward.
// Deep-link orqali kirilganda (companyId allaqachon ma'lum) 1-bosqich
// o'tkazib yuboriladi, to'g'ridan-to'g'ri 2-bosqichdan boshlanadi.
// ============================================================================
export async function enterUpgradeFlow(ctx: SessionContext, companyId: string): Promise<void> {
  await resetSession(ctx);
  ctx.session.flow = 'upgrade';
  ctx.session.fullName = telegramDisplayName(ctx);

  if (companyId) {
    ctx.session.companyId = companyId;
    // Deep-link'da telefon so'ralmaydi (companyId allaqachon ma'lum) — lekin
    // Bot 2'ga ko'rsatish uchun eng so'nggi obunadagi telefon (bo'lsa)
    // best-effort tarzda oldindan to'ldiriladi.
    const { data: lastSub } = await supabase
      .from('subscriptions')
      .select('phone')
      .eq('company_id', companyId)
      .order('paid_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    ctx.session.phone = lastSub?.phone || "Noma'lum";
    await showCurrentTariffAndAskNew(ctx, companyId);
    return;
  }

  ctx.session.step = 'upgrade_awaiting_phone';
  await ctx.reply("Telefon raqamingizni kiriting:");
}

export async function handleUpgradePhoneText(ctx: SessionContext, text: string): Promise<void> {
  const phone = text.trim();
  ctx.session.phone = phone;

  let sub: LatestSubscription | null;
  try {
    sub = await findLatestSubscriptionByPhone(phone);
  } catch (e: any) {
    console.error('Obuna qidirishda xato:', e?.message);
    await ctx.reply('Xatolik yuz berdi. Birozdan so\'ng qayta urinib ko\'ring.');
    return;
  }

  if (!sub) {
    await ctx.reply("Bu raqam bo'yicha oldingi xarid topilmadi. Avval \"🛒 Sotib olmoqchiman\" orqali ro'yxatdan o'ting.");
    await resetSession(ctx);
    return;
  }

  ctx.session.companyId = sub.company_id;
  await showCurrentTariffAndAskNew(ctx, sub.company_id);
}

async function showCurrentTariffAndAskNew(ctx: SessionContext, companyId: string): Promise<void> {
  const { data: company } = await supabase.from('companies').select('tariff_id').eq('id', companyId).maybeSingle();
  const currentTariffId = company?.tariff_id ?? null;
  ctx.session.subOldTariffId = currentTariffId ?? undefined;

  const currentTariff = currentTariffId ? await getTariff(currentTariffId) : null;
  const allTariffs = await listTariffs();
  const otherTariffs = currentTariffId ? allTariffs.filter((t) => t.id !== currentTariffId) : allTariffs;

  if (otherTariffs.length === 0) {
    await ctx.reply("Boshqa tarif mavjud emas.");
    await resetSession(ctx);
    return;
  }

  ctx.session.step = 'upgrade_selecting_tariff';
  await ctx.reply(
    `Sizning tarifingiz: *${currentTariff?.name || "belgilanmagan"}*\n\nQaysi tarifga o'zgartirmoqchisiz?`,
    { parse_mode: 'Markdown', ...tariffSelectKeyboard(otherTariffs, 'upgrade_tariff') },
  );
}

export async function handleUpgradeTariffSelected(ctx: SessionContext & { match: RegExpExecArray }): Promise<void> {
  const tariffId = ctx.match[1];
  await ctx.answerCbQuery();

  const tariff = await getTariff(tariffId);
  if (!tariff) { await ctx.editMessageText("Noma'lum tarif."); return; }

  ctx.session.selectedTariffId = tariffId;
  ctx.session.step = 'upgrade_awaiting_employee_count';
  await ctx.editMessageText(`Siz *${tariff.name}* tarifini tanladingiz.`, { parse_mode: 'Markdown' });
  await ctx.reply("Nechta xodimingiz bor?");
}

export async function handleUpgradeEmployeeCountText(ctx: SessionContext, text: string): Promise<void> {
  const n = parsePositiveInt(text);
  if (!n) { await ctx.reply('Iltimos, ijobiy butun son kiriting (masalan: 5).'); return; }
  ctx.session.employeeCount = n;
  await showUpgradePaymentInfo(ctx);
}

// Chegirma yo'q — bu oqimda proratsiya qo'llanilmaydi (foydalanuvchi
// "Kod olish" bilan bir xil bo'lsin dedi, u yerda chegirma yo'q).
async function showUpgradePaymentInfo(ctx: SessionContext): Promise<void> {
  const tariff = await getTariff(ctx.session.selectedTariffId as string);
  const employeeCount = ctx.session.employeeCount;
  if (!tariff || !employeeCount) { await ctx.reply("Sessiya eskirgan. Qaytadan boshlang: /start"); await resetSession(ctx); return; }

  const total = tariff.price * employeeCount;
  ctx.session.discount = 0;
  ctx.session.finalPrice = total;
  ctx.session.step = 'upgrade_awaiting_receipt';
  await ctx.reply(
    [
      `Yangi tarif: *${tariff.name}*`,
      `${formatSum(tariff.price)} so'm/xodim × ${employeeCount} xodim = *${formatSum(total)} so'm*`,
      '',
      "To'lov qiling:",
      PAYMENT_CARD_TEXT,
      '',
      "To'lov qilgach, chek rasmini (screenshot/rasm) yuboring.",
    ].join('\n'),
    { parse_mode: 'Markdown' },
  );
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
  const employeeCount = ctx.session.employeeCount;

  if (!companyId || !newTariffId || !fullName || !phone || finalPrice === undefined || !employeeCount) {
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
    employeeCount,
  });

  await ctx.reply("So'rovingiz qabul qilindi. Tez orada kodingizni beramiz.");
  await resetSession(ctx);

  const caption = [
    "🆙 *Tarif yangilash so'rovi*" + (receiptUrl ? '' : " (to'lovsiz — chegirma to'liq qopladi)"),
    '',
    `🏢 Kompaniya: ${escapeMarkdown(await getCompanyName(companyId))}`,
    `👤 Ism: ${escapeMarkdown(fullName)}`,
    `📱 Telefon: ${escapeMarkdown(phone)}`,
    `💬 Telegram: ${ctx.from!.username ? '@' + escapeMarkdown(ctx.from!.username) : "username yo'q"} (id: ${ctx.from!.id})`,
    `📦 Yangi tarif: ${newTariff.name}, ${employeeCount} xodim — ${formatSum(finalPrice)} so'm${discount > 0 ? ` (chegirma: -${formatSum(discount)} so'm)` : ''}`,
    `🕐 Vaqt: ${new Date().toISOString()}`,
  ].join('\n');

  await forwardToBot2({
    caption,
    receiptUrl,
    approveAction: `tariffchange_approve:${requestId}`,
    rejectAction: `tariffchange_reject:${requestId}`,
  });
}
