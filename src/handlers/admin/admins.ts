import { Composer, Keyboard } from "grammy";
import { prisma } from "../../prisma.js";
import {
  addAdminId,
  config,
  isOwner,
  removeAdminId,
  setAdminPerms,
  setAdminChannelLimit,
} from "../../config.js";
import { bot } from "../../bot.js";
import { e } from "../../utils/emoji.js";
import {
  ADMIN_MENU_TEXT,
  adminMenuKeyboard,
  cancelKeyboard,
  ibtn,
  kb,
} from "../../utils/keyboard.js";
import {
  SECTIONS,
  SECTION_LABELS,
  parsePerms,
  serializePerms,
  type Section,
} from "../../utils/permissions.js";
import type { MyContext } from "../../types.js";
import type { User } from "@prisma/client";

export const adminsHandler = new Composer<MyContext>();

const PAGE = 8;
const REQUEST_USERS = 77;
const BACK_TEXT = "Orqaga";
const CANCEL = "❌ Bekor qilish";
const isCancel = (t?: string) => t === CANCEL || t === "/cancel";

function isOwnerId(id: bigint): boolean {
  return config.ownerIds.includes(id);
}

function userLabel(u: Pick<User, "id" | "firstName" | "username">): string {
  const name = u.firstName?.trim() || "Nomsiz";
  const username = u.username ? ` @${u.username}` : "";
  return `${name}${username}`;
}

// ─── Admin qo'shish / olib tashlash ──────────────────────────────────────────

async function grantAdmin(
  id: bigint,
  profile: { firstName?: string | null; username?: string | null } = {}
): Promise<User | null> {
  if (isOwnerId(id)) return null; // owner allaqachon to'liq huquqli

  const user = await prisma.user.upsert({
    where: { id },
    create: {
      id,
      firstName: profile.firstName ?? null,
      username: profile.username ?? null,
      isAdmin: true,
    },
    update: {
      isAdmin: true,
      ...(profile.firstName !== undefined && { firstName: profile.firstName }),
      ...(profile.username !== undefined && { username: profile.username }),
    },
  });
  addAdminId(id);
  setAdminPerms(id, parsePerms(user.permissions));
  setAdminChannelLimit(id, user.channelLimit ?? null);
  return user;
}

async function revokeAdmin(id: bigint): Promise<boolean> {
  if (isOwnerId(id)) return false;
  await prisma.user.update({ where: { id }, data: { isAdmin: false } }).catch(() => null);
  removeAdminId(id);
  return true;
}

/**
 * ID haqiqiy Telegram foydalanuvchisiga (private chat) tegishlimi?
 * Phantom adminlarning oldini oladi: noto'g'ri yozilgan ID bazada admin satrini
 * yaratib, "hech qachon kirmaydigan admin" bo'lib qolmasin. Guruh/kanal ID'lari
 * ham rad etiladi (chat.type !== "private").
 */
async function isRealPrivateUser(id: bigint): Promise<boolean> {
  try {
    const chat = await bot.api.getChat(Number(id));
    return chat.type === "private";
  } catch {
    return false;
  }
}

// ─── Asosiy menyu ────────────────────────────────────────────────────────────

async function renderAdminMenu(ctx: MyContext, edit = false) {
  const [users, admins] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { isAdmin: true } }),
  ]);

  const text =
    `<b>Admin boshqaruvi</b>\n\n` +
    `Ownerlar: <b>${config.ownerIds.length}</b>\n` +
    `Adminlar: <b>${admins}</b>\n` +
    `Foydalanuvchilar: <b>${users}</b>`;

  const markup = kb(
    [ibtn("Telegramdan tanlash", "adm:telegram", "success")],
    [ibtn("ID yoki username orqali", "adm:add", "primary")],
    [ibtn("Adminlar ro'yxati", "adm:list:0", "primary")],
    [ibtn("Orqaga", "botset:back")]
  );

  // Panelni bitta xabar sifatida ushlab turamiz: matn-kutish oqimidan keyin
  // (edit=false, standart holat) eskisi o'chirilib, o'rniga yangisi yoziladi —
  // aks holda har "admin qo'shildi" xabaridan keyin yangi panel qo'shilib,
  // eskisi tirik tugmalari bilan chatda qolib ketardi.
  if (edit) {
    const ok = await ctx.editMessageText(text, { reply_markup: markup }).catch(() => null);
    if (ok) {
      const mid = ctx.callbackQuery?.message?.message_id;
      if (mid) ctx.session.scratch = { ...(ctx.session.scratch ?? {}), admPanelMsgId: mid };
      return;
    }
  }
  const prevId = ctx.session.scratch?.admPanelMsgId as number | undefined;
  if (prevId) await ctx.api.deleteMessage(ctx.chat!.id, prevId).catch(() => {});
  const sent = await ctx.reply(text, { reply_markup: markup });
  ctx.session.scratch = { ...(ctx.session.scratch ?? {}), admPanelMsgId: sent.message_id };
}

adminsHandler.hears(ADMIN_MENU_TEXT, async (ctx) => {
  if (!isOwner(ctx.from?.id)) return;
  if (ctx.session.scratch) delete ctx.session.scratch.adminAction;
  await renderAdminMenu(ctx);
});

adminsHandler.callbackQuery("adm:close", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.deleteMessage().catch(() => {});
  await ctx.reply("Admin panel:", { reply_markup: adminMenuKeyboard(ctx.from.id) });
});

adminsHandler.callbackQuery("adm:menu", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (ctx.session.scratch) delete ctx.session.scratch.adminAction;
  await renderAdminMenu(ctx, true);
});

adminsHandler.callbackQuery("adm:noop", (ctx) => ctx.answerCallbackQuery());

// ─── ID / username orqali qo'shish (birlashtirilgan) ─────────────────────────

adminsHandler.callbackQuery("adm:add", async (ctx) => {
  if (!isOwner(ctx.from.id)) {
    await ctx.answerCallbackQuery({ text: "Faqat owner.", show_alert: true });
    return;
  }
  ctx.session.scratch = { ...(ctx.session.scratch ?? {}), adminAction: "add" };
  await ctx.answerCallbackQuery();
  await ctx.reply(
    `Admin qilinadigan foydalanuvchining <b>ID</b> yoki <b>username</b>ini yuboring.\n\n` +
      `Masalan: <code>123456789</code> yoki <code>@username</code>\n\n` +
      `<i>Username orqali faqat botga oldin kirgan foydalanuvchi topiladi.</i>`,
    { reply_markup: cancelKeyboard() }
  );
});

// ─── Telegramdan tanlash ─────────────────────────────────────────────────────

adminsHandler.callbackQuery("adm:telegram", async (ctx) => {
  if (!isOwner(ctx.from.id)) {
    await ctx.answerCallbackQuery({ text: "Faqat owner.", show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();

  const keyboard = new Keyboard()
    .requestUsers("Foydalanuvchini tanlash", REQUEST_USERS, {
      user_is_bot: false,
      max_quantity: 10,
      request_name: true,
      request_username: true,
    })
    .row()
    .text(BACK_TEXT)
    .resized()
    .oneTime();

  await ctx.reply("Telegram ro'yxatidan foydalanuvchini tanlang.", { reply_markup: keyboard });
});

adminsHandler.hears(BACK_TEXT, async (ctx) => {
  if (!isOwner(ctx.from?.id)) return;
  if (ctx.session.scratch) delete ctx.session.scratch.adminAction;
  await ctx.reply("Admin boshqaruvi:", { reply_markup: { remove_keyboard: true } });
  await renderAdminMenu(ctx);
});

adminsHandler.on("message:users_shared", async (ctx) => {
  if (!isOwner(ctx.from.id)) return;
  const shared = ctx.message.users_shared;
  if (shared.request_id !== REQUEST_USERS) return;

  const added: string[] = [];
  for (const user of shared.users) {
    const saved = await grantAdmin(BigInt(user.user_id), {
      firstName: user.first_name ?? null,
      username: user.username ?? null,
    });
    if (saved) added.push(userLabel(saved));
  }

  await ctx.reply(
    added.length
      ? `<b>Admin qo'shildi:</b>\n\n${added.map(e.escapeHtml).join("\n")}`
      : `Hech kim qo'shilmadi (owner qayta admin qilinmaydi).`,
    { reply_markup: { remove_keyboard: true } }
  );
  await renderAdminMenu(ctx);
});

// ─── Adminlar ro'yxati ───────────────────────────────────────────────────────

adminsHandler.callbackQuery(/^adm:list:(\d+)$/, async (ctx) => {
  if (!isOwner(ctx.from.id)) {
    await ctx.answerCallbackQuery({ text: "Faqat owner.", show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();

  const page = Number(ctx.match[1]);
  const total = await prisma.user.count({ where: { isAdmin: true } });
  const admins = await prisma.user.findMany({
    where: { isAdmin: true },
    orderBy: { createdAt: "desc" },
    skip: page * PAGE,
    take: PAGE,
  });

  const rows: ReturnType<typeof ibtn>[][] = admins.map((u) => [
    ibtn(
      `${isOwnerId(u.id) ? "Owner: " : ""}${userLabel(u)}`.slice(0, 60),
      isOwnerId(u.id) ? "adm:noop" : `adm:view:${u.id}`,
      "primary"
    ),
  ]);

  const pages = Math.max(1, Math.ceil(total / PAGE));
  const nav: ReturnType<typeof ibtn>[] = [];
  if (page > 0) nav.push(ibtn("⬅️", `adm:list:${page - 1}`));
  if (pages > 1) nav.push(ibtn(`${page + 1}/${pages}`, "adm:noop"));
  if (page < pages - 1) nav.push(ibtn("➡️", `adm:list:${page + 1}`));
  if (nav.length) rows.push(nav);
  rows.push([ibtn("Orqaga", "adm:menu")]);

  await ctx
    .editMessageText(
      `<b>Adminlar ro'yxati</b>\n\nAdminni tanlab, huquqlarini sozlang yoki o'chiring.`,
      { reply_markup: kb(...rows) }
    )
    .catch(() => {});
});

// ─── Admin batafsil ──────────────────────────────────────────────────────────

async function renderAdminDetail(ctx: MyContext, id: bigint) {
  const u = await prisma.user.findUnique({ where: { id } });
  if (!u) {
    await ctx.answerCallbackQuery({ text: "Topilmadi.", show_alert: true });
    return;
  }

  const perms = parsePerms(u.permissions); // null = hammasi
  const limit = u.channelLimit;

  const permText =
    perms === null
      ? "Barcha bo'limlar"
      : perms.length
        ? perms.map((p) => SECTION_LABELS[p]).join(", ")
        : "Hech biri";

  const text =
    `<b>Admin: ${e.escapeHtml(userLabel(u))}</b>\n` +
    `ID: <code>${id}</code>\n\n` +
    `Ruxsatlar: <b>${e.escapeHtml(permText)}</b>\n` +
    `Kanal limiti: <b>${limit === null ? "cheksiz" : limit}</b>`;

  await ctx
    .editMessageText(text, {
      reply_markup: kb(
        [ibtn("Huquqlarni sozlash", `adm:perms:${id}`, "primary")],
        [ibtn("Kanal limitini belgilash", `adm:limit:${id}`, "primary")],
        [ibtn("Adminlikdan olish", `adm:remove:${id}`, "danger")],
        [ibtn("Orqaga", "adm:list:0")]
      ),
    })
    .catch(() => {});
}

adminsHandler.callbackQuery(/^adm:view:(\d+)$/, async (ctx) => {
  if (!isOwner(ctx.from.id)) {
    await ctx.answerCallbackQuery({ text: "Faqat owner.", show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();
  await renderAdminDetail(ctx, BigInt(ctx.match[1]));
});

// ─── Huquqlar editori (toggle) ───────────────────────────────────────────────

async function renderPermsEditor(ctx: MyContext, id: bigint) {
  const u = await prisma.user.findUnique({ where: { id } });
  if (!u) return;
  const perms = parsePerms(u.permissions); // null = hammasi
  const has = (s: Section) => perms === null || perms.includes(s);

  const rows = SECTIONS.map((s) => [
    ibtn(
      `${has(s) ? "✅" : "❌"} ${SECTION_LABELS[s]}`,
      `adm:permtgl:${id}:${s}`,
      has(s) ? "success" : "danger"
    ),
  ]);
  rows.push([
    ibtn("Hammasini yoqish", `adm:permall:${id}`, "success"),
    ibtn("Hammasini o'chirish", `adm:permnone:${id}`, "danger"),
  ]);
  rows.push([ibtn("Orqaga", `adm:view:${id}`)]);

  await ctx
    .editMessageText(`<b>Huquqlarni sozlash</b>\n\nHar bir bo'limni yoqing/o'chiring:`, {
      reply_markup: kb(...rows),
    })
    .catch(() => {});
}

adminsHandler.callbackQuery(/^adm:perms:(\d+)$/, async (ctx) => {
  if (!isOwner(ctx.from.id)) {
    await ctx.answerCallbackQuery();
    return;
  }
  await ctx.answerCallbackQuery();
  await renderPermsEditor(ctx, BigInt(ctx.match[1]));
});

async function saveSections(id: bigint, sections: Section[]) {
  await prisma.user
    .update({ where: { id }, data: { permissions: serializePerms(sections) } })
    .catch(() => null);
  setAdminPerms(id, sections);
}

adminsHandler.callbackQuery(/^adm:permtgl:(\d+):(\w+)$/, async (ctx) => {
  if (!isOwner(ctx.from.id)) {
    await ctx.answerCallbackQuery();
    return;
  }
  const id = BigInt(ctx.match[1]);
  const section = ctx.match[2] as Section;
  if (!SECTIONS.includes(section)) {
    await ctx.answerCallbackQuery();
    return;
  }

  const u = await prisma.user.findUnique({ where: { id } });
  const current = parsePerms(u?.permissions) ?? [...SECTIONS]; // null → materializatsiya
  const next = current.includes(section)
    ? current.filter((s) => s !== section)
    : [...current, section];

  await saveSections(id, next);
  await ctx.answerCallbackQuery();
  await renderPermsEditor(ctx, id);
});

adminsHandler.callbackQuery(/^adm:permall:(\d+)$/, async (ctx) => {
  if (!isOwner(ctx.from.id)) {
    await ctx.answerCallbackQuery();
    return;
  }
  const id = BigInt(ctx.match[1]);
  await saveSections(id, [...SECTIONS]);
  await ctx.answerCallbackQuery({ text: "Hammasi yoqildi." });
  await renderPermsEditor(ctx, id);
});

adminsHandler.callbackQuery(/^adm:permnone:(\d+)$/, async (ctx) => {
  if (!isOwner(ctx.from.id)) {
    await ctx.answerCallbackQuery();
    return;
  }
  const id = BigInt(ctx.match[1]);
  await saveSections(id, []);
  await ctx.answerCallbackQuery({ text: "Hammasi o'chirildi." });
  await renderPermsEditor(ctx, id);
});

// ─── Kanal limiti ────────────────────────────────────────────────────────────

adminsHandler.callbackQuery(/^adm:limit:(\d+)$/, async (ctx) => {
  if (!isOwner(ctx.from.id)) {
    await ctx.answerCallbackQuery();
    return;
  }
  await ctx.answerCallbackQuery();
  ctx.session.scratch = { ...(ctx.session.scratch ?? {}), adminLimitTarget: ctx.match[1] };
  await ctx.reply(
    `Ushbu admin majburiy obunaga qo'sha oladigan <b>maksimal kanal sonini</b> yuboring.\n\n` +
      `Masalan: <code>2</code>\n` +
      `Cheksiz qilish uchun: <code>-</code>`,
    { reply_markup: cancelKeyboard() }
  );
});

// ─── Olib tashlash ───────────────────────────────────────────────────────────

adminsHandler.callbackQuery(/^adm:remove:(\d+)$/, async (ctx) => {
  if (!isOwner(ctx.from.id)) {
    await ctx.answerCallbackQuery({ text: "Faqat owner.", show_alert: true });
    return;
  }
  const id = BigInt(ctx.match[1]);
  const ok = await revokeAdmin(id);
  await ctx.answerCallbackQuery({
    text: ok ? "Adminlik olindi." : "Ownerni o'chirib bo'lmaydi.",
    show_alert: !ok,
  });
  if (ok) {
    await ctx
      .editMessageText(`<code>${id}</code> adminlikdan olindi.`, {
        reply_markup: kb([ibtn("Orqaga", "adm:list:0")]),
      })
      .catch(() => {});
  }
});

// ─── Matn kiritish (ID/username qo'shish yoki kanal limiti) ──────────────────

adminsHandler.on("message:text", async (ctx, next) => {
  if (!isOwner(ctx.from.id)) return next();

  // Kanal limiti kiritilmoqda
  const limitTarget = ctx.session.scratch?.adminLimitTarget as string | undefined;
  if (limitTarget) {
    const t = ctx.message.text.trim();
    if (isCancel(t)) {
      if (ctx.session.scratch) delete ctx.session.scratch.adminLimitTarget;
      await ctx.reply("❌ Bekor qilindi.", { reply_markup: { remove_keyboard: true } });
      return;
    }
    if (ctx.session.scratch) delete ctx.session.scratch.adminLimitTarget;
    const id = BigInt(limitTarget);
    const limit = t === "-" ? null : /^\d+$/.test(t) ? Number(t) : null;
    if (t !== "-" && limit === null) {
      await ctx.reply("❌ Faqat raqam yoki <code>-</code>.");
      return;
    }
    await prisma.user.update({ where: { id }, data: { channelLimit: limit } }).catch(() => null);
    setAdminChannelLimit(id, limit);
    await ctx.reply(`✅ Kanal limiti: <b>${limit === null ? "cheksiz" : limit}</b>`);
    return;
  }

  // ID / username qo'shish
  if (ctx.session.scratch?.adminAction !== "add") return next();
  const text = ctx.message.text.trim();
  if (text.startsWith("/")) {
    if (ctx.session.scratch) delete ctx.session.scratch.adminAction;
    return next();
  }
  if (isCancel(text)) {
    if (ctx.session.scratch) delete ctx.session.scratch.adminAction;
    await ctx.reply("❌ Bekor qilindi.", { reply_markup: { remove_keyboard: true } });
    return;
  }

  let target: User | null = null;
  if (/^\d+$/.test(text)) {
    const id = BigInt(text);
    // Phantom admin yo'q: ID haqiqiy foydalanuvchiga tegishli bo'lmasa rad etiladi
    if (!(await isRealPrivateUser(id))) {
      await ctx.reply("❌ Bu ID haqiqiy Telegram foydalanuvchisiga tegishli emas.");
      return;
    }
    const saved = await grantAdmin(id);
    if (!saved) {
      await ctx.reply("❌ Bu owner — qayta admin qilinmaydi.");
      return;
    }
    target = saved;
  } else {
    const username = text.replace(/^@/, "").trim();
    if (!username) {
      await ctx.reply("❌ Bo'sh.");
      return;
    }
    const found = await prisma.user.findFirst({
      where: { username: { equals: username, mode: "insensitive" } },
    });
    if (!found) {
      await ctx.reply(
        `❌ <b>@${e.escapeHtml(username)}</b> topilmadi.\nAvval u botga /start bosgan bo'lishi kerak, yoki ID orqali qo'shing.`
      );
      return;
    }
    target = await grantAdmin(found.id);
    if (!target) {
      await ctx.reply("❌ Bu owner — qayta admin qilinmaydi.");
      return;
    }
  }

  if (ctx.session.scratch) delete ctx.session.scratch.adminAction;
  await ctx.reply(`✅ Admin qo'shildi: <b>${e.escapeHtml(userLabel(target))}</b>`);
  await renderAdminMenu(ctx);
});
