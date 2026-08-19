# SalesPulse — Multi-tenant Auth (Node.js + Express + TypeScript + Supabase)

Kod: `src/multi-tenant/` (mustaqil modul, hozircha `server.ts`'ga ulanmagan —
ulash yo'riqnomasi `src/multi-tenant/index.ts`da). SQL: `supabase/multi_tenant_saas.sql`.

## Fayllar

| Fayl | Vazifa |
|---|---|
| `lib/supabaseAdmin.ts` | service_role klient (RLS'ni chetlab o'tadi, faqat backendda) |
| `middleware/withAuth.ts` | JWT tekshiruvi + `req.auth = { userId, companyId, role }` |
| `middleware/requireRole.ts` | RBAC decorator: `requireRole(['owner','admin'])` |
| `routes/auth.ts` | `POST /auth/register`, `POST /auth/register-company` |
| `routes/campaigns.ts` | `POST /campaigns`, `DELETE /campaigns/:id` (owner/admin) |
| `routes/users.ts` | `PATCH /users/:id/role` (faqat owner) |
| `routes/calls.ts` | `GET /calls` (agent → faqat o'ziniki, boshqalar → hammasi) |
| `routes/integrations.ts` | `POST /company/integrations/crm` (Vault + masking) |

## 3-band: JWT custom claims vs har-so'rovda DB lookup

**Tanlangan yondashuv: gibrid.**

| | Har so'rovda DB'dan | JWT custom claims |
|---|---|---|
| Tezlik | -1 DB so'rov/request | Qo'shimcha so'rov yo'q |
| Yangilik | Har doim aniq | Token muddati (odatda 1soat) tugaguncha eskirishi mumkin |
| Xavfsizlik | Ruxsat olib tashlansa — darhol | Ruxsat olib tashlansa — token yangilanguncha ESKI huquq ishlaydi ⚠️ |

`role` — DB'dan o'qiladi (30s TTL keshi bilan, `requireRole` chaqirilganda emas,
balki `withAuth`da; rol o'zgarganda `invalidateProfileCache()` darhol chaqiriladi
— `routes/users.ts`ga qarang). Sabab: ruxsatni OLIB TASHLASH holati (masalan
admin huquqi bekor qilingan xodim) darhol kuchga kirishi kerak — bu DB
so'rovining arzon narxidan muhimroq.

`company_id` uchun esa JWT custom claim (Supabase Access Token Hook) xavfsiz
tanlov bo'lardi — xodim deyarli hech qachon boshqa tenant'ga ko'chmaydi, shu
sabab eskirish xavfi past, tezlik yutug'i esa yuqori trafikda sezilarli.

RLS (Postgres) — bularning HAMMASIGA QO'SHIMCHA, doim yoqilgan qatlam: hatto
middleware xato qilsa ham, boshqa tenant ma'lumoti chiqmaydi.

## Endpoint'lar

### `POST /auth/register`
Mavjud kompaniyaga `invite_code` orqali qo'shilish.

```
→ { "email": "aziz@salon.uz", "password": "kuchli-parol-123",
    "full_name": "Aziz Karimov", "invite_code": "K7X9M2QRT" }

← 201 { "success": true, "data": {
      "user_id": "b5f78196-...", "company_id": "c1538ccf-...",
      "role": "agent", "full_name": "Aziz Karimov" } }

← 400 { "success": false, "error": "Kompaniya kodi noto'g'ri yoki mavjud emas." }
← 409 { "success": false, "error": "Bu email bilan foydalanuvchi allaqachon mavjud." }
```
Kompaniyaning birinchi useri avtomatik `owner` bo'ladi (DB'dagi
`uq_users_one_owner_per_company` partial-unique-index bilan poyga holatidan
himoyalangan — pastga qarang).

### `POST /auth/register-company`
Yangi kompaniya + owner birga.

```
→ { "company_name": "Toshkent Motors", "email": "ceo@toshkentmotors.uz",
    "password": "kuchli-parol-123", "full_name": "Bekzod Yusupov" }

← 201 { "success": true, "data": {
      "company_id": "9c2e...", "invite_code": "M4K7X2QRT",
      "user_id": "b5f7...", "role": "owner" } }
```
**"Tranzaksiya" haqida muhim izoh:** `auth.users` Supabase Auth (GoTrue)
xizmati orqali yaratiladi — bitta SQL BEGIN/COMMIT ichiga `public.companies`
bilan birga sig'dirib bo'lmaydi. Shu sabab **SAGA pattern** qo'llangan: har
bosqich xato bersa, oldingi bosqich(lar) qo'lda kompensatsiya qilinadi
(company o'chiriladi / auth user o'chiriladi). `routes/auth.ts`dagi izohlarga
qarang.

### RBAC misollari

```
→ POST /campaigns { "name": "...", "script_stages": [...] }
← 201 (owner/admin)         ← 403 (manager/agent bo'lsa)

→ DELETE /campaigns/:id
← 200 (owner/admin)         ← 403 (boshqalar)

→ PATCH /users/:id/role { "role": "manager" }
← 200 (faqat owner)         ← 403 (admin ham yo'q, faqat owner)
← 400 "O'zingizning rolingizni o'zgartira olmaysiz." (id === o'zi bo'lsa)
```

### `GET /calls`
```
← agent:                manager/admin/owner:
  faqat agent_id = men     kompaniyadagi HAMMASI
```
**Schema qo'shimchasi:** asl talabda `calls` jadvalida qaysi xodim ishlagani
yozilmagan edi — bu qoidani DB darajasida ifodalab bo'lmaydi. `calls.agent_id`
ustuni qo'shildi (`ON DELETE SET NULL` — xodim o'chirilsa ham qo'ng'iroq
tarixi qoladi).

### `POST /company/integrations/crm`
```
→ { "crm_type": "amocrm",
    "credentials": { "api_key": "AMO-a1b2c3d4e5f6g7h8i9j0" } }

← 200 { "success": true, "data": {
      "crm_type": "amocrm",
      "credentials_masked": { "api_key": "****g7h8i9j0" },
      "connected_at": "2026-08-15T09:12:00Z" } }

← 403 (manager/agent chaqirsa)
```
`credentials` **hech qachon** oddiy `jsonb` ustunga tushmaydi — Supabase
Vault'ga (`public.set_crm_credentials()` RPC, SECURITY DEFINER) shifrlab
yoziladi, `companies` jadvalida faqat Vault yozuvining `uuid`si saqlanadi.
Javobda va logda faqat maskalangan (oxirgi 4 belgi) versiya chiqadi.

### `PATCH /company/invite-code/regenerate`
Faqat owner/admin. Eski kod shu zahoti ishlamay qoladi (UNIQUE ustunda endi
mavjud emas), yangisi generatsiya qilinadi.

```
← 200 { "success": true, "data": { "invite_code": "P4Q8X2ZKT" } }
← 403 (manager/agent chaqirsa)
```
`audit_logs`ga yoziladi (`invite_code_regenerated`), lekin **yangi kodning
o'zi metadata'ga yozilmaydi** — audit tarixi jonli kirish kodini abadiy
saqlab qolmasligi uchun (pastga, "Audit log" bo'limiga qarang).

### Rate limiting — `/auth/register`
Postgres-asosli (loyihada Redis yo'q, shu sabab yangi infra qo'shilmadi —
`supabase/multi_tenant_saas_rate_limit_audit.sql`dagi
`record_invite_failure_and_maybe_block()` / `is_ip_blocked()` funksiyalari
orqali). Bitta IP'dan 1 daqiqada 5+ **noto'g'ri invite_code** urinishi
bo'lsa, 15 daqiqaga bloklanadi — bloklangan paytda hatto **to'g'ri**
invite_code bilan ham 429 qaytadi (avval IP tekshiriladi, keyin invite_code).

```
← 429 { "success": false, "error": "Juda ko'p noto'g'ri urinish. 15 daqiqadan keyin qayta urinib ko'ring." }
```
`getClientIp()` `X-Forwarded-For`ni o'qiydi — Railway kabi proxy orqasida
`app.set('trust proxy', 1)` MAJBURIY, aks holda barcha so'rovlar bitta
(proxy'ning) IP'i sifatida ko'rinib, hamma bir-birini bloklab qo'yishi mumkin.

### Audit log (`audit_logs`)
Yoziladigan harakatlar: `register`, `register_company`,
`invite_code_regenerated`, `crm_credentials_updated`, `role_changed`.
Faqat **owner/admin** o'qiy oladi (RLS); yozish faqat backend
(`service_role`) orqali — oddiy foydalanuvchi hatto o'z harakatini ham
qo'lda audit_logs'ga qo'sha olmaydi (append-only, ishonchlilik uchun).

`user_id` nullable — sabab: kelajakda anonim (hali `public.users`da yozuvi
yo'q) harakatlar ham shu jadvalga tushishi mumkin. Amalda hozir
`/auth/register`ning **muvaffaqiyatsiz** invite_code urinishlari
`audit_logs`ga EMAS, alohida `invite_code_failed_attempts`ga yoziladi (rate
limit uchun maxsus, tezkor jadval) — audit_logs faqat muvaffaqiyatli
"muhim harakatlar" uchun.

## SQL migratsiyadagi qo'shimchalar (`supabase/multi_tenant_saas.sql`)

Bu backend implementatsiyasi tufayli qo'shilgan (dastlabki so'rovda yo'q edi):

1. `calls.agent_id uuid references users(id) on delete set null` — "agent
   faqat o'zinikini ko'radi" qoidasi uchun.
2. `create unique index uq_users_one_owner_per_company on users(company_id)
   where role = 'owner'` — `/auth/register`dagi "birinchi user = owner"
   mantig'ini poyga holatidan DB darajasida himoya qiladi.
