import { supabase } from './supabase';

/* ============================================================
 * Backend Realtime listener — users jadvalidagi UPDATE'larni kuzatadi.
 *
 * Asosiy real-time push browser → Supabase to'g'ridan-to'g'ri amalga oshadi
 * (frontend §6). Bu listener SERVER tomonida reaksiya qilish uchun:
 * profil/smena o'zgarishini ushlash, log, qo'shimcha mantiq (masalan
 * bildirishnoma yuborish) uchun ishlatiladi.
 *
 * MUHIM: payload.old to'liq kelishi uchun jadvalda REPLICA IDENTITY FULL
 * yoqilgan bo'lishi shart (enable_realtime.sql).
 * ============================================================ */

// O'zgarganda ahamiyatli hisoblanadigan maydonlar.
const WATCHED_FIELDS = ['first_name', 'last_name', 'shift_start', 'shift_end', 'email'] as const;

export function startRealtimeListener() {
  const channel = supabase
    .channel('staff-changes')
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'users' },
      (payload) => {
        const before = (payload.old ?? {}) as Record<string, unknown>;
        const after = (payload.new ?? {}) as Record<string, unknown>;

        const changed = WATCHED_FIELDS.filter((f) => before[f] !== after[f]);
        if (changed.length === 0) return;

        const summary = changed.map((f) => `${f}: ${before[f] ?? '∅'} → ${after[f] ?? '∅'}`).join(', ');
        console.log(`[realtime] users ${after.id ?? before.id} yangilandi → ${summary}`);

        // Bu yerda server tomonidagi reaksiyani qo'shishingiz mumkin:
        // - smena vaqti o'zgarsa shift_events ni qayta hisoblash
        // - profil o'zgarsa user_notifications ga yozuv qo'shish, va h.k.
      },
    )
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        console.log('[realtime] kanal OCHIQ — public.users UPDATE kuzatilmoqda');
      } else if (status === 'CHANNEL_ERROR') {
        console.error('[realtime] kanal xatosi — Realtime yoqilganmi? (enable_realtime.sql)');
      } else if (status === 'TIMED_OUT') {
        console.error('[realtime] ulanish timeout — qayta urinilmoqda...');
      } else if (status === 'CLOSED') {
        console.log('[realtime] kanal yopildi');
      }
    });

  return channel;
}
