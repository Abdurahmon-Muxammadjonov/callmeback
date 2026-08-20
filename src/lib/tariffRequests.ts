import { supabase } from './supabase';
import { isSectionUnlocked, type LockableSection } from './companySections';
import { generateUnlockCode, hashUnlockCode } from './sectionUnlockCode';
import { logAudit } from '../multi-tenant/lib/auditLog';

export interface TariffRow {
  id: string;
  key: string;
  name: string;
  included_sections: string[];
  codes_per_unlock: number;
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

export async function getTariffByKey(key: string): Promise<TariffRow | null> {
  const { data } = await supabase.from('tariffs').select('*').eq('key', key).maybeSingle();
  return data || null;
}

/** Joriy tarifdan KATTAROQ tariflar (upgrade oqimida ko'rsatish uchun). */
export async function tariffsAboveCurrent(currentTariffId: string | null): Promise<TariffRow[]> {
  const all = await listTariffs();
  if (!currentTariffId) return all; // hech qanday tarifi yo'q — hammasi "yuqoriroq"
  const current = all.find((t) => t.id === currentTariffId);
  if (!current) return all;
  return all.filter((t) => t.order > current.order);
}

export interface CreateTariffRequestInput {
  companyId: string;
  requestedTariffId: string;
  telegramId: string;
  phone?: string | null;
  type: 'initial_purchase' | 'upgrade';
}

export async function createTariffRequest(input: CreateTariffRequestInput): Promise<{ id: string }> {
  const { data, error } = await supabase
    .from('tariff_requests')
    .insert({
      company_id: input.companyId,
      requested_tariff_id: input.requestedTariffId,
      requested_by_telegram_id: input.telegramId,
      requested_by_phone: input.phone ?? null,
      type: input.type,
      status: 'pending',
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(error?.message || "So'rov yaratib bo'lmadi.");
  return data;
}

export interface ApprovalResult {
  companyId: string;
  telegramId: string;
  tariffName: string;
  issuedCodes: Array<{ sectionKey: LockableSection; code: string }>;
}

/**
 * Tasdiqlash: companies.tariff_id yangilanadi, HAR bir hali ochilmagan
 * included_sections uchun bitta kod generatsiya qilinadi (2.2-band: "bitta
 * kod = bitta bo'lim"). Kodlarning o'zi bu yerda BO'LIMNI OCHMAYDI — mavjud
 * POST /company/sections/unlock orqali foydalanuvchi qo'lda kiritganda
 * ochiladi (Bot faqat kod BERADI, xuddi /company/admin/section-codes kabi).
 */
export async function approveTariffRequest(requestId: string, adminTelegramId: string): Promise<ApprovalResult> {
  const { data: reqRow, error: reqErr } = await supabase
    .from('tariff_requests')
    .select('id, company_id, requested_tariff_id, requested_by_telegram_id, status')
    .eq('id', requestId)
    .maybeSingle();
  if (reqErr || !reqRow) throw new Error("So'rov topilmadi.");
  if (reqRow.status !== 'pending') throw new Error("So'rov allaqachon hal qilingan.");

  const tariff = await getTariff(reqRow.requested_tariff_id);
  if (!tariff) throw new Error('Tarif topilmadi.');

  const { error: updReqErr } = await supabase
    .from('tariff_requests')
    .update({ status: 'approved', resolved_by: adminTelegramId, resolved_at: new Date().toISOString() })
    .eq('id', requestId)
    .eq('status', 'pending'); // ikki marta bosilsa ikkinchisi hech narsa qilmaydi
  if (updReqErr) throw new Error(updReqErr.message);

  await supabase.from('companies').update({ tariff_id: tariff.id }).eq('id', reqRow.company_id);

  const issuedCodes: Array<{ sectionKey: LockableSection; code: string }> = [];
  for (const sectionKey of tariff.included_sections as LockableSection[]) {
    const alreadyUnlocked = await isSectionUnlocked(supabase, reqRow.company_id, sectionKey);
    if (alreadyUnlocked) continue; // qayta kod berilmaydi — hech narsa buzilmaydi

    const code = generateUnlockCode();
    const { error: codeErr } = await supabase.from('section_unlock_codes').insert({
      company_id: reqRow.company_id,
      section_key: sectionKey,
      code: hashUnlockCode(code),
      created_by: `bot2:${adminTelegramId}`,
    });
    if (codeErr) {
      console.error(`Kod yaratishda xato (company=${reqRow.company_id}, section=${sectionKey}):`, codeErr.message);
      continue;
    }
    issuedCodes.push({ sectionKey, code });
  }

  await logAudit({
    companyId: reqRow.company_id,
    userId: null,
    action: 'tariff_request_approved',
    metadata: { request_id: requestId, tariff_key: tariff.key, admin_telegram_id: adminTelegramId, sections_issued: issuedCodes.map((c) => c.sectionKey) },
  });

  return { companyId: reqRow.company_id, telegramId: reqRow.requested_by_telegram_id, tariffName: tariff.name, issuedCodes };
}

export interface RejectionResult {
  companyId: string;
  telegramId: string;
}

export async function rejectTariffRequest(requestId: string, adminTelegramId: string, reason: string): Promise<RejectionResult> {
  const { data: reqRow, error: reqErr } = await supabase
    .from('tariff_requests')
    .select('id, company_id, requested_by_telegram_id, status')
    .eq('id', requestId)
    .maybeSingle();
  if (reqErr || !reqRow) throw new Error("So'rov topilmadi.");
  if (reqRow.status !== 'pending') throw new Error("So'rov allaqachon hal qilingan.");

  const { error: updErr } = await supabase
    .from('tariff_requests')
    .update({ status: 'rejected', rejection_reason: reason, resolved_by: adminTelegramId, resolved_at: new Date().toISOString() })
    .eq('id', requestId)
    .eq('status', 'pending');
  if (updErr) throw new Error(updErr.message);

  await logAudit({
    companyId: reqRow.company_id,
    userId: null,
    action: 'tariff_request_rejected',
    metadata: { request_id: requestId, admin_telegram_id: adminTelegramId, reason },
  });

  return { companyId: reqRow.company_id, telegramId: reqRow.requested_by_telegram_id };
}
