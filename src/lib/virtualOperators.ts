import { createHash } from 'node:crypto';
import { operatorNamesByExt } from './operatorNames';
import { reportRpc } from './reportRpc';

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
//
// TEZLIK (2026-10-12): avval kompaniyaning butun tarixidagi xodimsiz
// qo'ng'iroqlari (15 000+ qator) fetchAllRows bilan tortilib Node'da
// guruhlanardi — har safar xodimlar ro'yxati ochilganda o'nlab so'rov.
// Endi guruhlash bazada (supabase/perf_08_virtual_operators.sql): ichki
// raqam (bo'shliqlari kesilgan), qo'ng'iroqlar soni va birinchi qo'ng'iroq.
//
// NOM (2026-10-16): akkaunt bog'langan raqam uchun "Xodimlarni boshqarish"dagi
// ism (lib/operatorNames.ts) — /managers orqali butun dashboard shu ismni oladi.
export async function listVirtualOperators(companyId: string): Promise<VirtualOperator[]> {
  const [items, names] = await Promise.all([
    reportRpc<VirtualOperatorRow[]>('company_virtual_operators', { p_company_id: companyId }),
    operatorNamesByExt(companyId),
  ]);
  return virtualOperatorsFromRows(companyId, items || [], names);
}

export interface VirtualOperatorRow { ext: string; count: number; first: string | null }

// SOF funksiya — bazaga murojaat qilmaydi (test/solishtirish uchun alohida).
export function virtualOperatorsFromRows(
  companyId: string,
  rows: VirtualOperatorRow[],
  nameByExt: Map<string, string> = new Map(),
): VirtualOperator[] {
  return [...rows]
    .sort((a, b) => Number(b.count) - Number(a.count) || (a.ext < b.ext ? -1 : a.ext > b.ext ? 1 : 0))
    .map((v) => ({
      id: virtualManagerId(companyId, v.ext),
      name: nameByExt.get(String(v.ext).trim()) || `Operator ${v.ext}`,
      pbx_id: v.ext,
      status: 'active',
      role: null,
      platform_id: null,
      daily_call_target: 0,
      created_at: v.first || null,
      call_count: Number(v.count) || 0,
      virtual: true as const,
    }));
}
