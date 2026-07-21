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
(Supabase va Groq kalitlari).

Minimal kerakli o'zgaruvchilar:

- `SUPABASE_URL` (yoki `NEXT_PUBLIC_SUPABASE_URL`)
- `SUPABASE_SERVICE_ROLE_KEY`
- `GROQ_API_KEY`

Audio chunking uchun `ffmpeg` serverda o'rnatilgan bo'lishi shart (Railway image yoki Docker'da mavjudligini tekshiring).
