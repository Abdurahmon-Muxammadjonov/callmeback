# Procell Backend

Express + Supabase backend (call audit, staff, analytics). Bu **faqat backend** loyihasi — frontend kodi yo'q.

## Ishga tushirish

```bash
npm install
npm run dev      # tsx watch — development
```

Server `http://localhost:5001` portida ishlaydi (`.env.local` dagi `PORT` orqali o'zgartiriladi).

Frontend yoki dashboard `NEXT_PUBLIC_API_URL` orqali backend'ga ulangan bo'lsa, uni `http://localhost:5001` qilib qo'ying. `http://localhost:5000` bu loyiha uchun ishlatilmaydi.

## Skriptlar

| Buyruq          | Vazifasi                                    |
| --------------- | ------------------------------------------- |
| `npm run dev`   | tsx watch bilan dev rejimda ishga tushirish |
| `npm run build` | TypeScript → `dist/` ga kompilyatsiya       |
| `npm start`     | `dist/server.js` ni ishga tushirish (prod)  |
| `npm run lint`  | ESLint                                      |

## Tuzilma

```
src/
  server.ts        # Express ilova + barcha route'larni ulash; ROLE bo'yicha fon ishlari
  env.ts           # .env yuklash / tekshirish
  lib/             # supabase klient, presence, realtime listener
  routes/          # users, calls, analyze-call, analytics, managers, ...
  types/           # umumiy TypeScript tiplari
supabase/          # SQL migratsiyalar / schema
```

## Muhit o'zgaruvchilari

`.env.local.template` dan nusxa olib `.env.local` yarating va to'ldiring
(Supabase, Aisha va Gemini kalitlari).

Minimal kerakli o'zgaruvchilar:

- `SUPABASE_URL` (yoki `NEXT_PUBLIC_SUPABASE_URL`)
- `SUPABASE_SERVICE_ROLE_KEY`
- `AISHA_API_KEY` (Aisha.group nutqni matnga aylantirish)
- `GEMINI_API_KEY` (Google Gemini — transkriptni tahlil qilish)

- `ROLE` — `api` (standart), `worker` yoki `all` (pastga qarang)

## API va worker (ROLE)

Bitta repo ikki xil process sifatida ishlaydi (`src/lib/processRole.ts`):

| `ROLE`           | Nima qiladi                                                                                                   |
| ---------------- | ------------------------------------------------------------------------------------------------------------- |
| `api` (standart) | Faqat HTTP. UTel webhook qo'ng'iroqni bazaga `queued` bilan yozadi, tahlil qilmaydi.                           |
| `worker`         | UTel navbati (audio + ffmpeg + STT + Gemini), watchdog/recover, operator tavsiyalari, CRM cron, realtime. HTTP'da faqat `/health`. |
| `all`            | Ikkalasi bitta process'da (eski rejim) — lokal ishlab chiqish yoki o'tish davri uchun.                        |

Nega: ffmpeg va parallel audio yuklab olish CPU'ni egallaganda API javoblari
sekinlashardi. Endi og'ir ish alohida servisda.

Lokal: `ROLE=all npm run dev` — hammasi bitta process'da. Ikkalasini alohida
ishga tushirsangiz `PORT` har xil bo'lsin (port band bo'lsa server uni
egallagan jarayonni o'chiradi).

### Railway'da worker servisini ochish

1. **Avval** `supabase/perf_*.sql` fayllari ishga tushirilgan bo'lsin
   (aks holda hisobot endpointlari 500 qaytaradi va qaysi faylni ishga
   tushirish kerakligini aytadi).
2. Mavjud (API) servisda `ROLE` o'zgaruvchisini qo'ymang yoki `ROLE=api`
   qiling va yangi kodni deploy qiling. Shu paytdan yangi qo'ng'iroqlar
   `queued` bo'lib saqlanadi — **yo'qolmaydi**, worker ochilguncha kutadi.
3. Railway → loyiha → **New → GitHub Repo** → shu repozitoriya, branch `main`.
4. Yangi servis → **Variables → Raw Editor**: API servisining barcha
   o'zgaruvchilarini nusxalang (Supabase, `SALES_AI_API_KEY`,
   `GEMINI_API_KEY`, `OPENAI_API_KEY`, `UTEL_QUEUE_SINCE`, `UTEL_BATCH`,
   `WORK_START_HOUR`/`WORK_END_HOUR`, Telegram/`ADMIN_*`, PBX/CRM ...) va
   qo'shing: `ROLE=worker`.
5. **Settings**: Build/Start buyruqlari API bilan bir xil (`npm run build`,
   `npm start`). **Replicas = 1** (navbat holati process xotirasida — ikki
   worker bir audioni ikki marta tahlil qiladi). Ommaviy domen kerak emas.
   Healthcheck yoqilsa yo'li: `/health`.
6. Deploy logida `⚡ server is running ... (ROLE=worker)` va
   `UTel navbat ishchisi ishga tushdi` chiqishini tekshiring. API logida esa
   `ROLE=api — fon ishlari ... ISHGA TUSHMAYDI` bo'ladi.

2-qadam bilan 6-qadam orasida tahlil faqat kechikadi. Ikki servisni bir
vaqtda `ROLE=all`/`worker` bilan qoldirmang — ikkita navbat ishchisi bo'lib qoladi.

## Deploy tartibi

**Production FAQAT `main` branch'idan, GitHub orqali deploy qilinadi.**
`railway up` — faqat favqulodda holatda.

Nega bu qoida (2026-09-27 da aniqlangan muammo): uzoq vaqt `railway up`
bilan deploy qilindi. U ishchi papkani to'g'ridan-to'g'ri yuklaydi va
git'ni umuman bilmaydi. Natijada `main` 29 commit orqada qoldi, lekin
production yangi kodda ishlab turdi. Railway o'zgaruvchi o'zgarganda
GitHub manbasidan (`main`) qayta deploy qilmoqchi bo'ldi — ya'ni bir
tugma bosilsa production 4 kunlik ishni yo'qotib, eski kodga qaytardi.

Tartib:

```bash
git checkout main
git merge --ff-only <branch>
npm run build          # deploy'dan OLDIN mahalliy tekshiruv
git push origin main   # Railway shundan deploy qiladi
```

`railway up` ishlatishga majbur bo'lsangiz: **keyin darhol** o'sha kodni
`main` ga merge qilib push qiling, aks holda yuqoridagi tuzoq qaytadi.

### Deploy loglarsiz yiqilsa

Agar deploy `FAILED` bo'lsa-yu, build logi ham, deploy logi ham bo'sh
bo'lsa (`Deployment does not have an associated build`), bu kod xatosi
emas — Railway manbani umuman ololmagan. Tekshirish tartibi:

1. `railway deployment list --json` — yiqilgan deploy'ning `meta.branch`
   va `meta.commitHash` maydonlari. Kutilgan commit'mi?
2. `git ls-remote --heads origin` — o'sha commit GitHub'da bormi?
3. Railway → Settings → Source: repozitoriya va branch to'g'rimi
   (`main` bo'lishi kerak).
4. GitHub → Settings → Applications → Railway: repozitoriyaga ruxsat
   bormi. Ruxsat yo'qolgan bo'lsa Railway'da Disconnect → Connect.
5. Shundan keyin ham yiqilsa — vaqtincha `railway up`, keyin 1-banddagi
   qoidaga ko'ra `main` ga push.

> Tarix: 2026-09-27 da Railway'ning GitHub ulanishi eskirib qolgan edi —
> push deploy'ni qo'zg'atardi, lekin Railway hamon eski commit'ni
> (`ede2354`) olib, loglarsiz yiqilardi. Yuqoridagi 4-qadam (Disconnect →
> Connect) tuzatdi.

## Ma'lum xatarlar

- **STT bo'sh matn qaytarishi.** sales-ai-front xato yuz berganda HTTP
  xato emas, bo'sh transkript qaytarishi mumkin. Bo'sh matn esa
  "Javobsiz" deb yoziladi va `status='done'` bo'lgani uchun navbat uni
  boshqa olmaydi. 2026-09-24 19:01 dan 27-sentabrgacha shu sababdan
  2949 qo'ng'iroq tahlilsiz qoldi va 3 kun sezilmadi.
  Qisman himoya: 60 soniyadan uzun audiodan bo'sh matn kelsa xato
  tashlanadi. Qisqa qo'ng'iroqda bo'sh matnni haqiqiy javobsizdan
  ajratib bo'lmaydi — buni faqat global kuzatuv tutadi.
