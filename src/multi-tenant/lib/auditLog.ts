import { supabaseAdmin } from './supabaseAdmin';

export type AuditAction =
  | 'register'
  | 'register_company'
  | 'invite_code_regenerated'
  | 'crm_credentials_updated'
  | 'role_changed'
  | 'tariff_request_approved'
  | 'tariff_request_rejected';

interface LogAuditParams {
  companyId: string;
  userId: string | null; // null — hali public.users'da yozuvi yo'q anonim harakat uchun
  action: AuditAction;
  ipAddress?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Har bir muhim harakatdan keyin chaqiriladi. Xatolik atayin "yutib
 * yuboriladi" (throw qilinmaydi) — audit yozish muvaffaqiyatsiz bo'lgani
 * uchun asosiy amal (masalan role o'zgartirish) foydalanuvchiga xato bo'lib
 * ko'rinishi noto'g'ri; buning o'rniga serverga log yoziladi, DevOps buni
 * kuzatishi mumkin.
 */
export async function logAudit(params: LogAuditParams): Promise<void> {
  const { error } = await supabaseAdmin().from('audit_logs').insert({
    company_id: params.companyId,
    user_id: params.userId,
    action: params.action,
    ip_address: params.ipAddress ?? null,
    metadata: params.metadata ?? {},
  });

  if (error) {
    console.error(`Audit log yozib bo'lmadi (action=${params.action}, company=${params.companyId}):`, error.message);
  }
}
