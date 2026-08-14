import { Composer } from "grammy";
import { prisma } from "../../prisma.js";
import { e } from "../../utils/emoji.js";
import { BE, backBtn, cancelKeyboard, ibtn, kb } from "../../utils/keyboard.js";
import { todayUz, dayStartUz } from "../../utils/dateRange.js";
import { countDistinctBotJoins } from "../../utils/channelStats.js";
import type { MyContext } from "../../types.js";

export const joinStatsHandler = new Composer<MyContext>();

/**
 * Panelni chiqaradi: aniq `messageId` berilsa o'sha xabarni tahrirlaydi (yangilash
 * yangi xabar ochmaydi — eski panel yonida dublikat to'planmasligi uchun).
 */
async function sendPanel(
  ctx: MyContext,
  text: string,
  markup: ReturnType<typeof kb>,
  edit: boolean,
  messageId?: number
) {
  if (messageId && ctx.from) {
    await ctx.api
      .editMessageText(ctx.from.id, messageId, text, { reply_markup: markup })
      .catch(() => {});
  } else if (edit) {
    await ctx.editMessageText(text, { reply_markup: markup }).catch(() => {});
  } else {
    await ctx.reply(text, { reply_markup: markup });
  }
}

/** So'rovlar statistikasini chizadi (callback javobini bermaydi) */
async function renderStats(ctx: MyContext, edit = true, messageId?: number) {
  const channels = await prisma.channel.findMany({
    where: { type: "REQUEST", isActive: true },
    orderBy: { sortOrder: "asc" },
  });

  if (channels.length === 0) {
    const text = "📊 <b>So'rovlar statistikasi</b>\n\nSo'rovli kanal qo'shilmagan.";
    const markup = kb([backBtn("ch:menu")]);
    await sendPanel(ctx, text, markup, edit, messageId);
    return;
  }

  // Kun chegaralari Toshkent vaqti (UTC+5) bo'yicha — server UTC'da ishlasa ham
  // "bugun"/"kecha"/"bu oy" admin o'ylagan kundan boshlanadi (3.5).
  const [y, m, d] = todayUz().split("-").map(Number);
  const today = dayStartUz({ y, m, d });
  const yest = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  const month = dayStartUz({ y, m, d: 1 });

  const lines: string[] = [];
  const rows: ReturnType<typeof ibtn>[][] = [];
  let totalPending = 0;

  for (const ch of channels) {
    const cid = ch.chatId;
    const [total, todayN, yestN, monthN, pending] = await Promise.all([
      prisma.joinRequest.count({ where: { channelId: cid } }),
      prisma.joinRequest.count({ where: { channelId: cid, date: { gte: today } } }),
      prisma.joinRequest.count({ where: { channelId: cid, date: { gte: yest, lt: today } } }),
      prisma.joinRequest.count({ where: { channelId: cid, date: { gte: month } } }),
      prisma.joinRequest.count({ where: { channelId: cid, status: "pending" } }),
    ]);

    // Bot tracking havolasi statistikasi (ChannelEvent orqali) —
    // YAGONA odamlar (COUNT DISTINCT), oddiy count emas: takror-qo'shilish
    // yozuvlari ham bitta odam deb sanalishi kerak.
    let botTrackingLine = "";
    if (ch.botInviteLink) {
      const botJoins = await countDistinctBotJoins(cid, null);
      if (botJoins > 0) {
        botTrackingLine = `\n  🔗 Bot orqali (yagona): <b>${botJoins}</b> qo'shilgan`;
      }
    }

    lines.push(
      `📢 <b>${e.escapeHtml(ch.title)}</b>\n` +
        `  Bugun: <b>${todayN}</b> | Kecha: <b>${yestN}</b>\n` +
        `  Bu oy: <b>${monthN}</b> | Jami: <b>${total}</b>\n` +
        `  Kutilmoqda: <b>${pending}</b>` +
        botTrackingLine
    );

    totalPending += pending;
    if (pending > 0) {
      rows.push([ibtn(`✅ ${ch.title} (${pending})`, `jr:menu:${cid}`, "success")]);
    }
  }

  rows.push([ibtn("🔄 Yangilash", "ch:jrstats", "primary"), backBtn("ch:menu")]);

  const text =
    `📊 <b>So'rovlar statistikasi</b>\n\n${lines.join("\n\n")}\n\n` +
    (totalPending > 0
      ? `⏳ Jami kutilmoqda: <b>${totalPending}</b>\n\n<i>Har bir kanal uchun alohida tasdiqlanadi — kanalni tanlang:</i>`
      : `✅ Kutilayotgan so'rov yo'q.`);

  await sendPanel(ctx, text, kb(...rows), edit, messageId);
}

joinStatsHandler.callbackQuery("ch:jrstats", async (ctx) => {
  await ctx.answerCallbackQuery();
  await renderStats(ctx);
});

/** Berilgan kanal uchun pending so'rovlarni tasdiqlaydi, tasdiqlangan sonni qaytaradi */
async function approveRequests(ctx: MyContext, channelId: bigint, limit?: number) {
  const pending = await prisma.joinRequest.findMany({
    where: { status: "pending", channelId },
    orderBy: { date: "asc" },
    // `take: 0` = cheklovsiz (barchasini oladi) — salbiy yoki 0 berilsa
    // hammasini tasdiqlashga aylanib qolmasligi uchun aniq >0 tekshiramiz.
    ...(limit && limit > 0 ? { take: limit } : {}),
  });

  let approved = 0,
    failed = 0;
  for (const req of pending) {
    try {
      await ctx.api.approveChatJoinRequest(Number(req.channelId), Number(req.userId));
      await prisma.joinRequest.update({ where: { id: req.id }, data: { status: "approved" } });
      approved++;
    } catch {
      failed++;
    }
  }
  return { approved, failed };
}

// ============ KANAL TANLANDI — SHU KANAL UCHUN MENYU ============
joinStatsHandler.callbackQuery(/^jr:menu:(-?\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const channelId = BigInt(ctx.match[1]);
  const ch = await prisma.channel.findUnique({ where: { chatId: channelId } });
  const pending = await prisma.joinRequest.count({ where: { channelId, status: "pending" } });

  if (pending === 0) {
    await ctx.answerCallbackQuery({
      text: "Bu kanalda kutilayotgan so'rov yo'q.",
      show_alert: true,
    });
    await renderStats(ctx);
    return;
  }

  await ctx
    .editMessageText(
      `📢 <b>${e.escapeHtml(ch?.title ?? "Kanal")}</b>\n\n⏳ Kutilmoqda: <b>${pending}</b>\n\nNechtasini tasdiqlaysiz?`,
      {
        reply_markup: kb(
          [
            ibtn("✅ 10%", `jr:approve:${channelId}:10`, "success"),
            ibtn("✅ 30%", `jr:approve:${channelId}:30`, "success"),
            ibtn("✅ 50%", `jr:approve:${channelId}:50`, "success"),
          ],
          [ibtn(`✅ Hammasini (${pending})`, `jr:approve:${channelId}:all`, "success", BE.check)],
          [ibtn("✏️ Sonini yozib qabul qilish", `jr:approvecustom:${channelId}`, "primary")],
          [backBtn("ch:jrstats")]
        ),
      }
    )
    .catch(() => {});
});

// ============ TASDIQLASH — FOIZ / HAMMASI (bitta kanal uchun) ============
joinStatsHandler.callbackQuery(/^jr:approve:(-?\d+):(\d+|all)$/, async (ctx) => {
  const channelId = BigInt(ctx.match[1]);
  const arg = ctx.match[2];

  const totalPending = await prisma.joinRequest.count({ where: { channelId, status: "pending" } });
  if (totalPending === 0) {
    await ctx.answerCallbackQuery({ text: "Kutilayotgan so'rov yo'q.", show_alert: true });
    return;
  }

  let limit: number | undefined;
  if (arg !== "all") {
    const pct = Number(arg) / 100;
    limit = Math.max(1, Math.round(totalPending * pct));
  }

  await ctx.answerCallbackQuery({ text: "Tasdiqlanmoqda..." });
  const { approved, failed } = await approveRequests(ctx, channelId, limit);

  await renderStats(ctx);
  await ctx.reply(
    `✅ <b>${approved}</b> ta so'rov tasdiqlandi.` +
      (failed > 0 ? `\n⚠️ ${failed} ta tasdiqlanmadi (eskirgan yoki bot huquqi yetmaydi).` : "")
  );
});

// ============ MAXSUS SON YOZISH (bitta kanal uchun) ============
joinStatsHandler.callbackQuery(/^jr:approvecustom:(-?\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  // Panel qaysi xabarda edi — tasdiqlangach shu xabarni yangilaymiz (dublikat chiqmasligi uchun).
  const panelMsgId =
    ctx.callbackQuery.message && "message_id" in ctx.callbackQuery.message
      ? ctx.callbackQuery.message.message_id
      : undefined;
  ctx.session.scratch = {
    ...(ctx.session.scratch ?? {}),
    approveCustomChannelId: ctx.match[1],
    ...(panelMsgId ? { approveCustomPanelMsg: panelMsgId } : {}),
  };
  await ctx.reply("Nechta so'rovni tasdiqlash kerak? Sonni yuboring:", {
    reply_markup: cancelKeyboard(),
  });
});

joinStatsHandler.on("message:text", async (ctx, next) => {
  const channelIdStr = ctx.session.scratch?.approveCustomChannelId as string | undefined;
  if (!channelIdStr) return next();

  const text = ctx.message.text.trim();
  if (text === "❌ Bekor qilish" || text === "/cancel") {
    if (ctx.session.scratch) delete ctx.session.scratch.approveCustomChannelId;
    await ctx.reply("❌ Bekor qilindi.");
    return;
  }
  if (!/^\d+$/.test(text)) {
    await ctx.reply("❌ Faqat raqam kiriting.");
    return;
  }

  const count = Number(text);
  if (count <= 0) {
    // 0 kiritilsa "hammasini tasdiqlash"ga aylanib qolmasligi kerak — holat saqlanadi,
    // admin xatoni tuzatib qayta yozishi mumkin.
    await ctx.reply("❌ 0 dan katta son kiriting.");
    return;
  }

  const channelId = BigInt(channelIdStr);
  const panelMsgId = ctx.session.scratch?.approveCustomPanelMsg as number | undefined;
  if (ctx.session.scratch) {
    delete ctx.session.scratch.approveCustomChannelId;
    delete ctx.session.scratch.approveCustomPanelMsg;
  }

  const { approved, failed } = await approveRequests(ctx, channelId, count);
  await ctx.reply(
    `✅ <b>${approved}</b> ta so'rov tasdiqlandi.` +
      (failed > 0 ? `\n⚠️ ${failed} ta tasdiqlanmadi.` : "")
  );
  // Yangi panel ochish o'rniga ochiq turgan panelni yangilaymiz.
  await renderStats(ctx, true, panelMsgId);
});
