// Juda oddiy xotiradagi (in-memory) sessiya — aiogram'ning MemoryStorage'iga
// mos keladi. Bitta jarayon uchun yetarli; bir nechta instance/ko'p serverli
// deploy qilinsa (masalan Railway'da bir nechta replica), buni Redis-backed
// sessiyaga almashtirish kerak (masalan @telegraf/session + ioredis), aks
// holda foydalanuvchi turli instance'larga tushib qolganda holati yo'qoladi.
const store = new Map();

export function session() {
  return async (ctx, next) => {
    const key = ctx.chat?.id ?? ctx.from?.id;
    if (key === undefined) return next();

    ctx.session = store.get(key) || {};
    await next();
    store.set(key, ctx.session);
  };
}

export function resetSession(ctx) {
  ctx.session = {};
}
