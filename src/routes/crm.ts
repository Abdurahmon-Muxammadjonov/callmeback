import { Router, Request, Response } from 'express';
import { supabase } from '../lib/supabase';
import { connect, getUsers, getStatus, markSynced } from '../lib/amocrm';

const router = Router();

// GET /crm/status — ulanish holati (frontend "amoCRM ulanishi" bo'limi uchun).
router.get('/status', async (_req: Request, res: Response) => {
  try {
    const status = await getStatus();
    return res.status(200).json({ success: true, ...status });
  } catch (e: any) {
    return res.status(200).json({ success: true, connected: false, error: e?.message });
  }
});

// POST /crm/connect — sozlamalarni saqlab, OAuth code'ni token'ga almashtiradi.
// Body: { subdomain, client_id, client_secret, redirect_uri, code }
router.post('/connect', async (req: Request, res: Response) => {
  try {
    const { subdomain, client_id, client_secret, redirect_uri, code } = req.body ?? {};
    for (const [k, v] of Object.entries({ subdomain, client_id, client_secret, redirect_uri, code })) {
      if (!v || typeof v !== 'string') {
        return res.status(400).json({ success: false, error: `"${k}" majburiy.` });
      }
    }
    const out = await connect({ subdomain, client_id, client_secret, redirect_uri, code });
    return res.status(200).json({ success: true, ...out });
  } catch (e: any) {
    return res.status(502).json({ success: false, error: e?.message || 'amoCRM ulanish xatosi.' });
  }
});

// amoCRM foydalanuvchilarini (sotuvchilar) → managers ga crm_id bo'yicha upsert.
// Mavjud menejer status'i (masalan 'flagged') saqlanadi — faqat ism yangilanadi.
async function syncManagers(): Promise<{ synced: number; failed: number }> {
  const users = await getUsers();
  let synced = 0;
  let failed = 0;
  for (const u of users) {
    const row = { crm_id: String(u.id), name: u.name || u.email || `amo-${u.id}` };
    const { error } = await supabase.from('managers').upsert(row, { onConflict: 'crm_id' });
    if (error) { failed++; console.error(`Manager sync ${u.id} failed:`, error.message); }
    else synced++;
  }
  return { synced, failed };
}

// POST /crm/sync — qo'lda sinxron. Hozircha menejerlarni sinxronlaydi.
// Qo'ng'iroq/audio sinxroni telefoniya sozlamasiga bog'liq — ulangach yakunlanadi.
router.post('/sync', async (_req: Request, res: Response) => {
  try {
    const managers = await syncManagers();
    await markSynced();
    return res.status(200).json({
      success: true,
      managers,
      note: 'Menejerlar sinxronlandi. Qo\'ng\'iroq/audio sinxroni telefoniya integratsiyasi ulangach yoqiladi.',
    });
  } catch (e: any) {
    return res.status(502).json({ success: false, error: e?.message || 'Sinxron xatosi.' });
  }
});

export default router;
