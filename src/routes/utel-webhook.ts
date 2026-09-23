import { Router, Request, Response } from 'express';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// ============================================================================
// UTel (utc381.utel.uz) — O'zbek virtual PBX / bulutli telefoniya webhook
// qabul qiluvchi. BOSQICH 1 (2026-09-23): faqat KUZATISH.
//
// Maqsad: UTel'ning aniq payload strukturasi hali noma'lum. Shu sabab bu
// endpoint har bir kelgan so'rovni TO'LIQ (sarlavhalar + body + xom body)
// log qiladi — bir marta haqiqiy qo'ng'iroq qilib, "Call Saved" payload'ini
// ko'rgach, keyingi bosqichlar (yozuv URL'ini topish, audio yuklab olish,
// STT quvuriga berish, imzo tekshirish) aniq shakl bo'yicha quriladi.
//
// UTel dashboard -> Integratsiyalar -> Webhooks'da yoqilgan hodisalar:
//   Call Started, Call Ended, Dial Started, Dial Answered, Dial Ended,
//   Call Transferred, Call Saved.
//
// DIQQAT — bu endpoint hozircha AUTENTIFIKATSIYASIZ (ochiq). Bu ATAYLAB,
// FAQAT payload'ни ko'rish bosqichi uchun. Productiongacha:
//   - UTel imzo sarlavhasi/maxfiy kaliti bormi — hujjat/support'dan
//     aniqlash (bosqich 3). Bo'lsa — rawBody bo'yicha tekshirish.
//   - Bo'lmasa — hech bo'lmaganda maxfiy yo'l tokeni (masalan
//     /webhook/utel/<random>) yoki IP allowlist qo'shish.
// ============================================================================

const router = Router();

// Railway fayl tizimi EFEMER — deploy/restart'da yo'qoladi. Shu sabab asosiy
// log konsolga (railway logs bilan ko'riladi); fayl faqat qulaylik uchun.
const LOG_DIR = process.env.UTEL_LOG_DIR || path.join(os.tmpdir(), 'utel-webhooks');

function buildEntry(req: Request) {
  const rawBody = (req as any).rawBody instanceof Buffer
    ? (req as any).rawBody.toString('utf8')
    : undefined;
  return {
    receivedAt: new Date().toISOString(),
    ip: req.ip,
    method: req.method,
    url: req.originalUrl,
    contentType: req.headers['content-type'] ?? null,
    headers: req.headers,
    query: req.query,
    body: req.body,        // parsed (JSON bo'lsa)
    rawBody,               // xom matn (parse muvaffaqiyatsiz bo'lsa ham ko'rinadi)
  };
}

// POST /webhook/utel — UTel hodisalari shu yerga keladi.
router.post('/utel', async (req: Request, res: Response) => {
  // 1) DARHOL 200 OK — webhook jo'natuvchilari tez javob (ack) kutadi;
  //    kechiksa UTel qayta yuborishi yoki xato deb belgilashi mumkin.
  //    Og'ir ish (log/fayl) javobdan KEYIN bajariladi.
  res.status(200).json({ ok: true });

  // 2) To'liq so'rovni log qilamiz — hech qanday holatda tashlamaydi.
  try {
    const entry = buildEntry(req);

    // Railway loglarida ko'rinadi: `railway logs` yoki dashboard.
    console.log('════════════════ UTEL WEBHOOK ════════════════');
    console.log(JSON.stringify(entry, null, 2));
    console.log('═══════════════════════════════════════════════');

    // Faylga ham yozamiz (lokal ishlab chiqishda qulay; Railway'da efemer).
    try {
      await mkdir(LOG_DIR, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const fname = `utel-${stamp}-${Math.random().toString(36).slice(2, 8)}.json`;
      await writeFile(path.join(LOG_DIR, fname), JSON.stringify(entry, null, 2), 'utf8');
      console.log(`UTel webhook: nusxa faylga yozildi -> ${path.join(LOG_DIR, fname)}`);
    } catch (fileErr: any) {
      // Fayl yozib bo'lmasa (efemer/read-only FS) — bu KUTILGAN, faqat
      // ogohlantiramiz; asosiy log baribir konsolda.
      console.warn('UTel webhook: faylga yozib bo\'lmadi (konsol logi baribir bor):', fileErr?.message);
    }
  } catch (e: any) {
    // Log bosqichidagi xato 200 ack'ни BUZMASIN (u allaqachon yuborilgan).
    console.error('UTel webhook log xatosi:', e?.message || e);
  }
});

// GET /webhook/utel — ba'zi panellar webhook'ni GET bilan "tirikmi" deb
// sinaydi; brauzerdan tekshirish uchun ham qulay.
router.get('/utel', (_req: Request, res: Response) => {
  res.status(200).json({
    ok: true,
    message: 'UTel webhook receiver tirik. Hodisalar POST bilan kutilmoqda (bosqich 1: kuzatish).',
  });
});

export default router;
