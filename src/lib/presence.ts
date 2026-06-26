// Oddiy in-memory presence — kim onlayn ekanini kuzatadi.
// Migration shart emas: server qayta ishga tushsa, hamma offline bo'ladi (presence
// tabiatan vaqtinchalik). Foydalanuvchi login qilganda / heartbeat yuborganda
// `lastSeen` yangilanadi; belgilangan vaqt ichida ko'rinmasa — offline.

const seen = new Map<string, number>();

// Shu vaqt ichida heartbeat kelmasa offline hisoblanadi.
const ONLINE_WINDOW_MS = 120_000; // 2 daqiqa

export function markOnline(id: string): void {
  if (id) seen.set(id, Date.now());
}

export function markOffline(id: string): void {
  seen.delete(id);
}

export function onlineIds(): string[] {
  const now = Date.now();
  const out: string[] = [];
  for (const [id, ts] of seen) {
    if (now - ts <= ONLINE_WINDOW_MS) out.push(id);
    else seen.delete(id); // eskirgan yozuvlarni tozalaymiz
  }
  return out;
}
