import { createServer } from "node:http";
import { run } from "@grammyjs/runner";
import { webhookCallback } from "grammy";
import { bot } from "./bot.js";
import { prisma } from "./prisma.js";
import { config, isAdmin, syncAdminStateFromDb } from "./config.js";
import { trackUser } from "./middlewares/user.js";
import { formatError, log } from "./utils/logger.js";
import { reconcileBroadcastJobs } from "./services/broadcastJob.js";

import { adminHandler } from "./handlers/admin/index.js";
import { startHandler } from "./handlers/start.js";
import { serialViewHandler } from "./handlers/serialView.js";
import { searchHandler } from "./handlers/search.js";
import { recommendHandler } from "./handlers/recommend.js";
import { inlineHandler } from "./handlers/inline.js";
import { referralHandler } from "./handlers/referral.js";
import { aiUserHandler } from "./handlers/aiUser.js";
import { premiumHandler } from "./handlers/premiumUser.js";
import { startAutoBackup } from "./services/autoBackup.js";
import { startPremiumExpiryWatcher } from "./services/premiumExpiry.js";
import { initAiUsageTracking } from "./services/aiUsage.js";
import { continueSurveyChain } from "./handlers/admin/funnel.js";
import { nearestRegion } from "./utils/regions.js";
import { getBool, KEYS } from "./utils/settings.js";
import { e } from "./utils/emoji.js";

// ===== Kutilmagan xatolarni ushlab, jarayonni yiqilishdan saqlash =====
// Ba'zi xatolar (masalan webhook rejimida) grammY'ning bot.catch() zanjirini
// chetlab o'tib to'g'ridan-to'g'ri unhandledRejection sifatida chiqishi mumkin —
// bunday holatda process.exit bo'lmasin, faqat loglansin (bot.catch() asosiy
// himoya, bu esa oxirgi xavfsizlik chizig'i).
process.on("unhandledRejection", (reason) => {
  console.error("🛑 Unhandled rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("🛑 Uncaught exception:", err);
  // 409 Conflict = ikkinchi polling instansiya bir xil token bilan ishlamoqda.
  // Bu holatda bot to'xtab qoladi (getUpdates ishlamaydi) — toza chiqib,
  // Railway qayta ishga tushirsin (advisory lock buni odatda oldini oladi).
  if (formatError(err).includes("409") && formatError(err).toLowerCase().includes("conflict")) {
    process.exit(1);
  }
});

// ===== Middleware: foydalanuvchini bazaga yozish =====
bot.use(trackUser);

// ===== "So'rovli" kanallar uchun join so'rovini kuzatish va tasdiqlash =====
bot.on("chat_join_request", async (ctx) => {
  const chatId = ctx.chatJoinRequest.chat.id;
  const userId = ctx.chatJoinRequest.from.id;

  // DB'da kanal mavjudligini tekshirish
  const known = await prisma.channel.findUnique({ where: { chatId: BigInt(chatId) } });
  if (!known) return;

  // So'rovni bazaga yozish (yoki mavjud bo'lsa yangilash)
  await prisma.joinRequest
    .upsert({
      where: { channelId_userId: { channelId: BigInt(chatId), userId: BigInt(userId) } },
      create: {
        channelId: BigInt(chatId),
        userId: BigInt(userId),
        firstName: ctx.chatJoinRequest.from.first_name ?? null,
        username: ctx.chatJoinRequest.from.username ?? null,
        status: "pending",
      },
      update: { status: "pending", date: new Date() },
    })
    .catch(() => null);

  // Avtomatik tasdiqlash YO'Q — admin joinStats orqali qabul qiladi
});

// ===== Foydalanuvchi kanaldan chiqsa — so'rov yozuvini o'chirish =====
// (Keyingi kirish uchun qaytadan so'rov yubora olsin)
bot.on("chat_member", async (ctx) => {
  const update = ctx.chatMember;
  if (!update) return;
  const newStatus = update.new_chat_member.status;
  const oldStatus = update.old_chat_member.status;
  const userId = update.new_chat_member.user.id;
  const chatId = update.chat.id;

  // Faqat bizning kanallar uchun kuzatamiz
  const ch = await prisma.channel.findUnique({ where: { chatId: BigInt(chatId) } });
  if (!ch) return;

  const leftStatuses = ["left", "kicked"];
  const wasIn = !leftStatuses.includes(oldStatus);
  const nowIn = !leftStatuses.includes(newStatus);
  const nowOut = leftStatuses.includes(newStatus);

  // Qo'shildi (statistika)
  if (!wasIn && nowIn) {
    await prisma.channelEvent
      .create({
        data: { channelId: BigInt(chatId), userId: BigInt(userId), type: "join" },
      })
      .catch(() => null);
    return;
  }

  // Chiqib ketdi
  if (wasIn && nowOut) {
    await prisma.channelEvent
      .create({
        data: { channelId: BigInt(chatId), userId: BigInt(userId), type: "leave" },
      })
      .catch(() => null);
    // REQUEST kanalda so'rov yozuvini o'chiramiz (qayta so'rov yubora olsin)
    if (ch.type === "REQUEST") {
      await prisma.joinRequest
        .deleteMany({
          where: { channelId: BigInt(chatId), userId: BigInt(userId) },
        })
        .catch(() => null);
    }
  }
});

// Manba kanallardan avto-indekslash o'chirilgan (admin so'roviga ko'ra) —
// bot.on("channel_post:video", ...) olib tashlandi. sourceChannel jadvali va
// SourceChannel yozuvlari bazada saqlanib qoladi, kerak bo'lsa qayta yoqiladi.

// ===== Handler'lar (tartib muhim!) =====
bot.use(adminHandler); // admin panel (faqat adminlar)
bot.use(startHandler); // /start, obuna tekshiruvi, deep-link
bot.use(referralHandler); // referal (foydalanuvchi)
bot.use(aiUserHandler); // AI yordamchi (foydalanuvchi)
bot.use(premiumHandler); // premium (foydalanuvchi: /premium, sotib olish)
bot.use(serialViewHandler); // serial sezon/qism navigatsiya callbacklari
bot.use(inlineHandler); // inline qidiruv
bot.use(searchHandler); // matnli qidiruv (kod/nom) — oxirida
bot.use(recommendHandler); // tavsiyalar (rec:* callback + /recommend)

// ===== Xatolarni ushlash =====
bot.catch((err) => {
  const ctx = err.ctx;
  log("error", "Bot xatosi", {
    error: formatError(err.error),
    userId: ctx?.from?.id?.toString(),
    chatId: ctx?.chat?.id?.toString(),
    updateType: Object.keys(ctx?.update ?? {})[0] ?? "unknown",
  });
  // Foydalanuvchi jimgina muvaffaqiyatsizlikka uchramasligi uchun qisqa xabar.
  // Callback xatolarida reply ishlamasa ham zararsiz (catch qilinadi).
  ctx?.reply("⚠️ Noma'lum xatolik yuz berdi. Iltimos, qaytadan urinib ko'ring.").catch(() => {});
});

// ===== Ishga tushirish =====
/** Yagona instansiya himoyasi: DB advisory lock. Ikkinchi polling instansiya
 *  ~30 soniya davomida urinadi, ololmasa chiqib ketadi. Lock pool'dagi bitta
 *  ulanishga birikadi va jarayon ishlaguncha saqlanadi. */
async function acquireAdvisoryLock(): Promise<boolean> {
  for (let i = 0; i < 10; i++) {
    try {
      const rows = await prisma.$queryRaw<{ locked: boolean }[]>`
        SELECT pg_try_advisory_lock(hashtext('kinobot')) AS locked`;
      if (rows[0]?.locked) return true;
    } catch (e) {
      console.error("⚠️ Advisory lock tekshiruvida xato:", formatError(e));
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
}

async function main() {
  await prisma.$connect();
  console.log("✅ DB ulandi");

  // Yagona instansiya — ikkala polling instansiya 409 conflict bermasligi uchun
  if (!(await acquireAdvisoryLock())) {
    console.error("🛑 Boshqa instansiya allaqachon ishlamoqda (advisory lock). Chiqib ketilmoqda.");
    process.exit(1);
  }

  // To'xtab qolgan broadcast'larni tiklash (running → interrupted + owner xabar)
  await reconcileBroadcastJobs(bot).catch((e) => {
    console.error("⚠️ Broadcast reconcileda xato:", formatError(e));
  });

  // In-memory admin holatini DB'dan yuklash (owner + isAdmin userlar)
  await syncAdminStateFromDb();

  // Avtomatik backup rejalashtiruvchi
  startAutoBackup(bot);

  // Premium tugashi haqida ogohlantirish (3 kun / 1 kun / tugadi)
  startPremiumExpiryWatcher(bot);

  // AI sarf-hisobini DB'ga ulash
  initAiUsageTracking();

  await bot.api.setMyCommands([
    { command: "start", description: "Botni ishga tushirish" },
    { command: "ai", description: "AI yordamchi" },
    { command: "premium", description: "Premium obuna" },
    { command: "referal", description: "Referal / pul ishlash" },
    { command: "mashhur", description: "Eng ko'p ko'rilgan kinolar" },
    { command: "random", description: "Tasodifiy kino" },
  ]);

  // Eski owner uchun ro'yxatga olingan /admin komandasini o'chirish
  for (const id of config.ownerIds) {
    await bot.api
      .deleteMyCommands({ scope: { type: "chat", chat_id: Number(id) } })
      .catch(() => {});
  }

  // Bot nomini o'rnatish
  await bot.api.setMyName("🎬 Kino vaqti bot").catch(() => {});
  await bot.api
    .setMyDescription("🎬 Kino va seriallarni kod orqali toping. Inline rejimda ham ishlaydi.")
    .catch(() => {});

  const me = await bot.api.getMe();

  // Ikkala rejim uchun bir xil — chat_member va channel_post ham keladi
  const ALLOWED_UPDATES = [
    "message",
    "callback_query",
    "inline_query",
    "chosen_inline_result",
    "chat_join_request",
    "chat_member",
    "channel_post",
    "pre_checkout_query",
  ] as const;

  // ===== WEBHOOK rejimi (Cloud Run / server) =====
  const webhookUrl = process.env.WEBHOOK_URL;
  const useWebhook = process.env.USE_WEBHOOK === "true" || !!webhookUrl;

  if (useWebhook) {
    const port = Number(process.env.PORT ?? 8080);
    // config.ts WEBHOOK_SECRET bo'lmasa fail-fast tashlaydi — default yo'q
    const secret = process.env.WEBHOOK_SECRET!;

    if (!webhookUrl) throw new Error("WEBHOOK_URL .env da ko'rsatilmagan!");

    await bot.api.setWebhook(webhookUrl, {
      secret_token: secret,
      allowed_updates: [...ALLOWED_UPDATES],
    });

    const handle = webhookCallback(bot, "http", {
      secretToken: secret,
    });

    // GET so'rovlar (health-check / keep-alive ping) webhook handleriga tushmasin —
    // ular darhol 200 oladi. Faqat POST Telegram update sifatida qayta ishlanadi.
    createServer((req, res) => {
      if (req.method !== "POST") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
        return;
      }
      handle(req, res);
    }).listen(port, () => {
      console.log(`🌐 @${me.username} webhook rejimda: port ${port}`);
      console.log(`🔗 Webhook URL: ${webhookUrl}`);
    });

    // ===== KEEP-ALIVE =====
    // Render/Fly kabi bepul tariflar 15 daqiqa HTTP trafigi bo'lmasa xizmatni
    // uxlatib qo'yadi. Uxlagandan keyin "sovuq start" 30-60s oladi va Telegram
    // webhook'ni kutmay "Read timeout" beradi — xabarlar navbatda qolib ketadi.
    // Shuning uchun har 10 daqiqada o'zimizga GET yuborib, uyg'oq turamiz.
    if (process.env.DISABLE_KEEPALIVE !== "true") {
      const KEEPALIVE_MS = 10 * 60 * 1000;
      setInterval(() => {
        fetch(webhookUrl, { method: "GET" })
          .then((r) => {
            if (!r.ok) console.warn("⚠️ Keep-alive javobi:", r.status);
          })
          .catch((err) => console.warn("⚠️ Keep-alive xatosi:", (err as Error).message));
      }, KEEPALIVE_MS);
      console.log(`💓 Keep-alive yoqilgan (har ${KEEPALIVE_MS / 60000} daqiqada)`);
    }
  } else {
    // ===== POLLING rejimi (lokal / Railway) =====
    await bot.api.deleteWebhook();
    console.log(`🤖 @${me.username} polling rejimda ishga tushdi`);
    const runner = run(bot, { runner: { fetch: { allowed_updates: [...ALLOWED_UPDATES] } } });
    runner.task()?.catch((err) => {
      const msg = formatError(err);
      console.error("🛑 Runner to'xtadi:", msg);
      // 409 — ikkinchi instansiya. Toza chiqib, Railway qayta ishga tushirsin.
      if (msg.includes("409") && msg.toLowerCase().includes("conflict")) {
        process.exit(1);
      }
    });
  }
}

main().catch((e) => {
  console.error("Ishga tushirishda xato:", e);
  process.exit(1);
});

// ===== Foydalanuvchi so'rovnomaga javob berish =====
bot.callbackQuery(/^svr:ans:(\d+):(\d+)$/, async (ctx) => {
  const surveyId = Number(ctx.match[1]);
  const optionId = Number(ctx.match[2]);
  const userId = BigInt(ctx.from.id);

  const survey = await prisma.survey.findUnique({
    where: { id: surveyId },
    include: { options: { where: { id: optionId } } },
  });
  if (!survey || !survey.options.length) {
    await ctx.answerCallbackQuery({ text: "So'rovnoma topilmadi.", show_alert: true });
    return;
  }
  const option = survey.options[0];

  const existing = await prisma.surveyResponse.findUnique({
    where: { surveyId_userId: { surveyId, userId } },
  });
  if (existing) {
    await ctx.answerCallbackQuery({ text: "Siz allaqachon javob bergansiz!", show_alert: true });
    return;
  }

  // Admin javoblari — funnel'dagi "Sinov" tugmasi yoki tasodifiy test bo'lishi
  // mumkin. Ular HAQIQIY so'rovnoma statistikasiga kirmasligi va admin profilining
  // region/gender maydonini buzmasligi kerak (aks holda "Viloyat bo'yicha" broadcast
  // noto'g'ri bo'lardi). Zanjir test qilish uchun baribir davom etadi.
  const isAdminUser = isAdmin(ctx.from.id);
  if (!isAdminUser) {
    await prisma.surveyResponse.create({ data: { surveyId, optionId, userId } }).catch(() => null);

    if (survey.isRegionSurvey) {
      await prisma.user
        .update({ where: { id: userId }, data: { region: option.text } })
        .catch(() => null);
    }
    if (survey.isGenderSurvey) {
      await prisma.user
        .update({ where: { id: userId }, data: { gender: option.text } })
        .catch(() => null);
    }
  }

  await ctx.answerCallbackQuery({ text: `✅ Javobingiz qabul qilindi: ${option.text}` });
  await ctx
    .editMessageText(`${survey.question}\n\n✅ <b>Javobingiz:</b> ${option.text}`)
    .catch(() => {});

  await continueSurveyChain(ctx, userId, surveyId);
});

// ===== Viloyat so'rovnomasi uchun GPS orqali avtomatik manzil aniqlash =====
bot.on("message:location", async (ctx, next) => {
  if (!(await getBool(KEYS.geoDetectEnabled, false))) return next();

  const { latitude, longitude } = ctx.message.location;
  const region = nearestRegion(latitude, longitude);
  const userId = BigInt(ctx.from.id);

  // Admin sinov vaqtida GPS yuborsa regioni buzilmasin (svr:ans'dagi kabi qoida)
  if (!isAdmin(ctx.from.id)) {
    await prisma.user.update({ where: { id: userId }, data: { region } }).catch(() => null);
  }
  await ctx.reply(`📍 Manzilingiz aniqlandi: <b>${e.escapeHtml(region)}</b>`, {
    reply_markup: { remove_keyboard: true },
  });

  // Eng so'nggi faol viloyat so'rovnomasiga javobni yozib, zanjirni davom ettiramiz
  const survey = await prisma.survey.findFirst({
    where: { isRegionSurvey: true },
    orderBy: { createdAt: "desc" },
    include: { options: true },
  });
  if (!survey) return;

  const option = survey.options.find((o) => o.text === region);
  if (option && !isAdmin(ctx.from.id)) {
    await prisma.surveyResponse
      .upsert({
        where: { surveyId_userId: { surveyId: survey.id, userId } },
        create: { surveyId: survey.id, optionId: option.id, userId },
        update: { optionId: option.id },
      })
      .catch(() => null);
  }

  await continueSurveyChain(ctx, userId, survey.id);
});

// Graceful shutdown
const stop = async () => {
  await prisma.$disconnect();
  process.exit(0);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
