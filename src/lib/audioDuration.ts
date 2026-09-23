// AUDIO DAVOMIYLIGINI FAYLNING O'ZIDAN aniqlaydi.
//
// NEGA (2026-09-23): UTel "call_saved" hodisasida duration ko'pincha 0
// keladi — 696 qo'ng'iroqdan 586 tasida davomiylik 0 bo'lib qolgan va
// kunlik "gaplashuv daqiqalari" hisoboti yolg'on ko'rsatardi.
//
// Yechim: WAV sarlavhasining birinchi 44 baytini Range so'rovi bilan olamiz
// (butun faylni yuklamaymiz), undan byteRate ni o'qiymiz va fayl to'liq
// hajmini Content-Range dan olamiz:
//     davomiylik = (hajm - 44) / byteRate
// PCM WAV uchun bu aniq natija beradi. WAV bo'lmasa — null qaytadi va
// chaqiruvchi boshqa manbaga (STT natijasidagi duration_sec) tayanadi.

export async function probeWavDurationSec(url: string): Promise<number | null> {
  try {
    const resp = await fetch(url, {
      headers: {
        Range: 'bytes=0-43',
        'User-Agent': 'Procell-Audio/1.0',
        Accept: 'audio/*,*/*',
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!resp.ok && resp.status !== 206) return null;

    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length < 36) return null;
    if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;

    // fmt bo'lagi: byteRate — 28-offsetda (little-endian, 4 bayt).
    const byteRate = buf.readUInt32LE(28);
    if (!byteRate) return null;

    // To'liq hajm: 206 javobida "bytes 0-43/123456", 200 da Content-Length.
    let total = 0;
    const cr = resp.headers.get('content-range');
    if (cr) {
      const m = cr.match(/\/(\d+)\s*$/);
      if (m) total = Number(m[1]);
    }
    if (!total) {
      const cl = Number(resp.headers.get('content-length'));
      if (Number.isFinite(cl) && cl > 44 && resp.status === 200) total = cl;
    }
    if (!total || total <= 44) return null;

    const sec = Math.round((total - 44) / byteRate);
    return sec > 0 && sec < 24 * 3600 ? sec : null;
  } catch {
    return null; // davomiylik — qo'shimcha ma'lumot, xatosi quvurni to'xtatmasin
  }
}
