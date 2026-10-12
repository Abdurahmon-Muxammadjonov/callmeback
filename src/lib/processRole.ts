// ============================================================================
// PROCESS ROLI (2026-10-12) — API va fon ishchisini ajratish.
//
// NEGA: avval bitta process ham HTTP API'ni, ham UTel navbatini (8 ta
// parallel audio yuklab olish + ffmpeg + Gemini), CRM cron'ini va
// watchdog'ni yuritardi. ffmpeg CPU'ni egallaganda API javoblari
// sekinlashardi. Endi Railway'da ikki servis (bitta repo):
//
//   ROLE=api    (standart) — faqat HTTP. Webhook qo'ng'iroqni bazaga
//               yozadi va shu bilan tamom (status='queued'); tahlilni
//               worker navbatdan oladi.
//   ROLE=worker — recoverStuckCalls + watchdog, UTel navbat ishchisi,
//               operator tavsiyalari jadvali, CRM cron, realtime listener.
//               HTTP'da faqat /health (API xizmat qilmaydi).
//   ROLE=all    — eski bitta-servisli rejim (ikkalasi bitta process'da):
//               lokal ishlab chiqish va worker servis ochilguncha o'tish
//               davri uchun.
//
// DIQQAT: worker faqat BITTA replika bo'lsin — navbatdagi inFlight va
// qayta urinish holati process xotirasida.
// ============================================================================

export type ProcessRole = 'api' | 'worker' | 'all';

export function processRole(): ProcessRole {
  const raw = String(process.env.ROLE || 'api').trim().toLowerCase();
  if (raw === 'worker' || raw === 'all') return raw;
  if (raw !== 'api') console.warn(`ROLE="${raw}" noma'lum — "api" deb olinadi (api | worker | all).`);
  return 'api';
}

/** Fon ishlari (navbat, cron, watchdog) shu process'da yuradimi. */
export function runsBackgroundJobs(): boolean {
  return processRole() !== 'api';
}

/** HTTP API shu process'da xizmat qiladimi. */
export function servesApi(): boolean {
  return processRole() !== 'worker';
}
