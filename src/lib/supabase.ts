import { createClient } from '@supabase/supabase-js';

// Ikkala nomlash uslubini ham qo'llab-quvvatlaymiz (eski va yangi Supabase kalitlari).
const supabaseUrl =
  process.env.SUPABASE_URL ||
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  '';

const supabaseServiceKey =
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  '';

if (!supabaseUrl || !supabaseServiceKey) {
  // Jim placeholder'ga ulanib "fetch failed" berish o'rniga aniq xato beramiz.
  throw new Error(
    'Supabase konfiguratsiyasi yo\'q: .env.local da NEXT_PUBLIC_SUPABASE_URL (yoki SUPABASE_URL) ' +
    'va SUPABASE_SERVICE_ROLE_KEY (yoki SUPABASE_SECRET_KEY) belgilangan bo\'lishi kerak. ' +
    'Hamda src/server.ts birinchi qatorida "import \'./env\'" turishini tekshiring.'
  );
}

export const supabase = createClient(supabaseUrl, supabaseServiceKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});
