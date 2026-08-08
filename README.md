# 🎬 Kino Bot

TypeScript + Node.js + **grammY** + **Prisma** (PostgreSQL) asosida qurilgan professional Telegram kino boti.

Foydalanuvchi **kod** yoki **nom** yozsa — kino tushadi. Aqlli qidiruv (kirill/lotin), tavsiya tizimi, kvota/monetizatsiya, serial davom-etish tizimi va AI yordamchi o'rnatilgan. Adminlar reply-keyboard panel orqali kino/serial qo'shadi, kanallarni boshqaradi, broadcast yuboradi va backup oladi.

## ✨ Imkoniyatlar

- 🔎 **Aqlli qidiruv:** kod, nom — lotin va kirill aralash yozilsa ham topiladi (`Бойчечак` / `boychechak` / `Boychechak`). 3 bosqichli fallback: `titleNorm` → aniq qisman moslik → pg_trgm similarity.
- 🎯 **Tavsiya tizimi:** kino yetkazilgach "Sizga yoqishi mumkin" tugmasi, `/recommend` va `/random` — ko'rishlar tarixidan janr affiniteti hisoblanadi; sovuq foydalanuvchilarga mashhur kinolar.
- 🎬 **Kino qo'shish:** video yuboriladi → bot `file_id` ni eslab qoladi va **maxfiy baza kanalga** avtomatik tashlaydi (qisqa promo video kino kanalga 3 urinishli retry bilan).
- 📺 **Serial:** Serial → Sezon → Qism tuzilishi, **"▶️ Davom etish"** progress tugmasi, qulay navigatsiya.
- 🤖 **AI yordamchi:** `/ai` — kino qidiruv, tavsiya va suhbat. 6 ta provayder (Gemini, Groq, OpenRouter, Cerebras, GitHub Models, Mistral), kaliti borlaridan matn + rasm orqali kino tanib olish.
- 💰 **Kvota va premium:** umrlik + kunlik bepul limit, premium obuna (to'lov + Stars), barcha yetkazish yo'llari bitta gate'dan o'tadi (bypass yo'q).
- 📢 **Kanal boshqaruvi:** Ommaviy / Maxfiy / So'rovli (apply-to-join) kanallar, avtomatik admin qo'shilish, majburiy obuna.
- 📊 **Statistika:** Toshkent vaqti (UTC+5) bo'yicha kunlik hisobotlar, 60 soniyalik cache.
- 📣 **Broadcast:** crash-safe — ish boshlanishida DB job qatori yoziladi, restartdan keyin `interrupted` status + retry tugmasi.
- 💾 **Backup:** butun baza JSON (gzip) sifatida yuklab olish / tiklash, avto-backup har 3 kunda.
- 🛡 **Xavfsizlik:** bo'lim bo'yicha admin ruxsatlari, yagona-instansiya DB lock (409 himoyasi), majburiy webhook secret.

## 🧱 Texnologiyalar

- **grammY 1.30** + `@grammyjs/runner` (polling) + `@grammyjs/conversations`
- **Prisma 5** + PostgreSQL (`pg_trgm` kengaytmasi bilan GIN indekslar)
- **TypeScript** (strict), `tsx` development uchun
- **Vitest** (unit testlar), **ESLint 8** + **Prettier 3**, **GitHub Actions CI**

## 🚀 O'rnatish

### 1. Talablar

- Node.js 18+
- PostgreSQL 13+ (`pg_trgm` kengaytmasi migration'da avtomatik yaratiladi)

### 2. Sozlash

```bash
npm install
cp .env.example .env   # va .env ni to'ldiring
```

### 3. Baza

```bash
npx prisma migrate deploy --skip-generate   # ishlab chiqarish
# yoki development:
npx prisma migrate dev
```

### 4. Ishga tushirish

```bash
npm run dev     # development (tsx watch, polling)
# yoki
npm run build && npm start
```

## 🌍 Muhit o'zgaruvchilari

`.env.example` da to'liq ro'yxat — barcha o'zgaruvchilar:

| O'zgaruvchi           | Majburiy | Tavsif                                                              |
| --------------------- | -------- | ------------------------------------------------------------------- |
| `BOT_TOKEN`           | ✅       | @BotFather dan olingan token                                        |
| `ADMIN_IDS`           | ✅       | **Owner** Telegram ID'lar (vergul bilan) — ular to'liq huquqli       |
| `DATABASE_URL`        | ✅       | PostgreSQL ulanish satri                                             |
| `BASE_CHANNEL_ID`     | ⚠️       | Kinolar saqlanadigan **maxfiy** kanal ID (`-100...`). Bot u yerda admin bo'lsin. Kino qo'shish uchun zarur |
| `MOVIE_CHANNEL_ID`    | —        | Qisqa promo/trailer postlar tashlanadigan kanal ID (ixtiyoriy)       |
| `PAYMENT_CHANNEL_ID`  | —        | To'lov cheklari (screenshot) audit kanali (ixtiyoriy)                |
| `USE_PREMIUM_EMOJI`   | —        | `true`/`false` — premium emoji'larni yoqish/o'chirish (default `true`) |
| `ADMIN_CONTACT_URL`   | —        | "Admin bilan bog'lanish" tugmasi havolasi                            |
| `GEMINI_API_KEY`      | —        | AI provayder kalitlari — qaysi biri bo'lsa o'sha ishlaydi            |
| `GROQ_API_KEY`        | —        | AI provayder (matn uchun tez/arzon)                                  |
| `OPENROUTER_API_KEY`  | —        | AI provayder (ko'plab modellar, rasm ham)                            |
| `CEREBRAS_API_KEY`    | —        | AI provayder (juda tez)                                              |
| `GITHUB_MODELS_TOKEN` | —        | AI provayder (GPT-4.1 mini — vision uchun birinchi navbat)           |
| `MISTRAL_API_KEY`     | —        | AI provayder                                                         |
| `USE_WEBHOOK`         | —        | `true` bo'lsa webhook rejim (standart: **polling**)                  |
| `WEBHOOK_URL`         | —        | Webhook rejimida endpoint URL                                        |
| `WEBHOOK_SECRET`      | ⚠️       | Webhook rejimida **majburiy** — bashorat qilib bo'lmaydigan qiymat bering |
| `PORT`                | —        | Webhook server porti (default `8080`)                                |
| `DISABLE_KEEPALIVE`   | —        | `true` bo'lsa keep-alive ping yuborilmaydi                           |

> ⚠️ `BASE_CHANNEL_ID` jadvalda "ixtiyoriy" ko'rinadi, lekin botning asosiy vazifasi (kino yetkazish) uchun **kerak**. Foydalanuvchi botda bo'lgani uchun uning kino `file_id`larini baza kanaldagi postlar ta'minlaydi.

## ☁️ Railway'ga deploy

Railway (yoki boshqa PaaS) da yagona instansiya sifatida:

1. Repo'ni `git push` qiling → Railway `start.sh` ni ishga tushiradi:
   ```sh
   npx prisma migrate resolve --applied 20260807000000_init   # eski bazalar uchun baseline
   npx prisma migrate deploy --skip-generate                  # qolgan migration'lar
   exec node dist/index.js                                    # bot (polling)
   ```
2. `.env` o'zgaruvchilarini **faqat Railway dashboard** da o'rnating (`BOT_TOKEN`, `ADMIN_IDS`, `DATABASE_URL`, kanal ID'lari, AI kalitlar...). Lokal `.env` Railway'ga avtomatik bormaydi.
3. **Yagona instansiya** — bot polling ishlatadi. Startup'da DB advisory-lock olinadi: ikkinchi instansiya ochilsa darhol `exit(1)` qiladi. Polling 409 xatosida ham jarayon tugaydi va Railway uni qayta ishga tushiradi.

### Lokal ishlab chiqish va Railway konflikti (409)

Lokal `npm run dev` **Railway'dagi bot bilan parallel** ishlasa, Telegram polling 409 beradi va bot ishlamaydi. Shuning uchun:

- Lokal tekshiruv uchun **faqat** `npx tsc --noEmit` + `npm test` + `npm run lint` ishlating (interaktiv bot oqimlarini sinash shart bo'lmasa).
- Botni lokalda jonli ishga tushirmoqchi bo'lsangiz — avval Railway'da service'ni **Stop** qiling.

## 👑 Admin panel

`/admin` yoki `/start` → reply-keyboard panel. Bo'limlar va ularning ruxsat kalitlari:

| Bo'lim                | Section | Ruxsat kaliti   |
| --------------------- | ------- | --------------- |
| Statistika            | 📊      | `stats`         |
| Kanal boshqaruvi      | 📢      | `channels`      |
| Qo'shilish statistikasi | 📥    | `channels`      |
| Kino boshqaruvi       | 🎬      | `movies`        |
| Serial boshqaruvi     | 📺      | `serials`       |
| Xabar yuborish        | 📣      | `broadcast`     |
| Referal               | 🔗      | `referrals`     |
| Funnel                | 🪜      | `funnel`        |
| Backup                | 💾      | `backup`        |
| Premium (admin)       | ⭐      | `premium`       |
| AI sozlamalari        | 🤖      | `ai`            |
| Admin boshqaruvi      | 👥      | **faqat owner** |
| Bot sozlamalari       | ⚙️      | ichidagi bo'lim bo'yicha |

**Ruxsat qoidalari:**
- **Owner** (`ADMIN_IDS`) — har doim barcha bo'limlar.
- Qo'shimcha admin `permissions` si `null` bo'lsa — barcha bo'limlar (cheksiz).
- Cheklangan admin — faqat ruxsat berilgan bo'limlar; noma'lum/yangi admin hech narsaga kira olmaydi.
- Har bir callback ham o'z bo'limi composer'i ortida tekshiriladi — `backup:restore`, `bc:send`, `prm:approve` kabi **barcha** amallar ruxsatdan o'tadi.

### Kino qo'shish tartibi

1. `🎬 Kino boshqaruvi` → `➕ Kino qo'shish`
2. Videoni yuboring → kod → nom → qo'shimcha → tayyor.

### Serial qo'shish tartibi

1. `📺 Serial boshqaruvi` → `➕ Serial qo'shish` (kod, nom)
2. So'ng `🎞 Qism qo'shish` → serial kodi → sezon → qism → video.

## 💰 Kvota va monetizatsiya sozlamalari

`Bot sozlamalari → ⭐ Premium` bo'limida (yoki DB `Setting` jadvali orqali):

| Kalit                   | Tavsif                                                       |
| ----------------------- | ------------------------------------------------------------ |
| `premium_enabled`       | Premium/limit tizimi yoq/o'chir. O'chiq bo'lsa hamma cheksiz |
| `free_request_limit`    | Umrlik bepul kino so'rovlari soni (`0` = cheksiz)            |
| `free_days`             | Bepul kunlar oynasi (`0` = cheksiz)                          |
| `free_daily_limit`      | **Kunlik** bepul kino so'rovlari (`0` = o'chirilgan; **Toshkent kuni** — UTC+5) |
| `free_ai_limit`         | Bepul kunlik AI so'rovlari (`0` = cheksiz)                   |

**Qanday ishlaydi:** barcha yetkazish yo'llari (kod, nom qidiruv, `movie:`/`serial:` callback, serial episod, AI `[SEND:]`, inline, `sub:check` qayta yetkazish) **bitta** `delivery.ts` gate'idan o'tadi. Gate `sub → quota → premium` tartibida tekshiradi, faqat muvaffaqiyatli yetkazilganda hisoblaydi va `views` ni oshiradi. Serial **episod = bitta so'rov**. Premium foydalanuvchi kvota qatlamini umuman ko'rmaydi.

Tariflar (`1 oy / 3 oy / 6 oy / 1 yil`) `prisma.tariff` jadvalida — premium bo'limidan boshqariladi (karta + Stars).

## 🧪 Testlar va CI

```bash
npm test            # Vitest — 5 ta fayl, 38+ test (DB-mock unit testlar)
npm run lint        # ESLint (TypeScript)
npm run lint:fix    # avto-tuzatish
npm run format      # Prettier
npm run format:check
```

CI (`.github/workflows/ci.yml`) har push'da: `prisma validate` → `tsc --noEmit` → `lint` → `test`.

## 📁 Struktura

```
src/
├── index.ts                # kirish nuqtasi, advisory-lock, broadcast reconcile
├── config.ts               # .env + admin ruxsatlari (adminCan)
├── bot.ts                  # bot + session + conversations
├── services/
│   ├── delivery.ts         # YAGONA yetkazish yo'li (gate + send + views + recordWatch)
│   ├── search.ts           # 3 bosqichli aqlli qidiruv
│   ├── recommend.ts        # janr affiniteti + weighted random
│   ├── serialProgress.ts   # SerialWatch progress ("Davom etish")
│   ├── broadcastJob.ts     # crash-safe broadcast job qatorlari
│   ├── bulkSend.ts         # throttled ommaviy yuborish
│   ├── statsCache.ts       # 60s statistika cache
│   └── movieChannel.ts     # kino kanal posti (retry/backoff)
├── utils/
│   ├── translit.ts         # kirill↔lotin normalizeTitle
│   ├── access.ts           # sub + kvota + premium gate
│   ├── settings.ts         # DB settings (TTL cache)
│   ├── sessionStorage.ts   # LRU sessiya cache
│   ├── subscription.ts     # membership cache
│   └── logger.ts           # log + owner xabari
└── handlers/
    ├── start.ts            # /start, sub:check
    ├── search.ts           # kod/nom qidiruv
    ├── serialView.ts       # serial navigatsiya + davom etish
    ├── inline.ts           # inline qidiruv
    ├── recommend.ts        # /recommend, /random, rec:*
    ├── aiUser.ts           # foydalanuvchi AI
    └── admin/              # bo'lim bo'yicha ruxsatlangan panel
```

## 📌 Ma'lum qoldiq itemlar

- **Inline hisoblash:** inline qidiruv natijasida kino ochilganda kvota hisobi `inline_query` dagi `isFreeQuotaExhausted` tekshiruviga tayanadi — `chosen_inline_result` best-effort. To'liq qat'iy hisob uchun BotFather'da `/setinlinefeedback` yoqilishi kerak (chosen_inline_result update'larini yuboradi).
- **Broadcast to'liq-resume:** broadcast restartdan keyin `interrupted` status oladi va owner retry tugmasi bilan davom ettira oladi, lekin to'xtagan joyidan **per-recipient cursor** bilan avtomatik davom etish kelajak iteratsiyaga qoldirildi (yagona instansiya uchun qabul qilingan — ortiqcha xavf yo'q).
