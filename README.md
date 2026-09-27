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
  server.ts        # Express ilova + barcha route'larni ulash
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

## Ma'lum xatarlar

- **STT bo'sh matn qaytarishi.** sales-ai-front xato yuz berganda HTTP
  xato emas, bo'sh transkript qaytarishi mumkin. Bo'sh matn esa
  "Javobsiz" deb yoziladi va `status='done'` bo'lgani uchun navbat uni
  boshqa olmaydi. 2026-09-24 19:01 dan 27-sentabrgacha shu sababdan
  2949 qo'ng'iroq tahlilsiz qoldi va 3 kun sezilmadi.
  Qisman himoya: 60 soniyadan uzun audiodan bo'sh matn kelsa xato
  tashlanadi. Qisqa qo'ng'iroqda bo'sh matnni haqiqiy javobsizdan
  ajratib bo'lmaydi — buni faqat global kuzatuv tutadi.
