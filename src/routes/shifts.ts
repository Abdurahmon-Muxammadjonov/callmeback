import { Router, Request, Response } from 'express';
import { supabase } from '../lib/supabase';

const router = Router();

// GET /shifts/events/latest?user_id=:id
// On-read: joriy vaqt smena chegarasidan o'tgan bo'lsa, shu kun uchun hodisani
// (bir marta) yaratadi va qaytaradi. Aks holda data: null.
router.get('/events/latest', async (req: Request, res: Response) => {
  try {
    const userId = typeof req.query.user_id === 'string' ? req.query.user_id : '';
    if (!userId) return res.status(400).json({ success: false, error: 'user_id majburiy.' });

    const { data: user, error: uErr } = await supabase
      .from('users').select('shift_start, shift_end').eq('id', userId).maybeSingle();
    if (uErr) return res.status(500).json({ success: false, error: `Database Error: ${uErr.message}` });
    if (!user) return res.status(200).json({ success: true, data: null });

    const now = new Date();
    const hhmm = now.toTimeString().slice(0, 5); // 'HH:MM' (server tz)
    const today = now.toISOString().slice(0, 10);

    // Smena tugagan bo'lsa 'end', boshlangani 'start' (eng so'nggi tegishli hodisa).
    let type: 'start' | 'end' | null = null;
    if (user.shift_end && hhmm >= user.shift_end) type = 'end';
    else if (user.shift_start && hhmm >= user.shift_start) type = 'start';
    if (!type) return res.status(200).json({ success: true, data: null });

    // Shu kun uchun bir marta yaratamiz (unique user_id,type,event_date).
    await supabase
      .from('shift_events')
      .upsert(
        { user_id: userId, type, event_date: today, at: now.toISOString() },
        { onConflict: 'user_id,type,event_date', ignoreDuplicates: true },
      );

    const { data: ev, error: eErr } = await supabase
      .from('shift_events')
      .select('id, type, at')
      .eq('user_id', userId).eq('type', type).eq('event_date', today)
      .maybeSingle();
    if (eErr) return res.status(500).json({ success: false, error: `Database Error: ${eErr.message}` });

    return res.status(200).json({ success: true, data: ev ? { id: ev.id, type: ev.type, at: ev.at } : null });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err?.message || 'Shift event xatolik.' });
  }
});

export default router;
