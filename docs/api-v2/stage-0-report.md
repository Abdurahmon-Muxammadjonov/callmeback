# API v2 — 0-bosqich: faktlarni qayta tekshirish

Sana: 2026-09-27, 22:20 Asia/Tashkent. Branch: `feat/api-v2`.
Hech narsa deploy qilinmadi, `main` ga push qilinmadi, Railway
o'zgaruvchilariga tegilmadi (§0.7).

---

## 1. TO'SIQ: Appendix A yetib kelmadi

Ish buyrug'i 50 000 belgi chegarasida uzildi va **"Appendix A (API v2
contract)" qismi yo'q**. §0.2 ga ko'ra u shartnoma: "Implement it exactly",
zod sxemalari undan kelib chiqadi, `openapi.json` esa shu sxemalardan
generatsiya qilinadi.

Appendix A bo'lmasa quyidagilarni boshlab bo'lmaydi:
`src/v2/schemas/`, `src/v2/routes/`, `openapi.json`, `Score10`, `Norms`,
`DeepLink`, `CallsFilter`, `Msg`, `ReportData`, `ControlMacroView`,
`ControlRopView`, holat o'girmasi (A.3.7), segment ustuvorligi (A.3.6),
sabab kalitlari (A.5), `expiresAt` (A.3.1), Pulse formulalari (A.3.3).

Appendix A ga bog'liq BO'LMAGAN ishlar (bajarish mumkin):
migratsiyalar (§4), backfill skriptlari (§5), peaks (§8), retention (§7),
company_settings (§0.3), v1 staff-stats tuzatishi (§6.5), worker/jobs
skeleti (§3), region masalasi (§12).

---

## 2. §1 dagi faktlar — tekshiruv natijasi

| Fakt (hujjatda) | Haqiqat |
|---|---|
| Repo, yo'l, servis nomlari | **To'g'ri** |
| Ingestion quvuri (UTel -> MP3 24k mono 16k -> sales-ai-front -> GPT-4o-mini) | **To'g'ri**; base URL `salesAiClient.ts:17` da qattiq yozilgan |
| `UTEL_BATCH=8`, `OPERATOR_DAILY_AUDIO_LIMIT_SEC=3600` | **To'g'ri** (Railway'da tekshirildi) |
| Ish vaqti 09:00–23:00 | **To'g'ri**, lekin **env darajasida** (`WORK_START_HOUR/END_HOUR`), kompaniya bo'yicha emas |
| Statuslar: done/processing/failed/stt_suspect/requeued | **To'g'ri** |
| Ball 0–100 da saqlanadi | **To'g'ri**, ustun nomi `kpi_score` |
| `requeued` limitdan ozod, ozodlik chidamli | **To'g'ri** (bugun shunday qilindi) |
| `daily_stats` jadvali yo'q | **To'g'ri** |
| staff-stats GET ichida GPT chaqiradi | **To'g'ri**, o'lchandi: 7.4 s |
| GPT whitelist ro'yxati | **To'g'ri**, `factRowFields` + 6 test |
| Testlar 21 ta | **23 ta** (bugun 2 ta qo'shildi) |
| `operator_ext` 2026-09-23 ~18:30 dan | **18:05 Toshkent** (13:05:57 UTC) |
| Railway edge lhr1 | **Servis regioni `sfo`** (multiRegionConfig). Edge o'zgarib turadi (sin1, Supabase uchun Cloudflare WAW) |
| DB round-trip ~229 ms | **Tasdiqlandi: 238 ms** (pastga qarang) |

### 2.1 Circuit breaker — hujjatdagi fakt ESKIRGAN

Hujjat: "oxirgi 20 ta, >= 20 s, >= 70% bo'sh". G2: "semantics unchanged".

**Bugun (ish buyrug'idan bir necha soat oldin) bu qiymatlar o'zgartirildi**,
chunki >= 20 s chegarasi YOLG'ON ishga tushdi: UTel jiringlash vaqtini ham
qo'ng'iroq davomiyligi deb yozadi va liniya aynan 60 soniya jiringlab uzadi.

O'lchov (haqiqiy ma'lumot, bo'sh matn ulushi):

| Chegara | Normal kun | Nosozlik davri |
|---|---|---|
| >= 20 s | 16.5% | — |
| >= 45 s | 3.9% | — |
| **>= 60 s** | **0.2%** (419 dan 1) | **89.5%** |
| >= 300 s | 0.0% | 90.8% |

Hozirgi holat: oyna **10**, chegara **>= 60 s**, nisbat 70%. Ogohlantirish
pauzadan mustaqil (ish vaqtida 30 daqiqa jimlik -> Telegram).

**Qaror kerak:** G2 ni qat'iy tushunib eski qiymatlarga qaytarilsinmi
(yolg'on ishga tushish qaytadi), yoki hujjat yangi kalibrlashga
moslashtirilsinmi? Tavsiyam — ikkinchisi.

---

## 3. Sxema holati

`calls`: 47 ustun. §4.1 dagi 24 yangi ustundan **faqat
`transcript_segments` bor**, qolgan 23 tasi yo'q.

§4 jadvallari:

| Jadval | Holat |
|---|---|
| `company_settings` | **BOR**, lekin **0 qator** va boshqa shakl (5 ustun) |
| Qolgan 15 tasi (`system_settings`, `call_hourly_stats`, `call_daily_stats`, `operator_criteria_daily`, `crm_daily_stats`, `crm_funnel_snapshot`, `stats_dirty_days`, `stats_versions`, `notifications`, `notification_reads`, `reports`, `report_bundles`, `audio_retention_runs`, `operator_insights`, `audit_log`) | **yo'q** |

Mavjud `company_settings` shakli (`src/lib/companySettings.ts` dagi
standart qiymatlar — bu §4 seed manbasi):

```
qualified_call_seconds:    60     -> long_call_sec
min_qualified_calls_day:   40     -> daily_long_calls_norm
min_qualified_calls_week:  160
min_qualified_calls_month: 640
min_efficiency_score:      50     -> (0-100 shkalada)
```

---

## 4. Qattiq yozilgan biznes qiymatlari (§0.3)

| Qiymat | Joy | Holat |
|---|---|---|
| Ish vaqti 9 / 23 | `src/lib/workHours.ts:16-17` | env, kompaniya bo'yicha emas |
| Uzun qo'ng'iroq 60 s | `analytics.ts:607,710` | settings'dan o'qiladi, fallback 60 |
| Kunlik norma 40 | `companySettings.ts` | standart qiymat, DB'da qator yo'q |
| **Past ball chegarasi** | `analytics.ts:644` | **`kpi_score < 50` QATTIQ YOZILGAN = 5.0/10** |
| Kunlik audio limiti 3600 s | env | Railway |

### 4.1 Ikki NUMERIK NOMUVOFIQLIK (§6.2 aniq so'ragan)

1. **Uzun qo'ng'iroq `>=`, `>` emas.** Kod: `if (sec >= longSec)`
   (`analytics.ts:636` va `:731`). §6.2 qat'iy `>` talab qiladi.
   Ta'siri: aynan 60 soniyalik qo'ng'iroqlar hozir "uzun" deb sanaladi,
   v2 da sanalmaydi. UTel liniyasi 60-61 soniyada juda ko'p jiringlash
   yozadi, shuning uchun bu farq **sezilarli** bo'lishi mumkin.

2. **Past ball chegarasi 5.0, 3.0 emas.** Kod `kpi_score < 50`
   ("10 ballikda 5 dan past" izohi bilan). §0.3 esa "3.0 low score" deb
   sanaydi. Seed qaysi qiymatdan olinishi kerak — 5.0 (hozirgi
   production xatti-harakati) yoki 3.0 (hujjat)?

---

## 5. Tezlik: DB boshqa regionda (§0.4, §12)

Production'dan o'lchandi (mening `Server-Timing` middleware'im):

| Endpoint | app vaqti | So'rovlar |
|---|---|---|
| `/api/calls?limit=1` | **237.9 ms** | 1 |
| `/api/analytics/analysis-status` | 379.4 ms | 1 |
| `/api/analytics/daily-summary?days=1` | 1204.2 ms | 2 |

Supabase o'z ichida: `x-envoy-upstream-service-time: **37 ms**`.

Xulosa: **bitta so'rovga ~200 ms sof tarmoq**. Railway servisi `sfo`
(US-West). Ya'ni §12 maqsadlari uchun parallel so'rovlar ham yetmaydi —
har qanday sahifada ~240 ms pol bor.

**Supabase regionini aniqlay olmadim** (API Cloudflare ortida,
`db.<ref>.supabase.co` DNS bermaydi, Platform API uchun token yo'q).
Kerak: Supabase → Settings → General → Region.

---

## 6. Deploy: GitHub ulanishi HALI ISHLAMAYAPTI

| Deploy manbasi | Soni | Muvaffaqiyatli |
|---|---|---|
| GitHub (commit hash bilan) | 3 | **0** |
| `railway up` | qolgan hammasi | ha |

Uchta GitHub deploy'i ham `ede2354` (23-sentabr) ni olishga urinib
yiqilgan. Ulanish tuzatilgandan keyin push qilingan commitlar uchun
GitHub build **umuman yaratilmadi**.

Bu §0.7 ga to'g'ridan-to'g'ri ta'sir qiladi: "The user merges and
deploys" — hozir `main` dan GitHub orqali deploy qilib bo'lmaydi.
Railway → Settings → Source ni yana tekshirish kerak.

---

## 7. Boshqa holat

- v1 endpointlar: **77 ta** (G6 ga ko'ra o'zgarmasligi kerak).
- `first_data_day` (JAMALS): **2026-09-23**.
- `operator_ext_tracked_since`: **2026-09-23 13:05:57 UTC** (18:05 Toshkent).
- Davom etayotgan ish: 24-sentabrdagi STT uzilishi qurbonlarini qayta
  navbatga qo'yish. 22:20 holatiga: ~1126 qator qoldi, ish vaqti 23:00 da
  yopiladi, qolgani ertaga past ustuvorlikda davom etadi.

---

## 8. Keyingi qadam uchun taklif

Appendix A kelguncha quyidagi tartibda ishlashni taklif qilaman
(hammasi shartnomaga bog'liq emas):

1. **1-bosqich:** v1 staff-stats'dan GPT'ni olib tashlash (§6.5) +
   `operator_insights` jadvali va uni to'ldiruvchi job (§10). Bu 7.4 s ->
   < 300 ms beradi va G6 ruxsat bergan o'zgarish.
2. **2-bosqich:** `company_settings` ni §4 shakliga keltirish, barcha
   qattiq yozilgan qiymatlarni settings'ga ko'chirish, seed. Yuqoridagi
   ikki nomuvofiqlik bo'yicha qaroringiz kerak.
3. **3-bosqich:** `calls` ga yangi ustunlar + triggerlar +
   `CREATE INDEX CONCURRENTLY` (23:00 dan keyin), keyin backfill (§5.1).
4. **4-bosqich:** peaks (§8) — ingestion + backfill.
5. **5-bosqich:** retention (§7) — dry-run rejimida.

Appendix A kelishi bilan v2 sxemalari va endpointlari parallel boshlanadi.
