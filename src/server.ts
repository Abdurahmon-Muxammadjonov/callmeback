import './env';

import express from 'express';
import cors from 'cors';
import { execSync } from 'node:child_process';

import usersRouter from './routes/users';
import analyzeCallRouter, { recoverStuckCalls } from './routes/analyze-call';
import managersRouter from './routes/managers';
import criteriaRouter from './routes/criteria';
import callsRouter from './routes/calls';
import analyticsRouter from './routes/analytics';
import managementRouter from './routes/management';
import notificationsRouter from './routes/notifications';
import shiftsRouter from './routes/shifts';
import crmRouter, { runScheduledCrmSync } from './routes/crm';

const app = express();
const allowedOrigins = [
  'https://procell.uz',
  'https://www.procell.uz',
  'https://prosell.vercel.app',
  'http://localhost:3000',
];

process.on('unhandledRejection', (reason) => {
  console.error('[process] unhandledRejection:', (reason as any)?.message || reason);
});

process.on('uncaughtException', (error) => {
  console.error('[process] uncaughtException:', error?.message || error);
});

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Accept', 'Content-Type', 'Authorization'],
  credentials: true,
}));
app.use(express.json());

app.use('/users', usersRouter);
app.use('/managers', managersRouter);
app.use('/criteria', criteriaRouter);
app.use('/api/analyze-call', analyzeCallRouter);
app.use('/api/calls', callsRouter);
app.use('/analytics', analyticsRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/management', managementRouter);
app.use('/manager-notifications', notificationsRouter);
app.use('/shifts', shiftsRouter);
app.get('/', (_req, res) => {
  return res.status(200).json({
    success: true,
    service: 'callmeback-backend',
    status: 'ok',
    message: 'Backend is running',
    endpoints: {
      analytics: '/analytics',
      calls: '/api/calls',
      analyzeCall: '/api/analyze-call',
      crm: '/crm',
    },
  });
});
app.get('/health', (_req, res) => {
  return res.status(200).json({ success: true, status: 'ok' });
});
app.get('/api/health', (_req, res) => {
  return res.status(200).json({ success: true, status: 'ok' });
});
app.get('/crm/webhook/pbx', (_req, res) => {
  return res.status(200).json({ status: 1 });
});
app.use('/crm', crmRouter);

// Server DOIM shu portda ishlaydi (boshqasiga "qochmaydi").
const PORT = parseInt(process.env.PORT || '5001', 10);

// Portni egallagan jarayon(lar)ni o'chiradi (macOS/Linux: lsof + kill).
function freePort(port: number): void {
  try {
    const out = execSync(`lsof -ti tcp:${port}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (!out) return;
    const pids = out.split('\n').filter((p) => p && Number(p) !== process.pid);
    for (const pid of pids) {
      try {
        process.kill(Number(pid), 'SIGKILL');
      } catch {
        /* jarayon allaqachon tugagan bo'lishi mumkin */
      }
    }
    if (pids.length) console.log(`Port ${port} band edi — egallagan jarayon(lar) o'chirildi: ${pids.join(', ')}`);
  } catch {
    /* lsof bo'sh natija qaytarsa (port bo'sh) — xato emas */
  }
}

function startServer(port: number, isRetry = false): void {
  const server = app.listen(port, () => {
    console.log(`⚡ server is running in ${port} port`);

    // Restart/deploy natijasida 'processing' da osilib qolgan qo'ng'iroqlarni qayta tiklash.
    // CRM batch'i yarim qolib server qayta ishga tushsa ham — qo'ng'iroqlar yo'qolmaydi.
    recoverStuckCalls()
      .then((r) => { if (r.recovered) console.log(`♻️  ${r.recovered} ta osilib qolgan qo'ng'iroq qayta tahlilga qo'yildi.`); })
      .catch((e) => console.error('Boot recovery failed:', e?.message));

    // Watchdog — har 5 daqiqada osilib qolgan 'processing' larni tekshiradi
    // (fon loop jim o'lib qolsa ham qo'ng'iroqlar tiklanadi).
    const watchdog = setInterval(() => {
      recoverStuckCalls().catch((e) => console.error('Watchdog recovery failed:', e?.message));
    }, 5 * 60 * 1000);
    watchdog.unref(); // process'ni tirik ushlab turmasin

    // amoCRM davriy sync — ulangan bo'lsa menejerlarni avtomatik yangilab turadi.
    // CRM_SYNC_MINUTES=0 bo'lsa o'chiriladi (default 10 daqiqa).
    const crmSyncMin = parseInt(process.env.CRM_SYNC_MINUTES || '10', 10);
    if (crmSyncMin > 0) {
      runScheduledCrmSync().catch(() => {}); // boot'da bir marta
      const crmCron = setInterval(() => {
        runScheduledCrmSync().catch((e) => console.error('CRM cron failed:', e?.message));
      }, crmSyncMin * 60 * 1000);
      crmCron.unref();
    }

    // Realtime listener — ixtiyoriy (REALTIME_LISTENER=true bo'lsa yoqiladi).
    if (process.env.REALTIME_LISTENER === 'true') {
      import('./lib/realtime-listener')
        .then((m) => m.startRealtimeListener())
        .catch((e) => console.error('Realtime listener start failed:', e?.message));
    }
  });
  server.once('error', (err: any) => {
    if (err.code === 'EADDRINUSE' && !isRetry) {
      console.log(`Port ${port} band. Egallagan jarayonni o'chirib, qaytadan urinamiz...`);
      freePort(port);
      setTimeout(() => startServer(port, true), 600);
    } else {
      console.error('Failed to start server:', err);
      process.exit(1);
    }
  });
}

startServer(PORT);
