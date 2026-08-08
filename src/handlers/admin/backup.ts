import { Composer } from "grammy";
import { prisma } from "../../prisma.js";
import { config, adminCan, isOwner, syncAdminStateFromDb } from "../../config.js";
import { ADMIN_MENU_BUTTONS, ibtn, BE, kb } from "../../utils/keyboard.js";
import { clearSettingsCache, getBool, setBool, KEYS } from "../../utils/settings.js";
import { buildBackupFile, fetchAndParseBackup } from "../../services/autoBackup.js";
import { normalizeTitle } from "../../utils/translit.js";
import { log } from "../../utils/logger.js";
import type { MyContext } from "../../types.js";
import type { ChannelType } from "@prisma/client";

export const backupHandler = new Composer<MyContext>();

async function backupMenuWithBack() {
  const auto = await getBool(KEYS.autoBackupEnabled, false);
  return kb(
    [ibtn("Backup olish", "backup:get", "primary", BE.backup)],
    [ibtn("Backupdan tiklash", "backup:restore", "success", BE.folder)],
    [
      ibtn(
        auto ? "Avto backup: Yoqilgan (3 kun)" : "Avto backup: O'chirilgan",
        "backup:autotoggle",
        auto ? "success" : "danger"
      ),
    ],
    [ibtn("Orqaga", "botset:back", undefined, BE.backMenu)]
  );
}

// ============ MENYU ============
const BACKUP_HEAD =
  `<b>Backup</b>\n\nBarcha ma'lumotlarni eksport qilish yoki tiklash.\n` +
  `Avto backup yoqilsa — har 3 kunda avtomatik yuboriladi.`;

backupHandler.hears(ADMIN_MENU_BUTTONS.backup, async (ctx) => {
  if (!adminCan(ctx.from?.id ?? 0, "backup")) return;
  await ctx.reply(BACKUP_HEAD, { reply_markup: await backupMenuWithBack() });
});

// "Bot sozlamalari" ichidan ochish (edit)
backupHandler.callbackQuery("backup:menu", async (ctx) => {
  if (!adminCan(ctx.from?.id ?? 0, "backup")) {
    await ctx.answerCallbackQuery();
    return;
  }
  await ctx.answerCallbackQuery();
  await ctx
    .editMessageText(BACKUP_HEAD, { reply_markup: await backupMenuWithBack() })
    .catch(() => {});
});

backupHandler.callbackQuery("backup:autotoggle", async (ctx) => {
  const cur = await getBool(KEYS.autoBackupEnabled, false);
  await setBool(KEYS.autoBackupEnabled, !cur);
  await ctx.answerCallbackQuery({
    text: !cur ? "✅ Avto backup yoqildi (har 3 kunda)" : "❌ Avto backup o'chirildi",
    show_alert: true,
  });
  await ctx.editMessageReplyMarkup({ reply_markup: await backupMenuWithBack() }).catch(() => {});
});

backupHandler.callbackQuery("backup:close", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.deleteMessage().catch(() => {});
});

// ============ BACKUP OLISH ============
backupHandler.callbackQuery("backup:get", async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Backup tayyorlanmoqda..." });

  const { file, counts } = await buildBackupFile();

  // Hujjat ostida knopka chiqmasin
  await ctx.replyWithDocument(file, {
    caption:
      `<b>Backup tayyor</b> (gzip siqilgan)\n\n` +
      `Kinolar: <b>${counts.movies}</b>\n` +
      `Seriallar: <b>${counts.serials}</b> (${counts.episodes} qism)\n` +
      `Kanallar: <b>${counts.channels}</b>\n` +
      `Foydalanuvchilar: <b>${counts.users}</b>`,
  });
});

// ============ TIKLASH — FAYL SO'RASH ============
backupHandler.callbackQuery("backup:restore", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.scratch = { awaitingRestore: true };
  await ctx.reply(
    `📤 <b>Backupdan tiklash</b>\n\n` +
      `Backup <b>.json</b> yoki <b>.json.gz</b> faylini yuboring.\n\n` +
      `⚠️ Mavjud ma'lumotlar ustiga yoziladi.`,
    { reply_markup: kb([ibtn("❌ Bekor qilish", "backup:cancel", "danger")]) }
  );
});

// ============ FAYLNI QABUL QILISH ============
backupHandler.on("message:document", async (ctx, next) => {
  if (!ctx.session.scratch?.awaitingRestore) return next();

  const doc = ctx.message.document;
  if (!doc.file_name?.endsWith(".json") && !doc.file_name?.endsWith(".json.gz")) {
    await ctx.reply("❌ Faqat <b>.json</b> yoki <b>.json.gz</b> formatdagi fayl yuboring.");
    return;
  }

  await ctx.reply("⏳ Fayl tekshirilmoqda...");

  let backupData: Record<string, unknown>;
  try {
    const file = await ctx.api.getFile(doc.file_id);
    const url = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;
    backupData = await fetchAndParseBackup(url);
  } catch {
    await ctx.reply("❌ Faylni o'qib bo'lmadi. Qayta urinib ko'ring.");
    return;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const counts = (backupData as any).counts ?? {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (!(backupData as any).data) {
    await ctx.reply("❌ Bu to'g'ri backup fayli emas (version 2 kerak).");
    return;
  }

  // Faylni sessiyada saqlaymiz
  ctx.session.scratch = { restoreFileId: doc.file_id };

  await ctx.reply(
    `📦 <b>Backup mazmuni:</b>\n\n` +
      `🎬 Kinolar: <b>${counts.movies ?? 0}</b>\n` +
      `📺 Seriallar: <b>${counts.serials ?? 0}</b> (<b>${counts.episodes ?? 0}</b> qism)\n` +
      `📢 Kanallar: <b>${counts.channels ?? 0}</b>\n` +
      `👥 Foydalanuvchilar: <b>${counts.users ?? 0}</b>\n\n` +
      `⚠️ <b>Diqqat!</b> Mavjud ma'lumotlar ustiga yoziladi. Davom etasizmi?`,
    {
      reply_markup: kb(
        [ibtn("Ha, tiklayman", "backup:confirm", "success", BE.check)],
        [ibtn("Bekor qilish", "backup:cancel", "danger")]
      ),
    }
  );
});

// ============ TASDIQLASH VA TIKLASH ============
backupHandler.callbackQuery("backup:confirm", async (ctx) => {
  const fileId = ctx.session.scratch?.restoreFileId as string | undefined;
  if (!fileId) {
    await ctx.answerCallbackQuery({
      text: "Ma'lumot eskirdi. Qaytadan faylni yuboring.",
      show_alert: true,
    });
    return;
  }

  ctx.session.scratch = {};
  await ctx.answerCallbackQuery({ text: "Tiklanmoqda..." });
  await ctx.editMessageText("⏳ <b>Tiklanmoqda, iltimos kuting...</b>").catch(() => {});

  try {
    const file = await ctx.api.getFile(fileId);
    const url = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;
    const backup = await fetchAndParseBackup(url);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await performRestore((backup as any).data, isOwner(ctx.from?.id));

    clearSettingsCache();
    // Restore DB'dagi admin qatorlarini o'zgartirgan bo'lishi mumkin — in-memory
    // adminIds/adminPerms/adminChannelLimit eskirib qolmasligi uchun qayta yuklaymiz.
    await syncAdminStateFromDb();
    log("info", "Backup muvaffaqiyatli tiklandi", {
      movies: result.movies,
      serials: result.serials,
      episodes: result.episodes,
      channels: result.channels,
      users: result.users,
    });

    await ctx
      .editMessageText(
        `<b>Tiklash yakunlandi!</b>\n\n` +
          `🎬 Kinolar: <b>${result.movies}</b>\n` +
          `📺 Seriallar: <b>${result.serials}</b> (<b>${result.episodes}</b> qism)\n` +
          `📢 Kanallar: <b>${result.channels}</b>\n` +
          `👥 Foydalanuvchilar: <b>${result.users}</b>`,
        { reply_markup: await backupMenuWithBack() }
      )
      .catch(() => {});
  } catch (err) {
    log("error", "Backup tiklashda xato", { error: (err as Error).message });
    await ctx
      .editMessageText(`❌ Tiklashda xato: <code>${(err as Error).message}</code>`, {
        reply_markup: await backupMenuWithBack(),
      })
      .catch(() => {});
  }
});

// ============ BEKOR QILISH ============
backupHandler.callbackQuery("backup:cancel", async (ctx) => {
  ctx.session.scratch = {};
  await ctx.answerCallbackQuery({ text: "Bekor qilindi." });
  await ctx
    .editMessageText(
      `<tg-emoji emoji-id="${BE.backup}">💾</tg-emoji> <b>Backup</b>\n\nBekor qilindi.`,
      { reply_markup: await backupMenuWithBack() }
    )
    .catch(() => {});
});

// ============ RESTORE LOGIC ============
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function performRestore(data: any, restorerIsOwner: boolean) {
  let movies = 0,
    serials = 0,
    episodes = 0,
    channels = 0,
    users = 0;

  // Movies
  for (const m of data.movies ?? []) {
    await prisma.movie
      .upsert({
        where: { code: m.code },
        create: {
          code: m.code,
          title: m.title,
          caption: m.caption ?? null,
          fileId: m.fileId,
          baseMsgId: m.baseMsgId ?? null,
          year: m.year ?? null,
          genre: m.genre ?? null,
          quality: m.quality ?? null,
          language: m.language ?? null,
          buttonText: m.buttonText ?? null,
          buttonUrl: m.buttonUrl ?? null,
          buttonStyle: m.buttonStyle ?? "primary",
          views: m.views ?? 0,
          duration: m.duration ?? null,
          shortFileId: m.shortFileId ?? null,
          shortMsgId: m.shortMsgId ?? null,
          isPremium: m.isPremium ?? false,
          titleNorm: normalizeTitle(m.title),
        },
        update: {
          title: m.title,
          caption: m.caption ?? null,
          fileId: m.fileId,
          baseMsgId: m.baseMsgId ?? null,
          year: m.year ?? null,
          genre: m.genre ?? null,
          quality: m.quality ?? null,
          language: m.language ?? null,
          buttonText: m.buttonText ?? null,
          buttonUrl: m.buttonUrl ?? null,
          buttonStyle: m.buttonStyle ?? "primary",
          duration: m.duration ?? null,
          shortFileId: m.shortFileId ?? null,
          shortMsgId: m.shortMsgId ?? null,
          isPremium: m.isPremium ?? false,
          titleNorm: normalizeTitle(m.title),
        },
      })
      .catch(() => null);
    movies++;
  }

  // Tariflar (premium narxlari) — backup v3'dan
  for (const t of data.tariffs ?? []) {
    await prisma.tariff
      .upsert({
        where: { id: t.id },
        create: {
          id: t.id,
          label: t.label,
          days: t.days,
          price: t.price,
          oldPrice: t.oldPrice ?? null,
          starsPrice: t.starsPrice ?? null,
          sortOrder: t.sortOrder ?? 0,
          isActive: t.isActive ?? true,
        },
        update: {
          label: t.label,
          days: t.days,
          price: t.price,
          oldPrice: t.oldPrice ?? null,
          starsPrice: t.starsPrice ?? null,
          sortOrder: t.sortOrder ?? 0,
          isActive: t.isActive ?? true,
        },
      })
      .catch(() => null);
  }

  // Serials (ID mapping kerak)
  const serialIdMap: Record<number, number> = {};
  for (const s of data.serials ?? []) {
    const saved = await prisma.serial
      .upsert({
        where: { code: s.code },
        create: {
          code: s.code,
          title: s.title,
          caption: s.caption ?? null,
          posterId: s.posterId ?? null,
          year: s.year ?? null,
          genre: s.genre ?? null,
          buttonText: s.buttonText ?? null,
          buttonUrl: s.buttonUrl ?? null,
          buttonStyle: s.buttonStyle ?? "primary",
          views: s.views ?? 0,
          titleNorm: normalizeTitle(s.title),
        },
        update: {
          title: s.title,
          caption: s.caption ?? null,
          posterId: s.posterId ?? null,
          year: s.year ?? null,
          genre: s.genre ?? null,
          buttonText: s.buttonText ?? null,
          buttonUrl: s.buttonUrl ?? null,
          buttonStyle: s.buttonStyle ?? "primary",
          titleNorm: normalizeTitle(s.title),
        },
      })
      .catch(() => null);
    if (saved) {
      serialIdMap[Number(s.id)] = saved.id;
      serials++;
    }
  }

  // Seasons (serial ID mapping)
  const seasonIdMap: Record<number, number> = {};
  for (const season of data.seasons ?? []) {
    const newSerialId = serialIdMap[Number(season.serialId)];
    if (!newSerialId) continue;
    const saved = await prisma.season
      .upsert({
        where: { serialId_number: { serialId: newSerialId, number: season.number } },
        create: { serialId: newSerialId, number: season.number, title: season.title ?? null },
        update: { title: season.title ?? null },
      })
      .catch(() => null);
    if (saved) seasonIdMap[Number(season.id)] = saved.id;
  }

  // Episodes
  for (const ep of data.episodes ?? []) {
    const newSeasonId = seasonIdMap[Number(ep.seasonId)];
    if (!newSeasonId) continue;
    await prisma.episode
      .upsert({
        where: { seasonId_number: { seasonId: newSeasonId, number: ep.number } },
        create: {
          seasonId: newSeasonId,
          number: ep.number,
          fileId: ep.fileId,
          title: ep.title ?? null,
          baseMsgId: ep.baseMsgId ?? null,
        },
        update: { fileId: ep.fileId, title: ep.title ?? null, baseMsgId: ep.baseMsgId ?? null },
      })
      .catch(() => null);
    episodes++;
  }

  // Channels
  for (const c of data.channels ?? []) {
    await prisma.channel
      .upsert({
        where: { chatId: BigInt(c.chatId) },
        create: {
          chatId: BigInt(c.chatId),
          title: c.title,
          username: c.username ?? null,
          inviteLink: c.inviteLink ?? null,
          type: c.type as ChannelType,
          isActive: c.isActive ?? true,
          sortOrder: c.sortOrder ?? 0,
        },
        update: {
          title: c.title,
          username: c.username ?? null,
          inviteLink: c.inviteLink ?? null,
          type: c.type as ChannelType,
          isActive: c.isActive ?? true,
          sortOrder: c.sortOrder ?? 0,
        },
      })
      .catch(() => null);
    channels++;
  }

  // Settings
  for (const s of data.settings ?? []) {
    await prisma.setting
      .upsert({
        where: { key: s.key },
        create: { key: s.key, value: s.value },
        update: { value: s.value },
      })
      .catch(() => null);
  }

  // Users — createMany bilan bo'lak-bo'lak (10k+ foydalanuvchi uchun upsert juda sekin)
  // XAVFSIZLIK: isAdmin/permissions/channelLimit faqat OWNER tiklaganda backup'dan
  // yoziladi. Aks holda bu maydonlar qoldiriladi — mavjud DB admin holati saqlanadi,
  // yasama backup orqali o'zini admin qilib olish (eskalatsiya) oldi olinadi.
  const userRows = (data.users ?? []).map((u: Record<string, unknown>) => ({
    id: BigInt(u.id as string | number),
    firstName: (u.firstName as string) ?? null,
    username: (u.username as string) ?? null,
    region: (u.region as string) ?? null,
    gender: (u.gender as string) ?? null,
    referredById: u.referredById != null ? BigInt(u.referredById as string | number) : null,
    referralConfirmed: (u.referralConfirmed as boolean) ?? false,
    isBlocked: (u.isBlocked as boolean) ?? false,
    ...(restorerIsOwner
      ? {
          isAdmin: (u.isAdmin as boolean) ?? false,
          permissions: (u.permissions as string) ?? null,
          channelLimit: (u.channelLimit as number) ?? null,
        }
      : {}),
    premiumUntil: u.premiumUntil ? new Date(u.premiumUntil as string) : null,
    premiumWarnStage: (u.premiumWarnStage as number) ?? 0,
    requestCount: (u.requestCount as number) ?? 0,
    firstRequestAt: u.firstRequestAt ? new Date(u.firstRequestAt as string) : null,
    aiRequestCount: (u.aiRequestCount as number) ?? 0,
    aiRequestDay: (u.aiRequestDay as string) ?? null,
    ...(u.createdAt ? { createdAt: new Date(u.createdAt as string) } : {}),
  }));

  const CHUNK = 2000;
  for (let i = 0; i < userRows.length; i += CHUNK) {
    const res = await prisma.user
      .createMany({ data: userRows.slice(i, i + CHUNK), skipDuplicates: true })
      .catch(() => ({ count: 0 }));
    users += res.count;
  }

  return { movies, serials, episodes, channels, users };
}
