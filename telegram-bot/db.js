import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_KEY || '';

if (!supabaseUrl || !supabaseKey) {
  throw new Error('SUPABASE_URL va SUPABASE_KEY .env faylida belgilangan bo\'lishi shart.');
}

export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// leads.sql orqali yaratilgan `bot_leads` jadvaliga yakunlangan lidni yozadi.
// E'tibor: asosiy backend'da (boshqa sxema bilan) `leads` degan jadval ALLAQACHON
// mavjud (sotuv bosqichlari uchun) — shu bilan to'qnashmasligi uchun alohida nom.
export async function insertLead(lead) {
  const { error } = await supabase.from('bot_leads').insert(lead);
  if (error) throw new Error(`Lead saqlanmadi: ${error.message}`);
}

// Ixtiyoriy analitika jurnali (`bot_events`). Xato bo'lsa botni to'xtatmaymiz —
// faqat log qilamiz, chunki bu foydalanuvchi tajribasiga ta'sir qilmasligi kerak.
export async function logEvent(telegramUserId, eventType, payload = null) {
  try {
    const { error } = await supabase
      .from('bot_events')
      .insert({ telegram_user_id: telegramUserId, event_type: eventType, payload });
    if (error) console.error('bot_events yozishda xato:', error.message);
  } catch (e) {
    console.error('bot_events yozishda xato:', e.message);
  }
}
