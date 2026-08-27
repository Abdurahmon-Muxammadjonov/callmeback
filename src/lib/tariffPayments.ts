import { supabase } from './supabase';
import { isSectionUnlocked, type LockableSection } from './companySections';
import { logAudit } from '../multi-tenant/lib/auditLog';

// Part D — to'lov + chek + proratsiya + muddatli kod (supabase/tariff_payments_v2.sql).
// Bu fayl eskirgan src/lib/tariffRequests.ts'ni ALMASHTIRADI (tariff_requests
// jadvaliga asoslangan, chek/narx/proratsiyasiz soddalashtirilgan tizim edi).
//
// REVIZIYA 2: approve/reject/redeem endi Node'da ko'p bosqichli
// select+update+insert emas — supabase/tariff_payments_v2.sql'dagi ATOMIK
// Postgres funksiyalarini chaqiradi (approve_key_request va h.k.) — bitta
// so'rov, `for update` bilan qulflangan, ikki marta bosilsa ikkinchisi
// aniq xato bilan rad etiladi, oraliqda xato bo'lsa hammasi orqaga qaytadi.

export interface TariffRow {
  id: string;
  key: string;
  name: string;
  price: number;
  included_sections: string[];
  order: number;
}

export async function listTariffs(): Promise<TariffRow[]> {
  const { data, error } = await supabase.from('tariffs').select('*').order('order', { ascending: true });
  if (error) throw new Error(error.message);
  return data || [];
}

export async function getTariff(id: string): Promise<TariffRow | null> {
  const { data } = await supabase.from('tariffs').select('*').eq('id', id).maybeSingle();
  return data || null;
}

// Telefon raqamlarni solishtirish uchun kanonik shaklga keltiradi — SQL
// tomonidagi normalize_phone() bilan bir xil qoida (src/routes/crm.ts'dagi
// normalizePhone() ham xuddi shu qoida, mustaqil nusxa — u yerdan import
// qilish route->lib bog'liqligini teskari aylantirar edi).
function normalizePhone(raw: string): string {
  const digits = (raw || '').replace(/\D+/g, '');
  if (!digits) return '';
  return digits.length <= 9 ? digits : digits.slice(-9);
}

// ============================================================================
// Proratsiya (D.4 band 4): faol obunasi bo'lsa (now() < expires_at) — oldin
// to'langan summa chegirma sifatida olinadi; muddati o'tgan bo'lsa chegirmasiz.
// ============================================================================
export interface LatestSubscription {
  id: string;
  company_id: string;
  tariff_id: string;
  paid_amount: number;
  paid_at: string;
  expires_at: string;
}

export async function findLatestSubscriptionByPhone(phone: string): Promise<LatestSubscription | null> {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;

  const { data, error } = await supabase
    .from('subscriptions')
    .select('id, company_id, tariff_id, paid_amount, paid_at, expires_at')
    .eq('phone', normalized)
    .order('paid_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data || null;
}

export function isSubscriptionActive(sub: LatestSubscription): boolean {
  return new Date(sub.expires_at).getTime() > Date.now();
}

export function computeProratedPrice(newTariffPrice: number, sub: LatestSubscription | null): { discount: number; finalPrice: number } {
  const active = sub ? isSubscriptionActive(sub) : false;
  const discount = active ? Number(sub!.paid_amount) : 0;
  const finalPrice = Math.max(0, newTariffPrice - discount);
  return { discount, finalPrice };
}

// RPC xatosidan Postgres RAISE EXCEPTION matnini chiqarib, aniq Error'ga
// aylantiradi (bir nechta joyda takrorlanmasin deb umumiy funksiya).
function rpcErrorToMessage(error: { message?: string } | null, fallback: string): string {
  return error?.message || fallback;
}

// ============================================================================
// key_requests — "Kalit olish" (D.3)
// ============================================================================
export interface CreateKeyRequestInput {
  companyId: string;
  tariffId: string;
  fullName: string;
  phone: string;
  telegramId: string;
  receiptFileId: string;
}

export async function createKeyRequest(input: CreateKeyRequestInput): Promise<{ id: string }> {
  const tariff = await getTariff(input.tariffId);
  if (!tariff) throw new Error('Tarif topilmadi.');

  const { data, error } = await supabase
    .from('key_requests')
    .insert({
      company_id: input.companyId,
      tariff_id: input.tariffId,
      full_name: input.fullName,
      phone: input.phone,
      telegram_id: input.telegramId,
      receipt_file_id: input.receiptFileId,
      quoted_price: tariff.price, // so'rov yaratilgan paytdagi narx "muzlatiladi" (Reviziya 2, band 7)
      paid_amount: 0,
      status: 'pending',
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(error?.message || "So'rov yaratib bo'lmadi.");
  return data;
}

export interface KeyApprovalResult {
  telegramId: string;
  tariffName: string;
  code: string;
}

export async function approveKeyRequest(requestId: string, adminTelegramId: string): Promise<KeyApprovalResult> {
  const { data, error } = await supabase.rpc('approve_key_request', {
    p_request_id: requestId,
    p_admin_telegram_id: adminTelegramId,
  });
  if (error) throw new Error(rpcErrorToMessage(error, "Tasdiqlab bo'lmadi."));

  const result = data as { company_id: string; telegram_id: string; tariff_name: string; code: string };

  await logAudit({
    companyId: result.company_id,
    userId: null,
    action: 'key_request_approved',
    metadata: { request_id: requestId, tariff_name: result.tariff_name, admin_telegram_id: adminTelegramId },
  });

  return { telegramId: result.telegram_id, tariffName: result.tariff_name, code: result.code };
}

export async function rejectKeyRequest(requestId: string, adminTelegramId: string, reason: string): Promise<{ telegramId: string }> {
  const { data, error } = await supabase.rpc('reject_key_request', {
    p_request_id: requestId,
    p_admin_telegram_id: adminTelegramId,
    p_reason: reason,
  });
  if (error) throw new Error(rpcErrorToMessage(error, "Rad etib bo'lmadi."));

  const result = data as { company_id: string; telegram_id: string };

  await logAudit({
    companyId: result.company_id,
    userId: null,
    action: 'key_request_rejected',
    metadata: { request_id: requestId, admin_telegram_id: adminTelegramId, reason },
  });

  return { telegramId: result.telegram_id };
}

// ============================================================================
// tariff_change_requests — "Tarifni o'zgartirish" (D.4)
// ============================================================================
export interface CreateTariffChangeRequestInput {
  companyId: string;
  fullName: string;
  phone: string;
  telegramId: string;
  oldTariffId: string | null;
  newTariffId: string;
  discountApplied: number;
  finalPrice: number;
  receiptFileId: string | null; // null — finalPrice=0 bo'lsa (chek shart emas)
}

export async function createTariffChangeRequest(input: CreateTariffChangeRequestInput): Promise<{ id: string }> {
  const { data, error } = await supabase
    .from('tariff_change_requests')
    .insert({
      company_id: input.companyId,
      full_name: input.fullName,
      phone: input.phone,
      telegram_id: input.telegramId,
      old_tariff_id: input.oldTariffId,
      new_tariff_id: input.newTariffId,
      discount_applied: input.discountApplied,
      final_price: input.finalPrice,
      receipt_file_id: input.receiptFileId,
      status: 'pending',
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(error?.message || "So'rov yaratib bo'lmadi.");
  return data;
}

export interface TariffChangeApprovalResult {
  telegramId: string;
  code: string;
  tariffName: string;
}

export async function approveTariffChangeRequest(requestId: string, adminTelegramId: string): Promise<TariffChangeApprovalResult> {
  const { data, error } = await supabase.rpc('approve_tariff_change_request', {
    p_request_id: requestId,
    p_admin_telegram_id: adminTelegramId,
  });
  if (error) throw new Error(rpcErrorToMessage(error, "Tasdiqlab bo'lmadi."));

  const result = data as { company_id: string; telegram_id: string; tariff_name: string; code: string };

  await logAudit({
    companyId: result.company_id,
    userId: null,
    action: 'tariff_change_request_approved',
    metadata: { request_id: requestId, tariff_name: result.tariff_name, admin_telegram_id: adminTelegramId },
  });

  return { telegramId: result.telegram_id, tariffName: result.tariff_name, code: result.code };
}

export async function rejectTariffChangeRequest(
  requestId: string,
  adminTelegramId: string,
  reason: string,
): Promise<{ telegramId: string }> {
  const { data, error } = await supabase.rpc('reject_tariff_change_request', {
    p_request_id: requestId,
    p_admin_telegram_id: adminTelegramId,
    p_reason: reason,
  });
  if (error) throw new Error(rpcErrorToMessage(error, "Rad etib bo'lmadi."));

  const result = data as { company_id: string; telegram_id: string };

  await logAudit({
    companyId: result.company_id,
    userId: null,
    action: 'tariff_change_request_rejected',
    metadata: { request_id: requestId, admin_telegram_id: adminTelegramId, reason },
  });

  return { telegramId: result.telegram_id };
}

// isSectionUnlocked / LockableSection qayta eksport qilinadi — tariffFlow.ts
// va bot2.ts uchun bitta import manbai qulayroq (avvalgi versiyada ham shu
// naqsh bor edi).
export { isSectionUnlocked, type LockableSection };
