import axios from 'axios';
import { supabase } from './supabase';

// Telegram file_id'lar BOT-XOS: Bot 1'da yuklangan faylni Bot 2 xuddi shu
// file_id bilan qayta yubora olmaydi (Telegram Bot API cheklovi — "file_id
// is valid for the bot that generated it"). Shu sabab audio-pipeline.ts'dagi
// uploadAudioToStorage() bilan bir xil naqsh: rasmni Bot 1'dan yuklab olib,
// Supabase Storage'ga saqlaymiz va URL qaytaramiz — shu URL'ni istalgan bot
// (Bot 2 ham) `sendPhoto(url, ...)` bilan to'g'ridan-to'g'ri ishlata oladi,
// va u DBda ham doimiy (Telegram file_id'dan farqli, muddatsiz) saqlanadi.
const RECEIPT_BUCKET = 'payment-receipts';

export async function downloadAndStoreReceipt(fileUrl: string): Promise<string> {
  const response = await axios.get<ArrayBuffer>(fileUrl, { responseType: 'arraybuffer', timeout: 30000 });
  const buffer = Buffer.from(response.data);

  await supabase.storage.createBucket(RECEIPT_BUCKET, { public: true }).catch(() => {});

  const path = `${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`; // Telegram 'photo' doim JPEG
  const { error } = await supabase.storage.from(RECEIPT_BUCKET).upload(path, buffer, {
    contentType: 'image/jpeg',
    upsert: false,
  });
  if (error) throw new Error(`Chek rasmi saqlanmadi: ${error.message}`);

  const { data } = supabase.storage.from(RECEIPT_BUCKET).getPublicUrl(path);
  if (!data?.publicUrl) throw new Error("Chek rasmi uchun URL olinmadi.");
  return data.publicUrl;
}
