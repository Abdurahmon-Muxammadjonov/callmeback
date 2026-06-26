import './env';

import express from 'express';
import cors from 'cors';
import { execSync } from 'node:child_process';

import usersRouter from './routes/users';
import analyzeCallRouter from './routes/analyze-call';
import managersRouter from './routes/managers';
import criteriaRouter from './routes/criteria';
import callsRouter from './routes/calls';
import analyticsRouter from './routes/analytics';
import managementRouter from './routes/management';
import notificationsRouter from './routes/notifications';
import shiftsRouter from './routes/shifts';

const app = express();

app.use(cors());
app.use(express.json());

app.use('/users', usersRouter);
app.use('/managers', managersRouter);
app.use('/criteria', criteriaRouter);
app.use('/api/analyze-call', analyzeCallRouter);
app.use('/api/calls', callsRouter);
app.use('/analytics', analyticsRouter);
app.use('/api/management', managementRouter);
app.use('/manager-notifications', notificationsRouter);
app.use('/shifts', shiftsRouter);

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
