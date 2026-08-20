import { Markup } from 'telegraf';
import { supabase } from '../lib/supabase';
import { resetSession, type SessionContext } from './dbSession';
import { bot2 } from './bot2';
import {
  listTariffs,
  tariffsAboveCurrent,
  getTariff,
  createTariffRequest,
  type TariffRow,
} from '../lib/tariffRequests';

// ============================================================================
// Umumiy: so'rovni Bot 2'ga (adminlarga) yo'llash — Part 2.3 / Part 4.2.5
// ============================================================================
async function forwardRequestToBot2(params: {
  requestId: string;
  companyName: string;
  tariffName: string;
  telegramUser: { id: number; username?: string };
  phone?: string | null;
  type: 'initial_purchase' | 'upgrade';
}): Promise<void> {
  const adminIds = (process.env.ADMIN_TELEGRAM_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (adminIds.length === 0) {
    console.error('ADMIN_TELEGRAM_IDS sozlanmagan — tarif so\'rovini hech kimga yuborib bo\'lmadi.');
    return;
  }

  const text = [
    params.type === 'upgrade' ? '🆙 *Tarif yangilash so\'rovi*' : '🆕 *Yangi to\'lov tasdiqlash so\'rovi*',
    '',
    `🏢 Kompaniya: ${params.companyName}`,
    `💬 Telegram: ${params.telegramUser.username ? '@' + params.telegramUser.username : "username yo'q"} (id: ${params.telegramUser.id})`,
    params.phone ? `📱 Telefon: ${params.phone}` : null,
    `📦 So'ralgan tarif: ${params.tariffName}`,
    `🕐 Vaqt: ${new Date().toISOString()}`,
  ].filter(Boolean).join('\n');

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('✅ Tasdiqlash', `tariff_approve:${params.requestId}`),
      Markup.button.callback('❌ Rad etish', `tariff_reject:${params.requestId}`),
    ],
  ]);

  for (const adminId of adminIds) {
    try {
      await bot2.telegram.sendMessage(adminId, text, { parse_mode: 'Markdown', ...keyboard });
    } catch (e: any) {
      console.error(`Bot2'ga xabar yuborishda xato (adminId=${adminId}):`, e?.message);
    }
  }
}

function tariffSelectKeyboard(tariffs: TariffRow[], prefix: string) {
  return Markup.inlineKeyboard(tariffs.map((t) => [Markup.button.callback(t.name, `${prefix}:${t.id}`)]));
}

async function getCompanyName(companyId: string): Promise<string> {
  const { data } = await supabase.from('companies').select('name').eq('id', companyId).maybeSingle();
  return data?.name || "Noma'lum kompaniya";
}

// ============================================================================
// Telefon raqami orqali kompaniya topish — deep-link'siz (menyudan to'g'ridan
// -to'g'ri kirilganda, Part 4.2.2'dagi bilan bir xil qidiruv, ikkala joyda
// ham ishlatiladi: "Tarifni oshirish" va menyudagi "Kod olish").
// ============================================================================
async function findCompanyByPhone(phone: string): Promise<{ id: string; name: string; tariff_id: string | null } | null> {
  const { data: user } = await supabase
    .from('users')
    .select('company_id')
    .eq('phone', phone)
    .eq('role', 'director')
    .maybeSingle();
  if (!user) return null;

  const { data: company } = await supabase.from('companies').select('id, name, tariff_id').eq('id', user.company_id).maybeSingle();
  return company || null;
}

// ============================================================================
// Menyudan to'g'ridan-to'g'ri kirish (deep-link'siz) — MENU_GET_CODE /
// MENU_UPGRADE tugmalari bosilganda. Ikkalasi ham avval telefon raqami
// orqali kompaniyani aniqlaydi, keyin tegishli oqimga (Part 2 / Part 4.2)
// o'tkazadi — saytdan kelgan deep-link bilan bir xil davom etadi.
// ============================================================================
export async function enterGetCodeFlowFromMenu(ctx: SessionContext): Promise<void> {
  await resetSession(ctx);
  ctx.session.step = 'menu_get_code_awaiting_phone';
  await ctx.reply("Hisobingizni topish uchun telefon raqamingizni kiriting (masalan: +998901234567):");
}

export async function handleMenuGetCodePhoneText(ctx: SessionContext, text: string): Promise<void> {
  const company = await findCompanyByPhone(text.trim());
  if (!company) {
    await ctx.reply("Bu raqam bilan hisob topilmadi. Iltimos, admin bilan bog'laning.");
    await resetSession(ctx);
    return;
  }
  await enterGetCodeFlow(ctx, company.id);
}

export async function enterUpgradeFlowFromMenu(ctx: SessionContext): Promise<void> {
  // enterUpgradeFlow(companyId) qiymati baribir telefon kiritilgach
  // handleUpgradePhoneText'da qayta aniqlanadi (2.3-band) — shu sabab
  // deep-link'dan kelmagan holatda bo'sh qiymat bilan ham xavfsiz.
  await enterUpgradeFlow(ctx, '');
}

// ============================================================================
// PART 2 — "Get code" oqimi (in-plan, hali ochilmagan bo'lim)
// ============================================================================
export async function enterGetCodeFlow(ctx: SessionContext, companyId: string): Promise<void> {
  await resetSession(ctx);
  ctx.session.flow = 'get_code';
  ctx.session.companyId = companyId;
  await ctx.reply(
    "Assalomu alaykum! Tarif bo'yicha to'lovni allaqachon amalga oshirdingizmi?",
    Markup.inlineKeyboard([
      [Markup.button.callback('✅ Ha', 'paid:yes'), Markup.button.callback("❌ Yo'q", 'paid:no')],
    ]),
  );
}

export async function handlePaidNo(ctx: SessionContext): Promise<void> {
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    [
      "To'lov ma'lumotlari:",
      '',
      "💳 Karta: 8600 xxxx xxxx xxxx (SalesPulse MCHJ)",
      "Yoki hisob-faktura uchun 👨‍💼 admin bilan bog'laning.",
      '',
      "To'lovni amalga oshirgach, botga qaytadan /start bosib, \"Ha\" deb javob bering.",
    ].join('\n'),
  );
  await resetSession(ctx);
}

export async function handlePaidYes(ctx: SessionContext): Promise<void> {
  await ctx.answerCbQuery();
  const tariffs = await listTariffs();
  ctx.session.step = 'selecting_tariff_get_code';
  await ctx.editMessageText("Qaysi tarifni to'ladingiz?", tariffSelectKeyboard(tariffs, 'get_code_tariff'));
}

export async function handleGetCodeTariffSelected(ctx: SessionContext & { match: RegExpExecArray }): Promise<void> {
  const tariffId = ctx.match[1];
  await ctx.answerCbQuery();

  const companyId = ctx.session.companyId;
  if (!companyId) {
    await ctx.editMessageText("Sessiya eskirgan. Iltimos, saytdan havolani qayta oching.");
    return;
  }

  const tariff = await getTariff(tariffId);
  if (!tariff) { await ctx.editMessageText("Noma'lum tarif."); return; }

  const { id: requestId } = await createTariffRequest({
    companyId,
    requestedTariffId: tariffId,
    telegramId: String(ctx.from!.id),
    type: 'initial_purchase',
  });

  await ctx.editMessageText("So'rovingiz tasdiqlash uchun yuborildi. Tez orada xabar beramiz.");
  await resetSession(ctx);

  await forwardRequestToBot2({
    requestId,
    companyName: await getCompanyName(companyId),
    tariffName: tariff.name,
    telegramUser: { id: ctx.from!.id, username: (ctx.from as any)?.username },
    type: 'initial_purchase',
  });
}

// ============================================================================
// PART 4.2 — "Upgrade tariff" oqimi (out-of-plan bo'lim)
// ============================================================================
export async function enterUpgradeFlow(ctx: SessionContext, companyId: string): Promise<void> {
  await resetSession(ctx);
  ctx.session.flow = 'upgrade';
  ctx.session.companyId = companyId;
  ctx.session.step = 'upgrade_awaiting_phone';
  await ctx.reply("Hisobingizni topish uchun telefon raqamingizni kiriting (masalan: +998901234567):");
}

export async function handleUpgradePhoneText(ctx: SessionContext, text: string): Promise<void> {
  const phone = text.trim();

  // Eslatma: hozircha ro'yxatdan o'tishda telefon raqami so'ralmaydi — bu
  // qidiruv FAQAT users.phone qo'lda/keyinroq to'ldirilgan direktorlar
  // uchun ishlaydi. Bu haqiqiy cheklov, spec'dagi "verified phone number"
  // talabini to'liq qondirish uchun ro'yxatdan o'tish/profil sahifasiga
  // telefon maydonini qo'shish alohida ish sifatida qoladi.
  const company = await findCompanyByPhone(phone);
  if (!company) {
    await ctx.reply("Bu raqam bilan hisob topilmadi. Iltimos, admin bilan bog'laning.");
    await resetSession(ctx);
    return;
  }

  ctx.session.companyId = company.id;
  ctx.session.phone = phone;

  const higherTariffs = await tariffsAboveCurrent(company.tariff_id);
  if (higherTariffs.length === 0) {
    await ctx.reply("Siz allaqachon eng yuqori tarifdasiz.");
    await resetSession(ctx);
    return;
  }

  const currentName = company.tariff_id ? (await getTariff(company.tariff_id))?.name || "belgilanmagan" : "belgilanmagan";
  ctx.session.step = 'selecting_tariff_upgrade';
  await ctx.reply(
    `Joriy tarifingiz: *${currentName}*.\n\nQaysi tarifga o'tmoqchisiz?`,
    { parse_mode: 'Markdown', ...tariffSelectKeyboard(higherTariffs, 'upgrade_tariff') },
  );
}

export async function handleUpgradeTariffSelected(ctx: SessionContext & { match: RegExpExecArray }): Promise<void> {
  const tariffId = ctx.match[1];
  const tariff = await getTariff(tariffId);
  if (!tariff) { await ctx.answerCbQuery("Noma'lum tarif."); return; }

  ctx.session.selectedTariffId = tariffId;
  ctx.session.step = 'upgrade_confirm';
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    `Siz *${tariff.name}* tarifini tanladingiz. Tasdiqlaysizmi?`,
    {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('✅ Ha', 'upgrade_confirm:yes'), Markup.button.callback("❌ Yo'q", 'upgrade_confirm:no')],
      ]),
    },
  );
}

export async function handleUpgradeConfirm(ctx: SessionContext & { match: RegExpExecArray }): Promise<void> {
  const choice = ctx.match[1];
  await ctx.answerCbQuery();

  if (choice === 'no') {
    // Part 4.2.6: bekor qilinsa — tarif tanlashga qaytadi.
    const companyId = ctx.session.companyId;
    if (!companyId) { await resetSession(ctx); return; }
    const { data: company } = await supabase.from('companies').select('tariff_id').eq('id', companyId).maybeSingle();
    const higherTariffs = await tariffsAboveCurrent(company?.tariff_id ?? null);
    ctx.session.step = 'selecting_tariff_upgrade';
    await ctx.editMessageText('Qaysi tarifga o\'tmoqchisiz?', tariffSelectKeyboard(higherTariffs, 'upgrade_tariff'));
    return;
  }

  const companyId = ctx.session.companyId;
  const tariffId = ctx.session.selectedTariffId as string;
  if (!companyId || !tariffId) {
    await ctx.editMessageText('Sessiya eskirgan. Qaytadan boshlang: /start');
    return;
  }

  const tariff = await getTariff(tariffId);
  if (!tariff) { await ctx.editMessageText("Noma'lum tarif."); return; }

  const { id: requestId } = await createTariffRequest({
    companyId,
    requestedTariffId: tariffId,
    telegramId: String(ctx.from!.id),
    phone: (ctx.session.phone as string) || null,
    type: 'upgrade',
  });

  await ctx.editMessageText("So'rovingiz tasdiqlash uchun yuborildi. Tez orada xabar beramiz.");
  const phone = ctx.session.phone as string | undefined;
  await resetSession(ctx);

  await forwardRequestToBot2({
    requestId,
    companyName: await getCompanyName(companyId),
    tariffName: tariff.name,
    telegramUser: { id: ctx.from!.id, username: (ctx.from as any)?.username },
    phone,
    type: 'upgrade',
  });
}
