import { createServer } from "node:http";
import { run } from "@grammyjs/runner";
import { webhookCallback } from "grammy";
import { bot } from "./bot.js";
import { prisma } from "./prisma.js";
import { addAdminId, config, setAdminPerms, setAdminChannelLimit } from "./config.js";
import { parsePerms } from "./utils/permissions.js";
import { trackUser } from "./middlewares/user.js";

import { adminHandler } from "./handlers/admin/index.js";
import { startHandler } from "./handlers/start.js";
import { serialViewHandler } from "./handlers/serialView.js";
import { searchHandler } from "./handlers/search.js";
import { inlineHandler } from "./handlers/inline.js";
import { referralHandler } from "./handlers/referral.js";
import { aiUserHandler } from "./handlers/aiUser.js";
import { premiumHandler } from "./handlers/premiumUser.js";
import { startAutoBackup } from "./services/autoBackup.js";
import { startPremiumExpiryWatcher } from "./services/premiumExpiry.js";
import { initAiUsageTracking } from "./services/aiUsage.js";
import { indexVideoMovie } from "./services/ingest.js";
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
  await prisma.joinRequest.upsert({
    where: { channelId_userId: { channelId: BigInt(chatId), userId: BigInt(userId) } },
    create: {
      channelId: BigInt(chatId),
      userId:    BigInt(userId),
      firstName: ctx.chatJoinRequest.from.first_name ?? null,
      username:  ctx.chatJoinRequest.from.username ?? null,
      status:    "pending",
    },
    update: { status: "pending", date: new Date() },
  }).catch(() => null);

  // Avtomatik tasdiqlash YO'Q — admin joinStats orqali qabul qiladi
});

// ===== Foydalanuvchi kanaldan chiqsa — so'rov yozuvini o'chirish =====
// (Keyingi kirish uchun qaytadan so'rov yubora olsin)
bot.on("chat_member", async (ctx) => {
  const update = ctx.chatMember;
  if (!update) return;
  const newStatus = update.new_chat_member.status;
  const oldStatus = update.old_chat_member.status;
  const userId    = update.new_chat_member.user.id;
  const chatId    = update.chat.id;

  // Faqat bizning kanallar uchun kuzatamiz
  const ch = await prisma.channel.findUnique({ where: { chatId: BigInt(chatId) } });
  if (!ch) return;

  const leftStatuses = ["left", "kicked"];
  const wasIn  = !leftStatuses.includes(oldStatus);
  const nowIn  = !leftStatuses.includes(newStatus);
  const nowOut = leftStatuses.includes(newStatus);

  // Qo'shildi (statistika)
  if (!wasIn && nowIn) {
    await prisma.channelEvent.create({
      data: { channelId: BigInt(chatId), userId: BigInt(userId), type: "join" },
    }).catch(() => null);
    return;
  }

  // Chiqib ketdi
  if (wasIn && nowOut) {
    await prisma.channelEvent.create({
      data: { channelId: BigInt(chatId), userId: BigInt(userId), type: "leave" },
    }).catch(() => null);
    // REQUEST kanalda so'rov yozuvini o'chiramiz (qayta so'rov yubora olsin)
    if (ch.type === "REQUEST") {
      await prisma.joinRequest.deleteMany({
        where: { channelId: BigInt(chatId), userId: BigInt(userId) },
      }).catch(() => null);
    }
  }
});

// ===== Manba kanallardan avto-indekslash (channel_post) =====
bot.on("channel_post:video", async (ctx) => {
  const chatId = ctx.chat.id;
  const src = await prisma.sourceChannel.findUnique({ where: { chatId: BigInt(chatId) } });
  if (!src) return; // faqat ro'yxatdagi manba kanallar

  const v = ctx.msg.video;
  if (!v) return;
  const res = await indexVideoMovie({
    fileId: v.file_id,
    caption: ctx.msg.caption ?? null,
    duration: v.duration ?? null,
  });
  if (res.status === "created") {
    console.log(`📥 Manba kanaldan indekslandi: "${res.title}" (kod ${res.code}) — ${src.title}`);
  }
});

// ===== Handler'lar (tartib muhim!) =====
bot.use(adminHandler);      // admin panel (faqat adminlar)
bot.use(startHandler);      // /start, obuna tekshiruvi, deep-link
bot.use(referralHandler);   // referal (foydalanuvchi)
bot.use(aiUserHandler);     // AI yordamchi (foydalanuvchi)
bot.use(premiumHandler);    // premium (foydalanuvchi: /premium, sotib olish)
bot.use(serialViewHandler); // serial sezon/qism navigatsiya callbacklari
bot.use(inlineHandler);     // inline qidiruv
bot.use(searchHandler);     // matnli qidiruv (kod/nom) — oxirida

// ===== Xatolarni ushlash =====
bot.catch((err) => {
  console.error("🛑 Bot xatosi:", err.error);
});

// ===== Ishga tushirish =====
async function main() {
  await prisma.$connect();
  console.log("✅ DB ulandi");

  const dbAdmins = await prisma.user.findMany({
    where: { isAdmin: true },
    select: { id: true, permissions: true, channelLimit: true },
  });
  for (const admin of dbAdmins) {
    addAdminId(admin.id);
    setAdminPerms(admin.id, parsePerms(admin.permissions));
    setAdminChannelLimit(admin.id, admin.channelLimit ?? null);
  }

  // Avtomatik backup rejalashtiruvchi
  startAutoBackup(bot);

  // Premium tugashi haqida ogohlantirish (3 kun / 1 kun / tugadi)
  startPremiumExpiryWatcher(bot);

  // AI sarf-hisobini DB'ga ulash
  initAiUsageTracking();

  await bot.api.setMyCommands([
    { command: "start",   description: "Botni ishga tushirish" },
    { command: "ai",      description: "AI yordamchi" },
    { command: "referal", description: "Referal / pul ishlash" },
    { command: "mashhur", description: "Eng ko'p ko'rilgan kinolar" },
    { command: "random",  description: "Tasodifiy kino" },
  ]);

  // Eski owner uchun ro'yxatga olingan /admin komandasini o'chirish
  for (const id of config.ownerIds) {
    await bot.api
      .deleteMyCommands({ scope: { type: "chat", chat_id: Number(id) } })
      .catch(() => {});
  }

  // Bot nomini o'rnatish
  await bot.api.setMyName("🎬 Kino vaqti bot").catch(() => {});
  await bot.api.setMyDescription(
    "🎬 Kino va seriallarni kod orqali toping. Inline rejimda ham ishlaydi."
  ).catch(() => {});

  const me = await bot.api.getMe();

  // Ikkala rejim uchun bir xil — chat_member va channel_post ham keladi
  const ALLOWED_UPDATES = [
    "message", "callback_query", "inline_query",
    "chat_join_request", "chat_member", "channel_post",
    "pre_checkout_query",
  ] as const;

  // ===== WEBHOOK rejimi (Cloud Run / server) =====
  const webhookUrl = process.env.WEBHOOK_URL;
  const useWebhook = process.env.USE_WEBHOOK === "true" || !!webhookUrl;

  if (useWebhook) {
    const port = Number(process.env.PORT ?? 8080);
    const secret = process.env.WEBHOOK_SECRET ?? "kinobot-secret";

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
          .then((r) => { if (!r.ok) console.warn("⚠️ Keep-alive javobi:", r.status); })
          .catch((err) => console.warn("⚠️ Keep-alive xatosi:", (err as Error).message));
      }, KEEPALIVE_MS);
      console.log(`💓 Keep-alive yoqilgan (har ${KEEPALIVE_MS / 60000} daqiqada)`);
    }
  } else {
    // ===== POLLING rejimi (lokal / Railway) =====
    await bot.api.deleteWebhook();
    console.log(`🤖 @${me.username} polling rejimda ishga tushdi`);
    run(bot, { runner: { fetch: { allowed_updates: [...ALLOWED_UPDATES] } } });
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
  const userId   = BigInt(ctx.from.id);

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

  await prisma.surveyResponse.create({ data: { surveyId, optionId, userId } }).catch(() => null);

  if (survey.isRegionSurvey) {
    await prisma.user.update({ where: { id: userId }, data: { region: option.text } }).catch(() => null);
  }
  if (survey.isGenderSurvey) {
    await prisma.user.update({ where: { id: userId }, data: { gender: option.text } }).catch(() => null);
  }

  await ctx.answerCallbackQuery({ text: `✅ Javobingiz qabul qilindi: ${option.text}` });
  await ctx.editMessageText(
    `${survey.question}\n\n✅ <b>Javobingiz:</b> ${option.text}`
  ).catch(() => {});

  await continueSurveyChain(ctx, userId, surveyId);
});

// ===== Viloyat so'rovnomasi uchun GPS orqali avtomatik manzil aniqlash =====
bot.on("message:location", async (ctx, next) => {
  if (!(await getBool(KEYS.geoDetectEnabled, false))) return next();

  const { latitude, longitude } = ctx.message.location;
  const region = nearestRegion(latitude, longitude);
  const userId = BigInt(ctx.from.id);

  await prisma.user.update({ where: { id: userId }, data: { region } }).catch(() => null);
  await ctx.reply(
    `📍 Manzilingiz aniqlandi: <b>${e.escapeHtml(region)}</b>`,
    { reply_markup: { remove_keyboard: true } }
  );

  // Eng so'nggi faol viloyat so'rovnomasiga javobni yozib, zanjirni davom ettiramiz
  const survey = await prisma.survey.findFirst({
    where: { isRegionSurvey: true },
    orderBy: { createdAt: "desc" },
    include: { options: true },
  });
  if (!survey) return;

  const option = survey.options.find((o) => o.text === region);
  if (option) {
    await prisma.surveyResponse.upsert({
      where: { surveyId_userId: { surveyId: survey.id, userId } },
      create: { surveyId: survey.id, optionId: option.id, userId },
      update: { optionId: option.id },
    }).catch(() => null);
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
