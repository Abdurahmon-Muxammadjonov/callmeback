import { supabase } from '../lib/supabase';

// telegram-bot/db.js'dan portlangan — endi asosiy backend'ning umumiy
// Supabase klientini ishlatadi (o'sha bazaning o'zi, alohida klient shart emas).

export interface BotLead {
  telegram_user_id: number;
  telegram_username: string | null;
  full_name: string;
  phone: string;
  company_name: string;
  tariff: string;
  employee_count: number;
  duration_months: number;
  price_per_employee: number;
  monthly_total: number;
  period_total: number;
}

export async function insertLead(lead: BotLead): Promise<void> {
  const { error } = await supabase.from('bot_leads').insert(lead);
  if (error) throw new Error(`Lead saqlanmadi: ${error.message}`);
}

export async function logEvent(telegramUserId: number, eventType: string, payload: unknown = null): Promise<void> {
  try {
    const { error } = await supabase
      .from('bot_events')
      .insert({ telegram_user_id: telegramUserId, event_type: eventType, payload });
    if (error) console.error('bot_events yozishda xato:', error.message);
  } catch (e: any) {
    console.error('bot_events yozishda xato:', e?.message);
  }
}
