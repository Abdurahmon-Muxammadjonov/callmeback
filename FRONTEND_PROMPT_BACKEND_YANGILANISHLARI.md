# Backend yangilanishlari — Frontend uchun integratsiya prompt

> Bu faylni frontend'ga (yoki frontend AI'ga) bering. Backend (`procell-backend`)
> tomonda quyidagi narsalar qo'shildi/o'zgardi. Hech biri mavjud narsani
> BUZMAYDI — barcha yangi maydonlar ixtiyoriy (`?`), yangi endpoint'lar
> QO'SHIMCHA. Bitta joy bundan mustasno — pastdagi **§4** ("MUHIM — kod
> kiritish modali") — u eski xatti-harakatni almashtiradi, e'tibor bering.

Backend: Express + Supabase (procell-backend). Javoblar `{ success, data }`
konvertida (xato bo'lsa `{ success: false, error }`).

---

## §1. "Analitika" sahifasi — `CallRow`ga yangi maydonlar

`GET /api/calls` va `GET /api/calls/:id` javobidagi har bir qatorda endi
(audio tahlil qilingan qo'ng'iroqlar uchun) quyidagi maydonlar bo'lishi
mumkin — barchasi `number | null`, ixtiyoriy:

```ts
interface CallRow {
  // ... mavjud maydonlar o'zgarmagan ...
  incoming_count?: number;
  outgoing_count?: number;
  unanswered_count?: number;
  bad_leads_count?: number;
  new_leads_count?: number;
  sent_to_dealer_count?: number;
  closed_deals_count?: number;
}
```

Bular haqiqiy Gemini tahlilidan keladi (avval hardcoded 0 edi). Eski
qo'ng'iroqlar (SQL migratsiyadan oldin tahlil qilinganlar) bu maydonlarda
`0` qoladi — bu normal, "ma'lumot yo'q" emas, "0 ta" degani.

---

## §2. KPI norma sozlamalari — `company_settings`

```
GET /company/settings   (Bearer token)
← 200 { success: true, data: {
  qualified_call_seconds: 60,
  min_qualified_calls_day: 40,
  min_qualified_calls_week: 160,
  min_qualified_calls_month: 640,
  min_efficiency_score: 50
} }

PATCH /company/settings   (Bearer token, faqat director/admin)
body: istalgan bo'lagi yuqoridagi maydonlardan (partial update)
← 200 { success: true, data: { ...yangilangan qiymatlar } }
```

`app/lib/analytics.ts`'dagi `DEFAULT_NORMS` bilan bir xil qiymatlar
standart holatda — endi bu qiymatlarni sozlash sahifasi orqali
o'zgartirish mumkin, `fetchAnalyticsData(period, signal, norms)`ga shu
javobni uzating.

**Muhim:** backendning o'z tomonida ham (menejer "NORMA OSTIDA" flag
qilish mantig'i) endi shu sozlamalarni dinamik o'qiydi — demak sozlash
sahifasida qiymat o'zgartirilsa, faqat frontend ko'rinishi emas, real
xatti-harakat ham o'zgaradi.

---

## §3. Analitika agregatsiya endpoint'lari — javob shakli O'ZGARMAGAN

`GET /analytics/overview` va `GET /api/management/relationship-dynamics`
— javob JSON shakli **aynan bir xil qoldi**, frontendda hech narsa
o'zgartirish shart emas. Faqat backend ichida hisob-kitob endi to'g'ridan
-to'g'ri Postgres'da (RPC) bajariladi — oldin ko'p qo'ng'iroqli davrlarda
1000 tagacha cheklanib noto'g'ri son qaytarardi, endi to'g'ri va tezroq.

---

## §4. MUHIM — "Kalit/Kod kiritish" modali endi YANGI endpoint'ga boradi

Sahifadagi qulflangan bo'limni bosganda chiqadigan **13 belgili kod
kiritish** modali (B.4/D.6 spec) endi quyidagi endpoint'ga POST
qilishi kerak:

```
POST /company/tariff/unlock   (Bearer token, faqat director/admin)
body: { "code": "AB3XK9QZ1M4P7" }

← 200 { success: true, data: { unlocked_sections: ["call_analytics", "reports", ...] } }
← 400 { success: false, error: "Noto'g'ri kod." }
← 400 { success: false, error: "Bu kod allaqachon ishlatilgan." }
← 400 { success: false, error: "Kod muddati tugagan (1 soat) — botdan yangi kod so'rang." }
← 403 { success: false, error: "Bu kod boshqa kompaniyaga tegishli." }
```

**Nega bu muhim:** Telegram bot (Bot 1/Bot 2) endi to'lov tasdiqlangach
BITTA 13 belgili kod beradi — shu kod BUTUN tarifni (barcha kiritilgan
bo'limlarni) bir yo'la ochadi. Agar frontend'dagi kod modali hozir
`POST /company/sections/unlock` (`{section_key, code}`, bo'lim-bo'lim,
8 belgili-chiziqcha formatdagi kod) ga yuborayotgan bo'lsa — bot beradigan
YANGI kodlar bilan ishlamaydi, chunki format va endpoint boshqa.

`POST /company/sections/unlock` **o'chirilmadi** — u alohida, mustaqil
yo'l bo'lib qoladi (SalesPulse admin qo'lda, bitta bo'lim uchun, botsiz
kod berganda ishlatiladi). Lekin foydalanuvchi botdan olgan kod uchun
modal ENDI `/company/tariff/unlock`ga murojaat qilishi kerak, `code`dan
boshqa hech narsa (section_key kerak emas) yubormasdan.

Muvaffaqiyatli javobdan keyin: `unlocked_sections` massividagi
bo'limlarni state'da darhol qulfdan ochib qo'ying (reload shart emas) —
xuddi eski `/sections/unlock` javobidan keyin qilingandek.

**Kod muddati endi 1 SOAT** (avval 30 daqiqa deb hujjatlashtirilgan edi —
bot foydalanuvchiga ham shunday deydi). Agar sizda kod kiritish modalida
"XX daqiqa qoldi" kabi hisoblagich bo'lsa, 60 daqiqaga moslang.

**Animatsiya (ixtiyoriy, lekin so'ralgan):** kod muvaffaqiyatli
kiritilib, `unlocked_sections` qaytganda, sidebar'dagi endi ochilgan
bo'lim(lar) uchun bir martalik "ochilish" animatsiyasi (masalan qulf
ikonkasi yo'qolib, bo'lim porlab/fade-in bo'lib ochilishi) ko'rsatilishi
kerak — oddiy, animatsiyasiz holat almashinuvi emas.

**Eslatma:** kod muvaffaqiyatli ishlatilganda `companies.tariff_id` ham
yangilanadi (kompaniya endi yangi tarifga o'tadi) — agar UI'da joriy
tarif nomi/logotipi ko'rsatilsa (masalan sozlamalar sahifasida), `GET
/company/me`ni ham qayta chaqiring, faqat `company_sections`ni emas.

---

## §5. Eslatma — o'zgarmagan narsalar

- `GET /company/sections` — shakli o'zgarmagan: `[{section_key, is_locked, in_plan}]`
- `GET /company/me` — shakli o'zgarmagan: `tariff_id`/`tariff:{key,name,included_sections}` allaqachon bor edi
- `POST /internal/telegram/deeplink` — shakli o'zgarmagan: `{purpose}` → `{url}`, "Kod yo'qmi?"/"Upgrade" tugmalari shu bilan ishlayveradi

**Kontekst uchun (frontend'da hech narsa o'zgartirish shart emas):**
"Kod yo'qmi?"/"Upgrade" tugmalari orqali ochiladigan bot oqimida endi
narx **xodimlar soniga ko'paytiriladi** (tarif narxi = bitta xodimga
narx) va to'lov/chek/tasdiqlash butunlay Telegram ichida bo'ladi — sayt
faqat deep-link URL yaratadi va oxirida 13 belgili kodni qabul qiladi
(yuqoridagi §4). Bu tafsilotlar API kontraktiga ta'sir qilmaydi.

---

## ✅ Tekshiruv ro'yxati

1. "Analitika" sahifasida "Kiruvchi vs Chiquvchi" donut, "Lid ko'tarmadi"/
   "Sifatsiz lid"/"Yangi lidlar"/"Avtosalonga yuborildi" kartalari endi
   bo'sh holat o'rniga real raqam ko'rsatishi kerak (SQL migratsiya
   ishga tushgach, yangi tahlil qilingan qo'ng'iroqlar uchun).
2. Sozlash sahifasida norma qiymatlarini o'zgartirib, keyingi `GET
   /company/settings`da ko'rinishini tekshiring.
3. Botdan 13 belgili kod olib, uni kod modali orqali kiritib ko'ring —
   `unlocked_sections`dagi bo'limlar darhol ochilishi kerak.
4. Muddati o'tgan/allaqachon ishlatilgan/boshqa kompaniyaga tegishli kod
   kiritilganda tegishli xato xabari ko'rinishini tekshiring (yuqoridagi
   §4'dagi 3 ta xato holati).
