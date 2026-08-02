import { Composer, Keyboard } from "grammy";
import type { ChatAdministratorRights } from "grammy/types";
import { adminCan, getChannelLimit } from "../../config.js";
import { prisma } from "../../prisma.js";
import { ce, e } from "../../utils/emoji.js";
import { ADMIN_MENU_BUTTONS, adminMenuKeyboard, cancelKeyboard, ibtn, BE, kb } from "../../utils/keyboard.js";
import { getBool, setBool, getSetting, setSetting, KEYS } from "../../utils/settings.js";
import { resolveButtonStyle, isValidUrl } from "../../utils/contentButton.js";
import type { MyContext } from "../../types.js";
import type { ChannelType } from "@prisma/client";

export const channelsHandler = new Composer<MyContext>();

const REQ_CHANNEL = 1;
const REQ_GROUP   = 2;

// Minimal admin huquqlar — requestChat bilan botni avtomatik admin qilish uchun.
// MUHIM: bot_administrator_rights user_administrator_rights ichki to'plami bo'lishi shart,
// aks holda Telegram USER_RIGHTS_MISSING xatosini beradi.
const MIN_RIGHTS: ChatAdministratorRights = {
  is_anonymous: false, can_manage_chat: true, can_delete_messages: false,
  can_manage_video_chats: false, can_restrict_members: false, can_promote_members: false,
  can_change_info: false, can_invite_users: true, can_post_messages: false,
  can_edit_messages: false, can_pin_messages: false, can_post_stories: false,
  can_edit_stories: false, can_delete_stories: false, can_manage_topics: false,
};

interface PendingChannel {
  chatId: number;
  title: string;
  username: string | null;
  type: ChannelType;
}

async function channelMenuData() {
  const enabled = await getBool(KEYS.forceSubEnabled, true);
  const count   = await prisma.channel.count();

  const text =
    `${ce("menu")} <b>Kanal boshqaruvi</b>\n\n` +
    `Holat: <b>${enabled ? "Yoqilgan" : "O'chirilgan"}</b>\n` +
    `Kanallar soni: <b>${count}</b>\n\n` +
    `Quyidagi tugmalardan birini tanlang:`;

  const markup = kb(
    [
      ibtn(
        enabled ? "Majburiy obuna: Yoqilgan" : "Majburiy obuna: O'chirilgan",
        "ch:toggle", enabled ? "success" : "danger",
        enabled ? BE.subOn : BE.subOff
      ),
      ibtn(`Ro'yxat (${count})`, "ch:list", "primary", BE.chList),
    ],
    [
      ibtn("Qo'shish",  "ch:add",  "success", BE.chAdd),
      ibtn("O'chirish", "ch:del",  "danger",  BE.chDelete),
    ],
    [
      ibtn("🎨 Knopka sozlamalari", "ch:btnsettings", "primary"),
      ibtn("So'rovlar",             "ch:jrstats",     "primary", BE.stats),
    ],
    [ibtn("Menyuga qaytish", "ch:close", undefined, BE.backMenu)],
  );

  return { text, markup };
}

channelsHandler.hears(ADMIN_MENU_BUTTONS.channels, async (ctx) => {
  if (!adminCan(ctx.from?.id ?? 0, "channels")) return;
  const { text, markup } = await channelMenuData();
  await ctx.reply(text, { reply_markup: markup });
});

async function refreshMenu(ctx: MyContext) {
  const { text, markup } = await channelMenuData();
  await ctx.editMessageText(text, { reply_markup: markup }).catch(async () => {
    await ctx.reply(text, { reply_markup: markup });
  });
}

channelsHandler.callbackQuery("ch:menu",  async (ctx) => { await ctx.answerCallbackQuery(); await refreshMenu(ctx); });
channelsHandler.callbackQuery("ch:close", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.deleteMessage().catch(() => {});
  await ctx.reply("Admin panel:", { reply_markup: adminMenuKeyboard(ctx.from.id) });
});

// ============ TOGGLE (umumiy majburiy obuna) ============
channelsHandler.callbackQuery("ch:toggle", async (ctx) => {
  const cur = await getBool(KEYS.forceSubEnabled, true);
  await setBool(KEYS.forceSubEnabled, !cur);
  await ctx.answerCallbackQuery({
    text: !cur
      ? "✅ Majburiy obuna YOQILDI\n\nEndi foydalanuvchilar kanallarga a'zo bo'lishi shart."
      : "❌ Majburiy obuna O'CHIRILDI\n\nFoydalanuvchilar obunasiz foydalana oladi.",
    show_alert: true,
  });
  await refreshMenu(ctx);
});

const TYPE_LABEL: Record<ChannelType, string> = {
  PUBLIC: "Ommaviy", PRIVATE: "Maxfiy", REQUEST: "So'rovli", INSTAGRAM: "Instagram/boshqa",
};

// ============ RO'YXAT ============
channelsHandler.callbackQuery("ch:list", async (ctx) => {
  await ctx.answerCallbackQuery();
  await renderChannelList(ctx);
});

async function renderChannelList(ctx: MyContext) {
  const channels = await prisma.channel.findMany({ orderBy: { sortOrder: "asc" } });
  if (channels.length === 0) {
    await ctx.editMessageText("📭 Hozircha kanal qo'shilmagan.", {
      reply_markup: kb([ibtn("Orqaga", "ch:menu", undefined, BE.backMenu)]),
    }).catch(() => {});
    return;
  }

  const rows = channels.map((c) => [
    ibtn(
      `${c.isActive ? "🟢" : "🔴"} ${TYPE_LABEL[c.type]} · ${c.title}`.slice(0, 60),
      `ch:view:${c.id}`,
      c.isActive ? "success" : "danger",
    ),
  ]);
  rows.push([ibtn("Orqaga", "ch:menu", undefined, BE.backMenu)]);

  await ctx.editMessageText(
    `${ce("list")} <b>Kanallar ro'yxati</b>\n\n🟢 = majburiy obuna yoqilgan\n🔴 = o'chirilgan\n\nBatafsil va statistika uchun tanlang:`,
    { reply_markup: kb(...rows) }
  ).catch(() => {});
}

// ============ KANAL DETALI + STATISTIKA ============
function startOfDay(d: Date) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }

async function renderChannelDetail(ctx: MyContext, id: number) {
  const c = await prisma.channel.findUnique({ where: { id } });
  if (!c) { await ctx.answerCallbackQuery({ text: "Kanal topilmadi.", show_alert: true }); return; }

  const now = new Date();
  const today = startOfDay(now);
  const week  = new Date(now); week.setDate(week.getDate() - 7);
  const month = new Date(now); month.setDate(month.getDate() - 30);

  const [joinToday, joinWeek, joinMonth, joinTotal] = await Promise.all([
    prisma.channelEvent.count({ where: { channelId: c.chatId, type: "join", date: { gte: today } } }),
    prisma.channelEvent.count({ where: { channelId: c.chatId, type: "join", date: { gte: week } } }),
    prisma.channelEvent.count({ where: { channelId: c.chatId, type: "join", date: { gte: month } } }),
    prisma.channelEvent.count({ where: { channelId: c.chatId, type: "join" } }),
  ]);

  // Umumiy a'zo soni (Telegram)
  let memberCount = "—";
  if (c.type !== "INSTAGRAM") {
    const cnt = await ctx.api.getChatMemberCount(Number(c.chatId)).catch(() => null);
    if (cnt !== null) memberCount = String(cnt);
  }

  const handle = c.username ? `@${c.username}` : c.inviteLink ?? "(havola yo'q)";

  let reqLine = "";
  if (c.type === "REQUEST") {
    const pending = await prisma.joinRequest.count({ where: { channelId: c.chatId, status: "pending" } });
    reqLine = `\n⏳ Kutilayotgan so'rovlar: <b>${pending}</b>`;
  }

  const text =
    `<tg-emoji emoji-id="${BE.channel}">📢</tg-emoji> <b>${e.escapeHtml(c.title)}</b>\n` +
    `Tur: <b>${TYPE_LABEL[c.type]}</b>\n` +
    `<code>${e.escapeHtml(handle)}</code>\n` +
    `Majburiy obuna: <b>${c.isActive ? "🟢 Yoqilgan" : "🔴 O'chirilgan"}</b>\n\n` +
    `<b>📊 Qo'shilish statistikasi:</b>\n` +
    `Bugun: <b>${joinToday}</b>\n` +
    `1 hafta: <b>${joinWeek}</b>\n` +
    `1 oy: <b>${joinMonth}</b>\n` +
    `Jami (kuzatilgan): <b>${joinTotal}</b>\n` +
    `Umumiy a'zolar: <b>${memberCount}</b>` +
    reqLine;

  const rows: ReturnType<typeof ibtn>[][] = [
    [ibtn(
      c.isActive ? "🔴 Majburiy obunani o'chirish" : "🟢 Majburiy obunani yoqish",
      `ch:subtoggle:${c.id}`,
      c.isActive ? "danger" : "success",
    )],
    [ibtn("✏️ Yorliqni tahrirlash", `ch:editlabel:${c.id}`, "primary")],
  ];
  if (c.type === "REQUEST") {
    rows.push([ibtn("📋 So'rovlarni boshqarish", "ch:jrstats", "primary")]);
  }
  rows.push([ibtn("🗑 O'chirish", `ch:delconf:${c.id}`, "danger", BE.chDelete)]);
  rows.push([ibtn("Orqaga", "ch:list", undefined, BE.backMenu)]);

  await ctx.editMessageText(text, { reply_markup: kb(...rows) }).catch(() => {});
}

channelsHandler.callbackQuery(/^ch:view:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await renderChannelDetail(ctx, Number(ctx.match[1]));
});

// Har bir kanal uchun alohida majburiy obuna toggle (popup bilan)
channelsHandler.callbackQuery(/^ch:subtoggle:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  const c = await prisma.channel.findUnique({ where: { id } });
  if (!c) { await ctx.answerCallbackQuery({ text: "Topilmadi.", show_alert: true }); return; }
  const next = !c.isActive;
  await prisma.channel.update({ where: { id }, data: { isActive: next } });
  await ctx.answerCallbackQuery({
    text: next
      ? `✅ "${c.title}" — majburiy obuna YOQILDI`
      : `❌ "${c.title}" — majburiy obuna O'CHIRILDI`,
    show_alert: true,
  });
  await renderChannelDetail(ctx, id);
});

// ============ KANAL YORLIG'INI TAHRIRLASH ============
channelsHandler.callbackQuery(/^ch:editlabel:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  const ch = await prisma.channel.findUnique({ where: { id } });
  if (!ch) { await ctx.answerCallbackQuery({ text: "Topilmadi.", show_alert: true }); return; }
  await ctx.answerCallbackQuery();
  ctx.session.scratch = { editChannelLabel: id };
  await ctx.reply(
    `<b>${e.escapeHtml(ch.title)}</b> uchun obuna sahifasidagi yorliqni yuboring.\n\n` +
    `Hozirgi: <b>${ch.buttonLabel ?? "(standart)"}</b>\n\n` +
    `Masalan: <code>📢 Asosiy kanal</code>\n` +
    `Standartga qaytarish uchun: <code>-</code>`,
    { reply_markup: kb([ibtn("Bekor qilish", "ch:editlabel:cancel", "danger")]) }
  );
});

channelsHandler.callbackQuery("ch:editlabel:cancel", async (ctx) => {
  await ctx.answerCallbackQuery({ text: "❌ Bekor qilindi." });
  if (ctx.session.scratch) delete ctx.session.scratch.editChannelLabel;
  await refreshMenu(ctx);
});

// ============ KNOPKA SOZLAMALARI ============
channelsHandler.callbackQuery("ch:btnsettings", async (ctx) => {
  await ctx.answerCallbackQuery();
  await renderBtnSettings(ctx);
});

async function renderBtnSettings(ctx: MyContext, edit = true) {
  const btnText   = await getSetting(KEYS.subCheckBtnText,    "Tekshirish");
  const btnStyle  = await getSetting(KEYS.subCheckBtnStyle,   "");
  const chLabel   = await getSetting(KEYS.subChannelBtnLabel, "+ Kanalga obuna bo'lish");

  const text =
    `<b>Obuna knopkalari sozlamasi</b>\n\n` +
    `<b>Kanal knopkasi (standart yorliq):</b>\n<b>${e.escapeHtml(chLabel)}</b>\n\n` +
    `<b>"Tekshirish" knopkasi:</b>\nMatn: <b>${e.escapeHtml(btnText)}</b>\n` +
    `Rang: <b>${btnStyle || "yo'q"}</b>\n\n` +
    `<i>Bu knopkalar foydalanuvchiga obuna so'ralganda ko'rinadi.\n` +
    `Har bir kanalga alohida yorliq — "Ro'yxat" bo'limida.</i>`;

  const reply_markup = kb(
    [ibtn("Kanal knopka matnini o'zgartirish", "ch:chlbltext", "primary")],
    [ibtn("Tekshirish matnini o'zgartirish", "ch:subbtntext", "primary")],
    [
      ibtn("Ko'k",   "ch:subbtnsty:primary", "primary"),
      ibtn("Yashil", "ch:subbtnsty:success", "success"),
      ibtn("Qizil",  "ch:subbtnsty:danger",  "danger"),
      ibtn("Random", "ch:subbtnsty:random",  "success"),
    ],
    [ibtn("Standartga qaytarish", "ch:subbtnreset", "danger")],
    [ibtn("Orqaga", "ch:menu", undefined, BE.backMenu)],
  );

  // Panelni bitta xabar sifatida ushlab turamiz: matn-kutish oqimidan keyin
  // (edit=false) eskisi o'chirilib, o'rniga yangisi yoziladi.
  if (edit) {
    const ok = await ctx.editMessageText(text, { reply_markup }).catch(() => null);
    if (ok) {
      const mid = ctx.callbackQuery?.message?.message_id;
      if (mid) ctx.session.scratch = { ...(ctx.session.scratch ?? {}), chBtnPanelMsgId: mid };
      return;
    }
  }
  const prevId = ctx.session.scratch?.chBtnPanelMsgId as number | undefined;
  if (prevId) await ctx.api.deleteMessage(ctx.chat!.id, prevId).catch(() => {});
  const sent = await ctx.reply(text, { reply_markup });
  ctx.session.scratch = { ...(ctx.session.scratch ?? {}), chBtnPanelMsgId: sent.message_id };
}

channelsHandler.callbackQuery("ch:chlbltext", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.scratch = { ...(ctx.session.scratch ?? {}), editChannelDefLabel: true };
  await ctx.reply(
    `Kanal knopkasining <b>standart yorlig'ini</b> yuboring.\n\n` +
    `Masalan: <code>+ Kanalga obuna bo'lish</code>`,
    { reply_markup: cancelKeyboard() }
  );
});

channelsHandler.callbackQuery("ch:subbtntext", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.scratch = { ...(ctx.session.scratch ?? {}), editSubBtnText: true };
  await ctx.reply(
    'Yangi "Tekshirish" knopkasi matnini yuboring:\n\nMasalan: <code>✅ A\'zo bo\'ldim</code>',
    { reply_markup: cancelKeyboard() }
  );
});

channelsHandler.callbackQuery(/^ch:subbtnsty:(primary|success|danger|random)$/, async (ctx) => {
  const style = resolveButtonStyle(ctx.match[1]);
  await setSetting(KEYS.subCheckBtnStyle, style);
  await ctx.answerCallbackQuery({ text: `Rang: ${style}` });
  await renderBtnSettings(ctx);
});

channelsHandler.callbackQuery("ch:subbtnreset", async (ctx) => {
  await Promise.all([
    setSetting(KEYS.subCheckBtnText,     "Tekshirish"),
    setSetting(KEYS.subCheckBtnStyle,    ""),
    setSetting(KEYS.subChannelBtnLabel,  "+ Kanalga obuna bo'lish"),
  ]);
  await ctx.answerCallbackQuery({ text: "Standartga qaytarildi." });
  await renderBtnSettings(ctx);
});

// "ch:jrstats" callback joinStats.ts handlerida ko'tariladi.

// ============ QO'SHISH — TUR TANLASH ============
channelsHandler.callbackQuery("ch:add", async (ctx) => {
  // Kanal limiti tekshiruvi (owner uchun cheksiz)
  const limit = getChannelLimit(ctx.from.id);
  if (limit !== null) {
    const count = await prisma.channel.count();
    if (count >= limit) {
      await ctx.answerCallbackQuery({
        text: `❌ Siz maksimal ${limit} ta kanal qo'sha olasiz. Limit to'ldi.`,
        show_alert: true,
      });
      return;
    }
  }
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `<b>Qaysi turdagi kanal/guruh qo'shasiz?</b>\n\n` +
    `<b>Ommaviy</b> — @username bor. Forward yoki @username bilan ham qo'shish mumkin.\n` +
    `<b>Maxfiy</b> — havola orqali qo'shiladi.\n` +
    `<b>So'rovli</b> — so'rov yuboriladi, taklif havolasi kerak.\n` +
    `<b>Instagram/boshqa</b> — Instagram profil, Telegram bot yoki istalgan boshqa havola. ` +
    `A'zolik TEKSHIRILMAYDI — ro'yxatda ko'rinadi, lekin "Tekshirish"ni bloklamaydi.`,
    {
      reply_markup: kb(
        [
          ibtn("Ommaviy",   "ch:type:PUBLIC",  "primary", "5260268501515377807"),
          ibtn("Maxfiy",    "ch:type:PRIVATE", "success", "5258476306152038031"),
        ],
        [
          ibtn("So'rovli",  "ch:type:REQUEST",   "danger",  "5258419835922030550"),
          ibtn("Instagram/boshqa", "ch:type:INSTAGRAM", "primary", "5258205968025525531"),
        ],
        [ibtn("Orqaga", "ch:menu", undefined, BE.backMenu)],
      ),
    }
  ).catch(() => {});
});

channelsHandler.callbackQuery(/^ch:type:(PUBLIC|PRIVATE|REQUEST|INSTAGRAM)$/, async (ctx) => {
  const type = ctx.match[1] as ChannelType;
  await ctx.answerCallbackQuery();
  ctx.session.scratch = { addChannelType: type };

  // Instagram/boshqa alohida oqim — requestChat kerak emas, a'zolik tekshirilmaydi
  if (type === "INSTAGRAM") {
    await ctx.reply(
      `📸 <b>Instagram/boshqa havola qo'shish</b>\n\n` +
      `Havolani yuboring — Instagram profil, Telegram bot yoki istalgan boshqa link bo'lishi mumkin.\n` +
      `Masalan: <code>https://instagram.com/username</code> yoki <code>https://t.me/botname</code>`,
      {
        reply_markup: new Keyboard().text("❌ Bekor qilish").resized().oneTime(),
      }
    );
    return;
  }

  const requirePublic = type === "PUBLIC";
  const typeName = type === "PUBLIC" ? "Ommaviy" : type === "PRIVATE" ? "Maxfiy" : "So'rovli";

  // user_administrator_rights + bot_administrator_rights — Telegram botni avtomatik
  // admin qiladi. Ikkalasi bir xil (minimal) bo'lishi shart, aks holda USER_RIGHTS_MISSING.
  const rkb = new Keyboard()
    .requestChat("📢 Kanalni tanlash", REQ_CHANNEL, {
      chat_is_channel: true,
      chat_has_username: requirePublic ? true : undefined,
      user_administrator_rights: MIN_RIGHTS,
      bot_administrator_rights: MIN_RIGHTS,
      request_title: true, request_username: true,
    })
    .row()
    .requestChat("👥 Guruhni tanlash", REQ_GROUP, {
      chat_is_channel: false,
      chat_has_username: requirePublic ? true : undefined,
      user_administrator_rights: MIN_RIGHTS,
      bot_administrator_rights: MIN_RIGHTS,
      request_title: true, request_username: true,
    })
    .row()
    .text("❌ Bekor qilish")
    .resized().oneTime();

  let extra = "";
  if (type === "PUBLIC") {
    extra = `\n\n<i>Yoki kanaldan xabar <b>forward</b> qiling, yoxud <code>@username</code> / <code>https://t.me/username</code> yuboring.</i>`;
  }

  await ctx.reply(
    `<b>${typeName} qo'shish</b>\n\n` +
    `Tugma orqali kanal/guruhni tanlang.\n` +
    `Faqat <b>siz admin yoki ega</b> bo'lgan joylar ko'rinadi.\n` +
    `Tanlaganingizda bot avtomatik <b>admin</b> qilib qo'shiladi.${extra}`,
    { reply_markup: rkb }
  );
});

// ============ SO'ROVLI — AVTOMATIK INVITE ============
channelsHandler.callbackQuery("ch:autoinvite", async (ctx) => {
  await ctx.answerCallbackQuery();
  const pending = ctx.session.scratch?.pendingRequestChannel as PendingChannel | undefined;
  if (!pending) {
    await ctx.reply("❌ Ma'lumot eskirdi. Qaytadan urinib ko'ring.");
    const { text, markup } = await channelMenuData();
    await ctx.reply(text, { reply_markup: markup });
    return;
  }
  try {
    const link = await ctx.api.createChatInviteLink(pending.chatId, {
      name: "Kino bot majburiy obuna",
      creates_join_request: true,
    });
    await finishAddChannel(ctx, { ...pending, inviteLink: link.invite_link });
  } catch (err) {
    await ctx.reply(`❌ Havola yaratib bo'lmadi: ${(err as Error).message}\n\nBotda <b>can_invite_users</b> huquqi borligini tekshiring.`);
  }
});

channelsHandler.callbackQuery("ch:cancelinvite", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.scratch = {};
  await refreshMenu(ctx);
});

// ============ BARCHA XABARLARNI USHLAB OLISH ============
channelsHandler.on("message", async (ctx, next) => {
  const hasPending    = !!ctx.session.scratch?.pendingRequestChannel;
  const hasAddType    = !!ctx.session.scratch?.addChannelType;
  const editLabelId   = ctx.session.scratch?.editChannelLabel as number | undefined;
  const editSubBtn    = !!ctx.session.scratch?.editSubBtnText;
  const editDefLabel  = !!ctx.session.scratch?.editChannelDefLabel;

  // Kanal standart yorlig'ini tahrirlash
  if (editDefLabel) {
    if (ctx.message?.chat_shared) return next();
    const msgText = ctx.message?.text?.trim();
    if (!msgText) return next();
    if (ctx.session.scratch) delete ctx.session.scratch.editChannelDefLabel;
    if (msgText === "❌ Bekor qilish" || msgText === "/cancel") {
      await ctx.reply("❌ Bekor qilindi.");
      return;
    }
    await setSetting(KEYS.subChannelBtnLabel, msgText.slice(0, 64));
    await ctx.reply(`${ce("check")} Kanal knopka matni saqlandi: <b>${e.escapeHtml(msgText.slice(0, 64))}</b>`);
    await renderBtnSettings(ctx, false);
    return;
  }

  // Kanal yorlig'ini tahrirlash
  if (editLabelId) {
    if (ctx.message?.chat_shared) return next();
    const msgText = ctx.message?.text?.trim();
    if (!msgText) return next();
    if (msgText === "❌ Bekor qilish" || msgText === "/cancel") {
      ctx.session.scratch = {};
      await ctx.reply("❌ Bekor qilindi.");
      return;
    }
    const newLabel = msgText === "-" ? null : msgText.slice(0, 64);
    await prisma.channel.update({ where: { id: editLabelId }, data: { buttonLabel: newLabel } }).catch(() => null);
    ctx.session.scratch = {};
    await ctx.reply(`${ce("check")} Yorliq saqlandi: <b>${newLabel ?? "(standart)"}</b>`);
    return;
  }

  // Sub check button matnini tahrirlash
  if (editSubBtn) {
    if (ctx.message?.chat_shared) return next();
    const msgText = ctx.message?.text?.trim();
    if (!msgText) return next();
    if (msgText === "❌ Bekor qilish" || msgText === "/cancel") {
      if (ctx.session.scratch) delete ctx.session.scratch.editSubBtnText;
      await ctx.reply("❌ Bekor qilindi.");
      return;
    }
    await setSetting(KEYS.subCheckBtnText, msgText.slice(0, 32));
    if (ctx.session.scratch) delete ctx.session.scratch.editSubBtnText;
    await ctx.reply(`${ce("check")} Knopka matni saqlandi: <b>${e.escapeHtml(msgText.slice(0, 32))}</b>`);
    await renderBtnSettings(ctx, false);
    return;
  }

  if (!hasPending && !hasAddType) return next();

  // chat_shared — o'z handleriga
  if (ctx.message?.chat_shared) return next();

  const msgText = ctx.message?.text?.trim();

  // Bekor qilish
  if (msgText === "❌ Bekor qilish" || msgText === "/cancel") {
    ctx.session.scratch = {};
    await ctx.reply("❌ Bekor qilindi.", { reply_markup: { remove_keyboard: true } });
    const { text, markup } = await channelMenuData();
    await ctx.reply(text, { reply_markup: markup });
    return;
  }

  // --- SO'ROVLI KANAL uchun invite link ---
  if (hasPending) {
    if (!msgText) { await ctx.reply("❌ Matn yuboring."); return; }
    if (!msgText.startsWith("https://t.me/+") && !msgText.startsWith("https://t.me/joinchat/")) {
      await ctx.reply(
        "❌ To'g'ri join-request havolasi emas.\n\n" +
        "<code>https://t.me/+</code> yoki <code>https://t.me/joinchat/</code> bilan boshlanishi kerak."
      );
      return;
    }
    const pending = ctx.session.scratch!.pendingRequestChannel as PendingChannel;
    await finishAddChannel(ctx, { ...pending, inviteLink: msgText });
    return;
  }

  const type = ctx.session.scratch!.addChannelType as ChannelType;

  // Instagram/boshqa havola (Telegram bot va h.k.) — a'zolik tekshirilmaydi
  if (type === "INSTAGRAM") {
    if (!msgText) { await ctx.reply("❌ Havola yuboring."); return; }
    if (!isValidUrl(msgText)) {
      await ctx.reply(
        "❌ To'g'ri havola emas.\n\nMasalan: <code>https://instagram.com/username</code> yoki <code>https://t.me/botname</code>"
      );
      return;
    }
    const isInstagram = /instagram\.com|instagr\.am/i.test(msgText);
    let title: string;
    if (isInstagram) {
      const username = msgText.replace(/https?:\/\/(www\.)?instagram\.com\//i, "").replace(/\/$/, "").split("/")[0];
      title = username ? `Instagram: @${username}` : "Instagram";
    } else {
      title = (() => { try { return new URL(msgText).hostname.replace(/^www\./, ""); } catch { return "Havola"; } })();
    }
    ctx.session.scratch = {};
    await finishAddChannel(ctx, {
      chatId: -(Date.now() % 1000000000), // unikal salbiy ID
      title,
      username: null,
      type: "INSTAGRAM",
      inviteLink: msgText,
    });
    return;
  }

  // Forward from channel
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const origin = (ctx.message as any)?.forward_origin;
  if (origin?.type === "channel") {
    await processChannelInfo(ctx, {
      chatId: origin.chat.id,
      title: origin.chat.title ?? "Noma'lum",
      username: origin.chat.username ?? null,
      type,
    });
    return;
  }

  // @username yoki https://t.me/ (faqat PUBLIC)
  if (type === "PUBLIC" && msgText && (msgText.startsWith("@") || msgText.includes("t.me/"))) {
    let target: string | null = null;
    if (msgText.startsWith("@")) {
      target = msgText;
    } else {
      const m = msgText.match(/t\.me\/([^/?+\s]+)/);
      if (m && !m[1].startsWith("+") && m[1] !== "joinchat") target = "@" + m[1];
    }
    if (!target) { await ctx.reply("❌ Havola noto'g'ri."); return; }
    try {
      const chat = await ctx.api.getChat(target);
      await processChannelInfo(ctx, {
        chatId: chat.id,
        title: (chat as { title?: string }).title ?? "Noma'lum",
        username: (chat as { username?: string }).username ?? null,
        type,
      });
    } catch (err) {
      await ctx.reply(`❌ Kanal topilmadi: ${(err as Error).message}`);
    }
    return;
  }

  return next();
});

// ============ CHAT TANLANDI (requestChat) ============
channelsHandler.on("message:chat_shared", async (ctx) => {
  const shared = ctx.message.chat_shared;
  const type   = (ctx.session.scratch?.addChannelType as ChannelType) ?? "PUBLIC";
  ctx.session.scratch = {};

  const chatId   = shared.chat_id;
  const chat     = await ctx.api.getChat(chatId).catch(() => null);
  const title    = shared.title ?? (chat && "title" in chat ? chat.title : undefined) ?? "Noma'lum";
  const username = shared.username ?? (chat && "username" in chat ? chat.username : undefined) ?? null;

  await processChannelInfo(ctx, { chatId, title, username, type });
});

// Telegram botni admin qilishni biroz kechiktirishi mumkin — bir necha marta urinamiz
async function waitBotAdmin(ctx: MyContext, chatId: number, attempts = 5) {
  for (let i = 0; i < attempts; i++) {
    const m = await ctx.api.getChatMember(chatId, ctx.me.id).catch(() => null);
    if (m && (m.status === "administrator" || m.status === "creator")) return m;
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1200));
  }
  return null;
}

// ============ KANAL TEKSHIRISH VA SAQLASH ============
async function processChannelInfo(ctx: MyContext, info: PendingChannel) {
  const { chatId, title, username, type } = info;

  // Telegram bot_administrator_rights orqali botni avtomatik admin qiladi,
  // lekin bu biroz vaqt olishi mumkin — shuning uchun qayta urinamiz.
  const botMember = await waitBotAdmin(ctx, chatId);
  if (!botMember) {
    await ctx.reply(
      `❌ Bot <b>${e.escapeHtml(title)}</b> da admin bo'la olmadi.\n\n` +
      `Iltimos, botni qo'lda <b>admin</b> qilib qo'shing (kanal/guruh sozlamalari → Adminlar → ${ctx.me.username ? "@" + ctx.me.username : "bot"}), ` +
      `so'ng qaytadan "Qo'shish" tugmasidan foydalaning.`,
      { reply_markup: { remove_keyboard: true } }
    );
    const { text, markup } = await channelMenuData();
    await ctx.reply(text, { reply_markup: markup });
    return;
  }

  if (type === "PUBLIC" && !username) {
    await ctx.reply(
      `❌ Ommaviy kanal uchun <b>username</b> bo'lishi kerak.`,
      { reply_markup: { remove_keyboard: true } }
    );
    const { text, markup } = await channelMenuData();
    await ctx.reply(text, { reply_markup: markup });
    return;
  }

  if (type === "REQUEST") {
    ctx.session.scratch = { pendingRequestChannel: info };
    await ctx.reply(
      `✅ Kanal aniqlandi: <b>${e.escapeHtml(title)}</b>\n\n` +
      `So'rovli kanal uchun <b>join-request havolasi</b> kerak.\n\n` +
      `ℹ️ Bu havola <b>"Apply to join"</b> (qo'shilish so'rovi) turidagi havola bo'lishi kerak.\n` +
      `Telegram'da kanal Sozlamalari → Invite Links → <b>"Request Admin Approval"</b> yoqilgan havola yarating va shu yerga yuboring.\n\n` +
      `Yoki pastdagi tugma orqali bot o'zi yaratsin.`,
      {
        reply_markup: kb(
          [ibtn("🔗 Avtomatik yaratish", "ch:autoinvite",   "success", BE.chAdd)],
          [ibtn("❌ Bekor qilish",        "ch:cancelinvite", "danger",  BE.backMenu)],
        ),
      }
    );
    return;
  }

  let inviteLink: string | null = null;
  if (!username) {
    try {
      const link = await ctx.api.createChatInviteLink(chatId, {
        name: "Kino bot majburiy obuna",
        creates_join_request: false,
      });
      inviteLink = link.invite_link;
    } catch (err) {
      await ctx.reply(`❌ Havola yaratib bo'lmadi: ${(err as Error).message}`, {
        reply_markup: { remove_keyboard: true },
      });
      const { text, markup } = await channelMenuData();
      await ctx.reply(text, { reply_markup: markup });
      return;
    }
  }

  await finishAddChannel(ctx, { ...info, inviteLink });
}

async function finishAddChannel(
  ctx: MyContext,
  info: PendingChannel & { inviteLink: string | null }
) {
  ctx.session.scratch = {};
  const { chatId, title, username, type, inviteLink } = info;

  // Instagram uchun unikal chatId generatsiya qilish (agar conflict bo'lsa)
  let finalChatId = BigInt(chatId);
  if (type === "INSTAGRAM") {
    const existing = await prisma.channel.findFirst({ where: { type: "INSTAGRAM", inviteLink } });
    if (existing) {
      await ctx.reply(`ℹ️ Bu Instagram profil allaqachon qo'shilgan: <b>${e.escapeHtml(existing.title)}</b>`, {
        reply_markup: { remove_keyboard: true },
      });
      const { text, markup } = await channelMenuData();
      await ctx.reply(text, { reply_markup: markup });
      return;
    }
    finalChatId = BigInt(-Date.now());
  }

  try {
    await prisma.channel.upsert({
      where:  { chatId: finalChatId },
      create: {
        chatId: finalChatId, title, username, inviteLink, type,
        sortOrder: (await prisma.channel.count()) + 1,
      },
      update: { title, username, inviteLink, type, isActive: true },
    });
  } catch (err) {
    await ctx.reply(`❌ Xato: ${(err as Error).message}`, {
      reply_markup: { remove_keyboard: true },
    });
    return;
  }

  await ctx.reply(
    `${ce("check")} <b>Qo'shildi!</b>\n\n<b>${e.escapeHtml(title)}</b>\n` +
    (type === "INSTAGRAM" ? `📸 ${e.escapeHtml(inviteLink ?? "")}` :
      (username ? `@${e.escapeHtml(username)}` : inviteLink ? e.escapeHtml(inviteLink) : "")) +
    `\nTur: <b>${type}</b>`,
    { reply_markup: { remove_keyboard: true } }
  );
  const { text, markup } = await channelMenuData();
  await ctx.reply(text, { reply_markup: markup });
}

// ============ O'CHIRISH ============
channelsHandler.callbackQuery("ch:del", async (ctx) => {
  const channels = await prisma.channel.findMany({ orderBy: { sortOrder: "asc" } });
  if (channels.length === 0) {
    await ctx.answerCallbackQuery({ text: "O'chirish uchun kanal yo'q.", show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();
  const rows = channels.map((c) => [ibtn(c.title, `ch:delconf:${c.id}`, "danger", BE.chDelete)]);
  rows.push([ibtn("Orqaga", "ch:menu", undefined, BE.backMenu)]);
  await ctx.editMessageText(`<b>Qaysi kanalni o'chirasiz?</b>`, { reply_markup: kb(...rows) });
});

channelsHandler.callbackQuery(/^ch:delconf:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  try {
    await prisma.channel.delete({ where: { id } });
    await ctx.answerCallbackQuery({ text: "✅ O'chirildi", show_alert: true });
    await renderChannelList(ctx);
  } catch (err) {
    await ctx.answerCallbackQuery({
      text: `❌ O'chirib bo'lmadi: ${(err as Error).message}`,
      show_alert: true,
    });
  }
});
