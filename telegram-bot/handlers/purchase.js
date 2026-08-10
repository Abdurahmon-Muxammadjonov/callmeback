import {
  TARIFFS,
  formatSum,
  monthlyTotal,
  baseMonthlyTotal,
  periodTotal,
} from '../pricing.js';
import {
  tariffInlineKeyboard,
  TARIFF_CONFIRM_KEYBOARD,
  durationInlineKeyboard,
  FINAL_CONFIRM_KEYBOARD,
  PHONE_REQUEST_KEYBOARD,
  MAIN_MENU,
} from '../keyboards.js';
import { resetSession } from '../session.js';
import { insertLead, logEvent } from '../db.js';

const PHONE_REGEX = /^\+?\d[\d\s\-()]{6,}$/;

export async function startPurchaseFlow(ctx) {
  resetSession(ctx);
  await logEvent(ctx.from.id, 'purchase_flow_started');
  await ctx.reply("Qaysi tarifni tanlaysiz?", tariffInlineKeyboard());
}

// --- 1) Tarif tanlash ---
export async function onTariffSelected(ctx) {
  const tariffKey = ctx.match[1];
  const tariff = TARIFFS[tariffKey];
  if (!tariff) return ctx.answerCbQuery("Noma'lum tarif.");

  ctx.session.tariffKey = tariffKey;
  await ctx.answerCbQuery();
  await ctx.editMessageText(
    [
      `*${tariff.name}*${tariff.popular ? ' ⭐ (eng mashhur)' : ''}`,
      '',
      `Narx: *${formatSum(tariff.pricePerEmployee)} so'm* / xodim / oy`,
      'Xodimlar soni: 1 dan cheksizgacha',
      '',
      "Kiritilgan xizmatlar:",
      ...tariff.headline.map((f) => `• ${f}`),
      '',
      'Shu tarifni tanlaysizmi?',
    ].join('\n'),
    { parse_mode: 'Markdown', ...TARIFF_CONFIRM_KEYBOARD },
  );
}

// --- 2) Tarifni tasdiqlash / bekor qilish ---
export async function onTariffConfirm(ctx) {
  const choice = ctx.match[1];
  await ctx.answerCbQuery();

  if (choice === 'no') {
    resetSession(ctx);
    await ctx.editMessageText('Bekor qilindi.');
    await ctx.reply('Asosiy menyu:', MAIN_MENU);
    return;
  }

  if (!ctx.session.tariffKey) {
    await ctx.reply("Avval tarifni tanlang.", tariffInlineKeyboard());
    return;
  }

  ctx.session.state = 'awaiting_employee_count';
  await ctx.editMessageText("Nechta xodimingiz bor?");
}

// --- 3) Xodimlar soni (matn) ---
export async function handleEmployeeCount(ctx, text) {
  const n = Number.parseInt(text.replace(/\D/g, ''), 10);
  if (!Number.isFinite(n) || n < 1) {
    await ctx.reply("Iltimos, ijobiy butun son kiriting (masalan: 5).");
    return;
  }

  ctx.session.employeeCount = n;
  ctx.session.state = undefined;

  const tariffKey = ctx.session.tariffKey;
  const base = baseMonthlyTotal(tariffKey, n);
  const lines = [
    `Tanlangan tarif: *${TARIFFS[tariffKey].name}*, xodimlar soni: *${n}*`,
    '',
    "Muddatni tanlang (chegirmalar ko'rsatilgan):",
  ];

  for (const d of [3, 6, 12]) {
    const total = monthlyTotal(tariffKey, d, n);
    if (total < base) {
      lines.push(`${d} oy: ~${formatSum(base)}~ so'm/oy → *${formatSum(total)} so'm/oy*`);
    }
  }

  await ctx.reply(lines.join('\n'), {
    parse_mode: 'Markdown',
    ...durationInlineKeyboard(tariffKey, n),
  });
}

// --- 4) Muddat tanlash ---
export async function onDurationSelected(ctx) {
  const duration = Number.parseInt(ctx.match[1], 10);
  const { tariffKey, employeeCount } = ctx.session;
  if (!tariffKey || !employeeCount) {
    await ctx.answerCbQuery("Sessiya eskirgan, qaytadan boshlang.");
    return;
  }

  ctx.session.duration = duration;
  const total = monthlyTotal(tariffKey, duration, employeeCount);

  await ctx.answerCbQuery();
  await ctx.editMessageText(
    `Tanlagan obunangiz: *${TARIFFS[tariffKey].name}*, ${employeeCount} xodim, ${duration} oy — narxi: *${formatSum(total)} so'm/oy*. Bu to'g'rimi?`,
    { parse_mode: 'Markdown', ...FINAL_CONFIRM_KEYBOARD },
  );
}

// --- 5) Yakuniy tasdiqlash ---
export async function onFinalConfirm(ctx) {
  const choice = ctx.match[1];
  const { tariffKey, employeeCount } = ctx.session;

  if (choice === 'no') {
    await ctx.answerCbQuery();
    await ctx.editMessageText("Muddatni qayta tanlang:", durationInlineKeyboard(tariffKey, employeeCount));
    return;
  }

  await ctx.answerCbQuery();
  ctx.session.state = 'awaiting_name';
  await ctx.editMessageText("Ism va familiyangizni kiriting:");
}

// --- 6) Ism ---
export async function handleName(ctx, text) {
  const name = text.trim();
  if (!name) {
    await ctx.reply("Iltimos, ism va familiyangizni kiriting.");
    return;
  }
  ctx.session.fullName = name;
  ctx.session.state = 'awaiting_phone';
  await ctx.reply(
    "Telefon raqamingizni yuboring (tugma orqali eng ishonchli):",
    PHONE_REQUEST_KEYBOARD,
  );
}

// --- 7) Telefon (tugma orqali contact yoki qo'lda matn) ---
export async function handlePhoneContact(ctx) {
  if (ctx.session.state !== 'awaiting_phone') return;
  const phone = ctx.message.contact?.phone_number;
  if (!phone) return;
  await proceedToCompany(ctx, phone);
}

export async function handlePhoneText(ctx, text) {
  const phone = text.trim();
  if (!PHONE_REGEX.test(phone)) {
    await ctx.reply("Telefon raqami noto'g'ri formatda. Masalan: +998901234567");
    return;
  }
  await proceedToCompany(ctx, phone);
}

async function proceedToCompany(ctx, phone) {
  ctx.session.phone = phone;
  ctx.session.state = 'awaiting_company';
  await ctx.reply("Kompaniyangiz nomini kiriting:", { remove_keyboard: true });
}

// --- 8) Kompaniya nomi -> yakunlash ---
export async function handleCompany(ctx, text) {
  const company = text.trim();
  if (!company) {
    await ctx.reply("Iltimos, kompaniya nomini kiriting.");
    return;
  }
  ctx.session.company = company;
  await finalizeLead(ctx);
}

async function finalizeLead(ctx) {
  const s = ctx.session;
  const perEmployee = monthlyTotal(s.tariffKey, s.duration, 1);
  const monthly = monthlyTotal(s.tariffKey, s.duration, s.employeeCount);
  const total = periodTotal(s.tariffKey, s.duration, s.employeeCount);

  const lead = {
    telegram_user_id: ctx.from.id,
    telegram_username: ctx.from.username || null,
    full_name: s.fullName,
    phone: s.phone,
    company_name: s.company,
    tariff: TARIFFS[s.tariffKey].name,
    employee_count: s.employeeCount,
    duration_months: s.duration,
    price_per_employee: perEmployee,
    monthly_total: monthly,
    period_total: total,
  };

  try {
    await insertLead(lead);
    await logEvent(ctx.from.id, 'lead_completed', lead);
  } catch (e) {
    console.error("Lead saqlashda xato:", e.message);
    await ctx.reply("Kechirasiz, so'rovingizni saqlashda xatolik yuz berdi. Iltimos, birozdan so'ng qayta urinib ko'ring yoki to'g'ridan-to'g'ri admin bilan bog'laning.");
    resetSession(ctx);
    await ctx.reply('Asosiy menyu:', MAIN_MENU);
    return;
  }

  resetSession(ctx);
  await ctx.reply(
    "So'rovingiz qabul qilindi. Tez orada operatorlarimiz siz bilan bog'lanadi.",
    MAIN_MENU,
  );

  const summary = [
    '🆕 *Yangi lid — SalesPulse boti*',
    '',
    `👤 Ism: ${lead.full_name}`,
    `📱 Telefon: ${lead.phone}`,
    `🏢 Kompaniya: ${lead.company_name}`,
    `💬 Telegram: ${lead.telegram_username ? '@' + lead.telegram_username : "yo'q"} (id: ${lead.telegram_user_id})`,
    `📦 Tarif: ${lead.tariff}`,
    `👥 Xodimlar soni: ${lead.employee_count}`,
    `📅 Muddat: ${lead.duration_months} oy`,
    `💰 Narx: ${formatSum(lead.price_per_employee)} so'm/xodim/oy → ${formatSum(lead.monthly_total)} so'm/oy → jami ${formatSum(lead.period_total)} so'm`,
    `🕐 Vaqt: ${new Date().toISOString()}`,
  ].join('\n');

  // Yangi lid: shaxsiy admin chatiga VA jamoaning umumiy guruhiga (bor bo'lsa) yuboriladi.
  const destinations = [process.env.ADMIN_CHAT_ID, process.env.GROUP_CHAT_ID].filter(Boolean);
  for (const chatId of destinations) {
    try {
      await ctx.telegram.sendMessage(chatId, summary, { parse_mode: 'Markdown' });
    } catch (e) {
      console.error(`Lid xabarini yuborishda xato (chatId=${chatId}):`, e.message);
    }
  }
}
