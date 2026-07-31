# SalesPulse Telegram Sales Bot

SalesPulse (AI call-audit platformasi) uchun Telegram sotuv/qo'llab-quvvatlash boti. Node.js + [Telegraf](https://telegraf.js.org/) bilan yozilgan (Python emas).

Bot: platforma haqida ma'lumot beradi, tariflarni ko'rsatadi, xodimlar soni asosida shaxsiy narx hisoblaydi, mijoz ma'lumotlarini yig'adi va Supabase'ga saqlaydi hamda adminga yuboradi. Erkin savollarga Claude API orqali (bilim bazasiga asoslanib) javob beradi.

## O'rnatish

```bash
cd telegram-bot
npm install
cp .env.example .env
# .env faylini to'ldiring (pastga qarang)
```

## Muhit o'zgaruvchilari

| O'zgaruvchi | Tavsif |
|---|---|
| `TOKEN_BOT` | BotFather'dan olingan bot tokeni |
| `ADMIN_CHAT_ID` | Adminning **raqamli** Telegram chat_id'si (pastga qarang — `@username` emas) |
| `ANTHROPIC_API_KEY` | Erkin savollarga javob berish uchun Claude API kaliti |
| `SUPABASE_URL` | Supabase loyiha URL'i |
| `SUPABASE_KEY` | Supabase service role kaliti (faqat serverda, hech qachon oshkor qilinmasin) |

### Admin chat_id qanday olinadi (muhim!)

Telegram bot API'da bevosita `@username`ga xabar yuborib bo'lmaydi — faqat **raqamli chat_id** ga, va faqat botga avval kamida bitta xabar yuborgan (yoki botni a'zo qilib qo'shgan) foydalanuvchi/guruhga. Ikki yo'l bor:

1. **Bitta admin orqali**: admin (masalan `@sizning_admin`) botga bir marta `/start` yuborsin. Konsolda (yoki botga vaqtinchalik log qo'shib) uning raqamli `chat_id`sini ko'ring va `ADMIN_CHAT_ID` ga shuni yozing.
2. **Tavsiya etiladi — guruh orqali**: botni xususiy Telegram guruhiga admin sifatida qo'shing va yangi lidlarni bitta odamga emas, shu guruhga yuboring. Bu birorta odamning bot bilan yozishmasiga bog'liq bo'lmaydi va jamoaviy ishlash uchun qulayroq. Guruh `chat_id`si odatda manfiy son bo'ladi (masalan `-1001234567890`) — buni ham xuddi shu `ADMIN_CHAT_ID` o'zgaruvchisiga yozish kifoya.

## Ishga tushirish

```bash
npm start
```

Bot **polling** rejimida ishlaydi (`bot.launch()`) — bu lokal/oddiy deploy uchun qulay. Productionda ko'p trafik yoki serverless muhit bo'lsa, Telegraf'ning webhook rejimiga (`bot.launch({ webhook: {...} })`) o'tish tavsiya etiladi.

## Supabase sozlash

`leads.sql` faylini Supabase loyihangizning **SQL Editor**'ida bir marta ishga tushiring — bu `leads` (yakunlangan lidlar) va `bot_events` (ixtiyoriy analitika jurnali) jadvallarini yaratadi. Bot ishga tushganda jadvallarni o'zi yaratmaydi — bu qasddan shunday (schema o'zgarishlari nazorat ostida bo'lishi uchun).

## Sessiya haqida eslatma

Xotiradagi (in-memory) sessiya (`session.js`) — bitta jarayon/instance uchun yetarli. Agar botni bir nechta serverda parallel (masalan Railway'da bir nechta replica) ishga tushirsangiz, foydalanuvchi turli instance'larga tushib qolganda sessiya holati yo'qolishi mumkin — bunday holatda Redis-backed sessiyaga (masalan `@telegraf/session` + `ioredis`) o'tish kerak.

## Loyiha tuzilishi

```
telegram-bot/
  bot.js            # kirish nuqtasi — bot, middleware, handlerlarni ulash
  session.js        # oddiy xotiradagi sessiya (FSM holati)
  pricing.js        # tariflar, chegirmalar, narx hisob-kitobi (bitta manba)
  db.js             # Supabase client, lead/hodisa yozish
  aiAssistant.js     # Claude API orqali erkin savollarga javob
  keyboards.js      # Telegram klaviaturalar (reply + inline)
  handlers/
    menu.js         # /start, platforma ma'lumoti, tariflarni ko'rish, admin, bekor qilish
    purchase.js     # to'liq sotib olish oqimi (tarif -> xodimlar -> muddat -> kontakt -> yakun)
    faq.js          # erkin savollarni AI yordamchiga yo'naltirish
  leads.sql         # Supabase jadval sxemasi
```
