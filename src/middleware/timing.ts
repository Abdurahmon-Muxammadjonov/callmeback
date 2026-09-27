import type { NextFunction, Request, Response } from 'express';

/* =====================================================================
 * SO'ROV VAQTINI O'LCHASH (2026-09-27).
 *
 * Har bir so'rov uchun: method, path, status, davomiylik (ms) va shu
 * so'rov davomida qilingan Supabase so'rovlari soni log'ga yoziladi.
 * Javobga Server-Timing sarlavhasi qo'shiladi — brauzer DevTools'da
 * "Network → Timing" bo'limida ko'rinadi.
 *
 * DB so'rovlari sonini sanash: lib/supabase.ts har so'rovda
 * countDbQuery() chaqiradi; joriy so'rovning hisobi AsyncLocalStorage
 * orqali ajratiladi (bir vaqtda kelgan so'rovlar aralashmasin).
 * ===================================================================== */

import { AsyncLocalStorage } from 'node:async_hooks';

interface RequestStats { db: number }
const store = new AsyncLocalStorage<RequestStats>();

/** lib/supabase.ts dan chaqiriladi — joriy so'rovning DB hisobini oshiradi. */
export function countDbQuery(): void {
  const s = store.getStore();
  if (s) s.db += 1;
}

/** Sekin deb hisoblanadigan chegara (log'da ⚠ bilan belgilanadi). */
const SLOW_MS = Number(process.env.SLOW_REQUEST_MS || 500);

export function timing(req: Request, res: Response, next: NextFunction): void {
  const started = process.hrtime.bigint();
  const stats: RequestStats = { db: 0 };

  store.run(stats, () => {
    // Sarlavha javob ketishidan OLDIN qo'yilishi kerak — shu sabab
    // writeHead'ni ushlaymiz ('finish' hodisasi juda kech bo'ladi).
    const writeHead = res.writeHead.bind(res);
    res.writeHead = ((...args: Parameters<typeof writeHead>) => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      try {
        res.setHeader('Server-Timing', `app;dur=${ms.toFixed(1)}, db;desc="${stats.db} query"`);
      } catch { /* sarlavha allaqachon yuborilgan bo'lsa — e'tiborsiz */ }
      return writeHead(...args);
    }) as typeof res.writeHead;

    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      const slow = ms >= SLOW_MS ? ' ⚠ SEKIN' : '';
      console.log(
        `[vaqt] ${req.method} ${req.originalUrl.split('?')[0]} ${res.statusCode} ` +
        `${ms.toFixed(0)}ms db=${stats.db}${slow}`,
      );
    });
    next();
  });
}
