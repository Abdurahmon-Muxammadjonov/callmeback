import { createHash } from 'node:crypto';
import { supabase, fetchAllRows } from './supabase';

// "Virtual operator" — bazada XODIM sifatida yozilmagan, lekin qo'ng'iroq
// qilgan PBX ichki raqami (calls.operator_ext).
//
// NEGA (2026-09-23): endi PBX'dan kelgan raqam uchun avtomatik xodim
// YARATILMAYDI (avval shunday qilinar va mijozlarning telefon raqamlari
// "xodim" bo'lib ro'yxatni buzib tashlagan edi). Lekin dashboard'dagi
// "Jamoa samaradorligi" xodimlar ro'yxatiga tayanadi — xodim qo'shilmagan
// bo'lsa hammasi 0 bo'lib qolardi. Shu sabab gaplashgan operatorlar
// qo'ng'iroqlardan DINAMIK chiqariladi: bazaga hech narsa yozilmaydi,
// lekin ro'yxatda "Operator 108" kabi ko'rinadi va o'z KPI/lid/kiruvchi-
// chiquvchi ko'rsatkichlari bilan turadi.
//
// Kompaniya o'sha ichki raqamli HAQIQIY xodimni qo'shsa (managers.pbx_id),
// qo'ng'iroqlar unga bog'lanadi (routes/managers.ts) va virtual yozuv
// o'z-o'zidan yo'qoladi — ikki marta ko'rinmaydi.

export interface VirtualOperator {
  id: string;
  name: string;
  pbx_id: string;
  status: string;
  role: string | null;
  platform_id: string | null;
  daily_call_target: number;
  created_at: string | null;
  call_count: number;
  virtual: true;
}

// Ichki raqamdan barqaror (har safar bir xil) UUID ko'rinishidagi id.
// UUID shakli muhim: frontend va boshqa endpoint'lar id'ni UUID deb kutadi.
export function virtualManagerId(companyId: string, ext: string): string {
  const h = createHash('sha1').update(`virtual-operator:${companyId}:${ext}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// Kompaniyaning "xodimga biriktirilmagan" qo'ng'iroqlaridagi operatorlar.
export async function listVirtualOperators(companyId: string): Promise<VirtualOperator[]> {
  const rows = await fetchAllRows<{ operator_ext: string | null; created_at: string }>((from, to) =>
    supabase
      .from('calls')
      .select('operator_ext, created_at')
      .eq('company_id', companyId)
      .is('manager_id', null)
      .not('operator_ext', 'is', null)
      .range(from, to));

  const byExt = new Map<string, { count: number; first: string }>();
  for (const r of rows) {
    const ext = String(r.operator_ext || '').trim();
    if (!ext) continue;
    const cur = byExt.get(ext);
    if (cur) {
      cur.count += 1;
      if (r.created_at < cur.first) cur.first = r.created_at;
    } else {
      byExt.set(ext, { count: 1, first: r.created_at });
    }
  }

  return Array.from(byExt.entries())
    .sort((a, b) => b[1].count - a[1].count)
    .map(([ext, v]) => ({
      id: virtualManagerId(companyId, ext),
      name: `Operator ${ext}`,
      pbx_id: ext,
      status: 'active',
      role: null,
      platform_id: null,
      daily_call_target: 0,
      created_at: v.first || null,
      call_count: v.count,
      virtual: true as const,
    }));
}
