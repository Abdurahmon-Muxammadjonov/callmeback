import type { Context, MiddlewareFn } from 'telegraf';
import { supabase } from '../lib/supabase';

// Eski telegram-bot/session.js xotiradagi (Map) sessiyani ishlatardi — spec
// buni DB-backed qilishni aniq talab qiladi ("Express instances may restart
// or scale horizontally"). Bir xil oddiy interfeys (ctx.session — o'qish/
// yozish erkin obyekt), lekin har `next()`dan keyin `telegram_bot_sessions`
// jadvaliga saqlanadi.

export interface BotSession {
  // --- eski marketing/purchase oqimi (telegram-bot/handlers/*) ---
  state?: string;
  tariffKey?: string;
  employeeCount?: number;
  duration?: number;
  fullName?: string;
  phone?: string;
  company?: string;
  // --- yangi tarif-ochish oqimi (Part 2/3/4) ---
  flow?: 'get_code' | 'upgrade';
  companyId?: string;
  step?: string;
  selectedTariffId?: string;
  pendingRequestId?: string;
  rejectingRequestId?: string; // Bot 2: "sababni yozing" kutilayotgan so'rov id'si
  [key: string]: unknown;
}

export interface SessionContext extends Context {
  session: BotSession;
}

export function dbSession(botNumber: 1 | 2): MiddlewareFn<SessionContext> {
  return async (ctx, next) => {
    const key = String(ctx.chat?.id ?? ctx.from?.id ?? '');
    if (!key) return next();

    const { data } = await supabase
      .from('telegram_bot_sessions')
      .select('context')
      .eq('telegram_id', key)
      .eq('bot', botNumber)
      .maybeSingle();

    ctx.session = (data?.context as BotSession) || {};
    await next();

    await supabase
      .from('telegram_bot_sessions')
      .upsert({
        telegram_id: key,
        bot: botNumber,
        current_step: typeof ctx.session.state === 'string' ? ctx.session.state : (typeof ctx.session.step === 'string' ? ctx.session.step : null),
        context: ctx.session,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'telegram_id,bot' });
  };
}

export async function resetSession(ctx: SessionContext): Promise<void> {
  ctx.session = {};
}
