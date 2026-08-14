import { Composer, Keyboard } from "grammy";
import type { ChatAdministratorRights } from "grammy/types";
import { adminCan, getChannelLimit } from "../../config.js";
import { prisma } from "../../prisma.js";
import { log } from "../../utils/logger.js";
import { ce, e } from "../../utils/emoji.js";
import {
  ADMIN_MENU_BUTTONS,
  BE,
  adminMenuKeyboard,
  backBtn,
  cancelKeyboard,
  homeBtn,
  ibtn,
  kb,
} from "../../utils/keyboard.js";
import { getBool, setBool, getSetting, setSetting, KEYS } from "../../utils/settings.js";
import { buttonStyleLabel, resolveButtonStyle, isValidUrl } from "../../utils/contentButton.js";
import { daysAgoStartUz } from "../../utils/dateRange.js";
import {
  countBotJoinsBySignal,
  countDistinctBotJoins,
  countDistinctJoinsBySource,
  currentBotMembers,
} from "../../utils/channelStats.js";
import {
  buildInviteLinkPanel,
  collectInviteLinkStats,
  ensureInviteLinkRegistered,
  markInviteLinkRevoked,
  registerInviteLink,
} from "../../utils/inviteLinks.js";
import { rebuildMemberSnapshot } from "../../utils/channelEvents.js";
import {
  PROBLEM_LABEL,
  UNLIMITED_MEMBER_LIMIT,
  checkChannelHealth,
  getCachedHealth,
} from "../../services/channelHealth.js";
import { getCachedMemberCount, clearMemberCount } from "../../services/memberCountCache.js";
import type { MyContext } from "../../types.js";
import type { Channel, ChannelType } from "@prisma/client";

export const channelsHandler = new Composer<MyContext>();

const REQ_CHANNEL = 1;
const REQ_GROUP = 2;

// Minimal admin huquqlar — requestChat bilan botni avtomatik admin qilish uchun.
// MUHIM: bot_administrator_rights user_administrator_rights ichki to'plami bo'lishi shart,
// aks holda Telegram USER_RIGHTS_MISSING xatosini beradi.
const MIN_RIGHTS: ChatAdministratorRights = {
  is_anonymous: false,
  can_manage_chat: true,
  can_delete_messages: false,
  can_manage_video_chats: false,
  can_restrict_members: false,
  can_promote_members: false,
  can_change_info: false,
  can_invite_users: true,
  can_post_messages: false,
  can_edit_messages: false,
  can_pin_messages: false,
  can_post_stories: false,
  can_edit_stories: false,
  can_delete_stories: false,
  can_manage_topics: false,
};

interface PendingChannel {
  chatId: number;
  title: string;
  username: string | null;
  type: ChannelType;
}

/**
 * Bot tracking havolasini qaytaradi: mavjudi TIRIK bo'lsa o'shani, aks holda
 * yangisini yaratadi. Har kanal uchun bitta "bot_tracking" havolasi.
 *
 * ⚠️ TIRIKLIK TEKSHIRUVI SHART. Ilgari DB'dagi havola shundoq qaytarilardi —
 * kanal o'chirilib qayta qo'shilganda yoki eski ma'lumot tiklanganda bot
 * BEKOR QILINGAN havolani darvozaga qo'yib yuborardi va majburiy obuna
 * jimgina ishlamay qolardi (14.08.2026 da prodda beshtala kanal shu holatda
 * edi). Bekor qilingan havolani tiklab bo'lmaydi — yangisi kerak.
 */
async function getOrCreateBotInviteLink(ctx: MyContext, chatId: bigint): Promise<string | null> {
  const ch = await prisma.channel.findUnique({
    where: { chatId },
    select: { botInviteLink: true, type: true },
  });

  if (ch?.botInviteLink) {
    // `editChatInviteLink` bekor qilingan havolada ham `ok` qaytaradi,
    // shuning uchun javobdagi `is_revoked` tekshiriladi (channelHealth.ts
    // dagi bilan bir xil mantiq).
    const probe = await ctx.api
      .editChatInviteLink(Number(chatId), ch.botInviteLink, {
        name: "bot_tracking",
        creates_join_request: ch.type === "REQUEST",
        ...(ch.type === "REQUEST" ? {} : { member_limit: UNLIMITED_MEMBER_LIMIT }),
      })
      .catch(() => null);

    if (probe && !probe.is_revoked) return ch.botInviteLink;

    // O'lik havola — registrda "bekor qilingan" deb belgilanadi (statistikasi
    // saqlanadi) va pastda yangisi yaratiladi.
    await markInviteLinkRevoked(ch.botInviteLink);
    log("warn", "Eski tracking havolasi o'lik — yangisi yaratiladi", {
      chatId: chatId.toString(),
    });
  }

  // Yangi "bot_tracking" havolasi yaratamiz
  try {
    const link = await ctx.api.createChatInviteLink(Number(chatId), {
      name: "bot_tracking",
      // SO'ROVLI KANALDA MAJBURIY `true`. `false` bo'lsa bu havola guruhning
      // "yangi a'zolarni tasdiqlash" sozlamasini CHETLAB O'TADI va odamlar
      // navbatsiz kirib ketadi (2026-08-12 da Guruh 2k da aynan shu bo'ldi:
      // 9 ta qo'shilish, 0 ta zayifka). Darvoza baribir odamni darhol
      // o'tkazadi — `pending` zayifka "obuna" deb hisoblanadi.
      creates_join_request: ch?.type === "REQUEST",
    });
    await prisma.channel.update({
      where: { chatId },
      data: { botInviteLink: link.invite_link },
    });
    // Havolalar tarixiga yozamiz — keyin yangilansa ham shu havolaning
    // statistikasi alohida ko'rinib turadi.
    await registerInviteLink(chatId, link.invite_link, "bot_tracking");
    return link.invite_link;
  } catch (err) {
    // Botda can_invite_users huquqi yo'qligi mumkin
    console.warn(
      `[channels] botInviteLink yaratib bo'lmadi chatId=${chatId}:`,
      (err as Error).message
    );
    return null;
  }
}

async function channelMenuData() {
  const enabled = await getBool(KEYS.forceSubEnabled, true);
  const count = await prisma.channel.count();

  const text =
    `${ce("menu")} <b>Kanal boshqaruvi</b>\n\n` +
    `Holat: <b>${enabled ? "Yoqilgan" : "O'chirilgan"}</b>\n` +
    `Kanallar soni: <b>${count}</b>\n\n` +
    `Quyidagi tugmalardan birini tanlang:`;

  const markup = kb(
    [
      ibtn(
        enabled ? "Majburiy obuna: Yoqilgan" : "Majburiy obuna: O'chirilgan",
        "ch:toggle",
        enabled ? "success" : "danger",
        enabled ? BE.subOn : BE.subOff
      ),
      ibtn(`Ro'yxat (${count})`, "ch:list", "primary", BE.chList),
    ],
    [
      ibtn("Qo'shish", "ch:add", "success", BE.chAdd),
      ibtn("O'chirish", "ch:del", "danger", BE.chDelete),
    ],
    [
      ibtn("🎨 Knopka sozlamalari", "ch:btnsettings", "primary"),
      ibtn("So'rovlar", "ch:jrstats", "primary", BE.stats),
    ],
    [homeBtn("ch:close")]
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

channelsHandler.callbackQuery("ch:menu", async (ctx) => {
  await ctx.answerCallbackQuery();
  await refreshMenu(ctx);
});
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
  PUBLIC: "Ommaviy",
  PRIVATE: "Maxfiy",
  REQUEST: "So'rovli",
  INSTAGRAM: "Instagram/boshqa",
};

// ============ RO'YXAT ============
channelsHandler.callbackQuery("ch:list", async (ctx) => {
  await ctx.answerCallbackQuery();
  await renderChannelList(ctx);
});

async function renderChannelList(ctx: MyContext) {
  const channels = await prisma.channel.findMany({ orderBy: { sortOrder: "asc" } });
  if (channels.length === 0) {
    await ctx
      .editMessageText("📭 Hozircha kanal qo'shilmagan.", {
        reply_markup: kb([backBtn("ch:menu")]),
      })
      .catch(() => {});
    return;
  }

  const rows = channels.map((c) => [
    ibtn(
      `${c.isActive ? "🟢" : "🔴"} ${TYPE_LABEL[c.type]} · ${c.title}`.slice(0, 60),
      `ch:view:${c.id}`,
      c.isActive ? "success" : "danger"
    ),
  ]);
  rows.push([backBtn("ch:menu")]);

  await ctx
    .editMessageText(
      `${ce("list")} <b>Kanallar ro'yxati</b>\n\n🟢 = majburiy obuna yoqilgan\n🔴 = o'chirilgan\n\nBatafsil va statistika uchun tanlang:`,
      { reply_markup: kb(...rows) }
    )
    .catch(() => {});
}

// ============ KANAL DETALI + STATISTIKA ============

/** Statistika qiymatlari — panel matnini DB/Telegram'siz test qilish uchun. */
export interface ChannelStatsData {
  botToday: number;
  botWeek: number;
  botMonth: number;
  botTotal: number;
  currentBot: number;
  memberCount: number | null;
  reqPending: number;
  source: { bot: number; link: number; request: number; folder: number; unknown: number };
  /**
   * Faqat REQUEST kanallar uchun: zayifka (join request) hisoblari.
   * Bunday kanalda darvoza `pending` so'rovni "obuna" deb hisoblaydi va odam
   * darhol o'tadi — ya'ni ODAM GURUHGA KIRMAGAN, navbatda turibdi. Shuning
   * uchun asosiy ko'rsatkich "qo'shilgan" emas, ZAYIFKA soni bo'lishi kerak.
   */
  req?: { today: number; week: number; month: number; total: number; approved: number };
  /**
   * Havola kesimining QISQACHA xulosasi. To'liq ro'yxat "🔗 Havolalar" ekranida
   * (`buildInviteLinkPanel`) — bu yerda faqat "havola yangilangan/yangilanmagan"
   * va joriy havola natijasi ko'rinadi, panel cho'zilib ketmasin.
   */
  links?: { count: number; currentJoined: number; currentRequests: number };
  /**
   * "Bot orqali" sonining dalil kesimi: `byLink` — Telegram bot havolasini
   * qaytargan (qat'iy), `byGate` — havola ma'lum emas, darvoza sessiyasi
   * bo'yicha taxmin qilingan. Jami `botTotal` ga teng bo'lishi kerak.
   */
  botSignal?: { byLink: number; byGate: number; legacy: number };
  /**
   * Sog'liq tekshiruvi natijasi — muammolar TAYYOR MATN ko'rinishida
   * (`PROBLEM_LABEL` bilan yechilgan), shunda panel quruvchisi sof qoladi.
   */
  health?: { problems: string[]; disabled: boolean };
}

/**
 * Manba kesimini (Map) panel uchun tayyor obyektga aylantiradi.
 * `direct` va `unknown` ikkalasi ham "Telegram/tegishli manba bermagan" degani —
 * adashtirmaslik uchun bitta "Noma'lum" bucket'ga birlashtiriladi (faqat ko'rsatish,
 * saqlangan ma'lumot o'zgarmaydi). Sof funksiya — test qilish oson.
 */
export function mergeSourceBuckets(
  sourceMap: ReadonlyMap<string, number>
): ChannelStatsData["source"] {
  const out: ChannelStatsData["source"] = { bot: 0, link: 0, request: 0, folder: 0, unknown: 0 };
  for (const [k, v] of sourceMap) {
    if (k === "direct" || k === "unknown") out.unknown += v;
    else if (k === "bot" || k === "link" || k === "request" || k === "folder") out[k] += v;
  }
  return out;
}

/**
 * Uzun izohlarni Telegram'ning YIG'ILADIGAN sitatasiga o'raydi (Bot API 7.2+).
 *
 * Panel qisqa ko'rinadi, izoh esa «ko'proq ko'rish» ostida joyida qoladi —
 * telegra.ph kabi tashqi xizmat kerak emas va ma'lumot Telegramdan chiqmaydi.
 *
 * DIQQAT: sitatani ichma-ich qo'yib bo'lmaydi, shuning uchun har panelda BITTA
 * blok bo'ladi — barcha tushuntirishlar shu yerga yig'iladi.
 */
function foldedHints(hints: string[]): string {
  if (hints.length === 0) return "";
  return `\n\n<blockquote expandable>ℹ️ <b>Izoh</b>\n${hints.join("\n\n")}</blockquote>`;
}

/**
 * Manba kesimi BITTA qatorda. Nol turlar tushirib qoldiriladi — ilgari har
 * biri alohida qator edi va panelning yarmi nollardan iborat bo'lardi.
 */
export function formatSourceLine(src: ChannelStatsData["source"]): string {
  const parts: string[] = [];
  if (src.bot) parts.push(`🤖 Bot <b>${src.bot}</b>`);
  if (src.link) parts.push(`🔗 Havola <b>${src.link}</b>`);
  if (src.request) parts.push(`📋 So'rov <b>${src.request}</b>`);
  if (src.folder) parts.push(`📁 Papka <b>${src.folder}</b>`);
  if (src.unknown) parts.push(`❔ Noma'lum <b>${src.unknown}</b>`);
  return parts.length > 0 ? parts.join(" · ") : "—";
}

/** Panel matnini sof quruvchi. Alohida export — vitest'da Telegram/DB siz test qilish mumkin. */
export function buildChannelStatsPanel(c: Channel, s: ChannelStatsData): string {
  // Username bo'lsa u "Tur" yonida, bitta qatorda va BOSILADIGAN bo'ladi —
  // manzil AYNAN `t.me/<username>` (tracking havolasi emas): u hech qachon
  // eskirmaydi va bekor qilib bo'lmaydi.
  //
  // DIQQAT: bu panelni yuboradigan `editMessageText` da `link_preview_options`
  // bilan havola oldi ko'rinishi O'CHIRILGAN bo'lishi shart, aks holda Telegram
  // xabar ostiga "Kanalni ko'rish" kartochkasini qo'shib yuboradi.
  const uname = c.username?.replace(/^@/, "");
  const typeLine = uname
    ? `Tur: <b>${TYPE_LABEL[c.type]}</b> · <a href="https://t.me/${encodeURIComponent(uname)}">@${e.escapeHtml(uname)}</a>`
    : `Tur: <b>${TYPE_LABEL[c.type]}</b>`;

  // Username yo'q kanalda havola alohida qatorda qoladi — u uzun va
  // "Tur" yoniga sig'maydi.
  const handleLine = uname ? "" : `\n<code>${e.escapeHtml(c.inviteLink ?? "(havola yo'q)")}</code>`;

  // Nosozlik ENG TEPADA. Bot admin bo'lmasa yoki havola o'lik bo'lsa raqamlar
  // ahamiyatsiz — avval shuni ko'rish kerak.
  const healthBlock =
    s.health && s.health.problems.length > 0
      ? `\n\n🚨 <b>NOSOZLIK:</b>\n` +
        s.health.problems.map((p) => `  • ${p}`).join("\n") +
        (s.health.disabled
          ? `\n  ⛔️ Majburiy obuna vaqtincha o'chirildi — bot ishlashda davom etyapti.` +
            `\n  <i>Tuzatgach o'zi qayta yoqiladi.</i>`
          : "")
      : "";

  const header =
    `<tg-emoji emoji-id="${BE.channel}">📢</tg-emoji> <b>${e.escapeHtml(c.title)}</b>\n` +
    typeLine +
    handleLine +
    `\nMajburiy obuna: <b>${c.isActive ? "🟢 Yoqilgan" : "🔴 O'chirilgan"}</b>` +
    healthBlock;

  // Instagram/boshqa — a'zolik API orqali tekshirilmaydi (sintetik salbiy chatId
  // uchun chat_member hech qachon kelmaydi) → ma'nosiz "0" statistika emas.
  if (c.type === "INSTAGRAM") {
    return `${header}\n\n<b>📊 Statistikalar:</b> —`;
  }

  // Tracking havolasi bo'lmasa statistika faqat darvoza sessiyasiga tayanadi —
  // buni admin bilib tursin (odatda botda "havola orqali taklif" huquqi yo'q).
  const linkLine = c.botInviteLink
    ? `\n🔗 Tracking havolasi: <code>${e.escapeHtml(c.botInviteLink)}</code>`
    : `\n⚠️ Tracking havolasi yo'q — "♻️ Yangi havola" tugmasini bosing.`;

  // Havola kesimi qisqacha: havola bir necha marta yangilangan bo'lsa, admin
  // shu yerdan bilib, to'liq taqsimotni "🔗 Havolalar" ekranida ko'radi.
  const linkStatsLine = s.links
    ? `\n🧷 Havolalar: <b>${s.links.count}</b> ta · joriy havola orqali: <b>` +
      `${c.type === "REQUEST" ? s.links.currentRequests : s.links.currentJoined}</b>`
    : "";

  // "Bot orqali" raqamining DALIL kesimi — bitta qatorda. Ikki yo'l bir xil
  // yorliq oladi, lekin ishonchliligi teng emas, shuning uchun ajratiladi.
  //
  // Uchalasi nol bo'lsa qator UMUMAN chiqmaydi: "✅ 0 · 🤔 0 · ❔ 0" hech narsa
  // aytmaydi, faqat panelni cho'zadi (yangi kanalda aynan shunday bo'ladi).
  const hasSignal =
    !!s.botSignal && s.botSignal.byLink + s.botSignal.byGate + s.botSignal.legacy > 0;
  const signalLine =
    hasSignal && s.botSignal
      ? `\n🔬 Dalil: ✅ <b>${s.botSignal.byLink}</b> havola · ` +
        `🤔 <b>${s.botSignal.byGate}</b> taxmin · ❔ <b>${s.botSignal.legacy}</b> eski`
      : "";

  // Barcha uzun tushuntirishlar — bitta yig'iladigan blokda, panel oxirida.
  // Faqat tegishlisi qo'shiladi: nol raqam haqida izoh keraksiz shovqin.
  const hints: string[] = [];
  if (hasSignal) {
    hints.push(
      `<b>Dalil kesimi.</b> «Havola» — Telegram aynan bot havolasini qaytargan, ` +
        `bu qat'iy dalil. «Taxmin» — Telegram havolani aytmagan (odam ommaviy ` +
        `kanalga @username yoki qidiruv orqali kirgan), lekin unga shu kanal ` +
        `oxirgi 30 daqiqada majburiy obuna sifatida ko'rsatilgan: bunday odam ` +
        `kanalni o'zi topib qo'shilgan bo'lishi ham mumkin. «Eski» — havola ` +
        `kuzatuvi boshlanishidan avvalgi yozuvlar, qaysi yo'l bilan kelgani ` +
        `umuman ma'lum emas.`
    );
  }
  if (s.source.unknown > 0) {
    hints.push(
      `<b>Noma'lum manba.</b> Telegram qo'shilish yo'lini aytmagan, yoki yozuv ` +
        `kuzatuv boshlanishidan oldin qilingan.`
    );
  }
  if (s.links && s.links.count > 1) {
    hints.push(`<b>Eski havolalar</b> kesimi «🔗 Havolalar» tugmasida.`);
  }

  // SO'ROVLI KANAL — butunlay boshqa hisob.
  //
  // Darvoza `pending` zayifkani "obuna" deb hisoblaydi va odamni o'tkazadi
  // (bu ATAYLAB shunday: zayifkalar to'planib, egasi xohlagan paytda ommaviy
  // tasdiqlaydi). Demak odam guruhga KIRMAGAN — navbatda turibdi. Shuning
  // uchun "qo'shilgan odamlar" raqami bu yerda noto'g'ri bo'lardi.
  //
  // Asosiy metrika — ZAYIFKA soni: u butun oqimni qamraydi. `ChannelEvent`
  // atributsiyasi esa faqat 2026-08-09 dan beri ishlaydi, ya'ni undan oldingi
  // zayifkalar "bot" deb belgilanmagan — shuning uchun u yordamchi raqam.
  if (c.type === "REQUEST" && s.req) {
    const r = s.req;
    hints.unshift(
      `<b>Zayifka</b> yuborgan odam guruhga hali KIRMAGAN — tasdiqlashni kutyapti. ` +
        `«Kuzatuv tasdiqlagan» faqat 09.08.2026 dan beri yozilyapti, shuning uchun ` +
        `jami zayifkadan kam ko'rinadi.`
    );
    return (
      `${header}\n\n` +
      `<b>📨 Zayifkalar (bot darvozasi orqali):</b>\n` +
      `  Bugun: <b>${r.today}</b> · 7 kun: <b>${r.week}</b> · ` +
      `30 kun: <b>${r.month}</b> · Jami: <b>${r.total}</b>\n` +
      `⏳ Navbatda: <b>${s.reqPending}</b> · ✅ Tasdiqlangan: <b>${r.approved}</b>\n` +
      `👥 A'zolar (Telegram): <b>${s.memberCount ?? "—"}</b> · ` +
      `🤖 Kuzatuv tasdiqlagan: <b>${s.botTotal}</b>` +
      signalLine +
      linkLine +
      linkStatsLine +
      foldedHints(hints)
    );
  }

  return (
    `${header}\n\n` +
    `<b>📊 Bot orqali qo'shilgan yagona odamlar:</b>\n` +
    `  Bugun: <b>${s.botToday}</b> · 7 kun: <b>${s.botWeek}</b> · ` +
    `30 kun: <b>${s.botMonth}</b> · Jami: <b>${s.botTotal}</b>\n` +
    `👥 A'zolar (Telegram): <b>${s.memberCount ?? "—"}</b> · ` +
    `🤖 Bot orqali hozir a'zoda: <b>${s.currentBot}</b>\n` +
    `🧭 Manba: ${formatSourceLine(s.source)}` +
    signalLine +
    linkLine +
    linkStatsLine +
    foldedHints(hints)
  );
}

async function renderChannelDetail(ctx: MyContext, id: number, opts: { recheck?: boolean } = {}) {
  const c = await prisma.channel.findUnique({ where: { id } });
  if (!c) {
    await ctx.answerCallbackQuery({ text: "Kanal topilmadi.", show_alert: true });
    return;
  }

  // Sog'liq: odatda davriy sweep keshidan olinadi (panel tez ochilsin).
  // "🔄 Yangilash" bosilganda yangidan tekshiriladi.
  const rawHealth = opts.recheck
    ? await checkChannelHealth(ctx.api, c, ctx.me.id, { act: true })
    : getCachedHealth(c.chatId);
  const health = rawHealth
    ? { problems: rawHealth.problems.map((p) => PROBLEM_LABEL[p]), disabled: rawHealth.disabled }
    : undefined;

  // INSTAGRAM: statistika umuman hisoblanmaydi (ma'nosiz "0" ko'rinmasin).
  let statsData: ChannelStatsData = {
    botToday: 0,
    botWeek: 0,
    botMonth: 0,
    botTotal: 0,
    currentBot: 0,
    memberCount: null,
    reqPending: 0,
    source: { bot: 0, link: 0, request: 0, folder: 0, unknown: 0 },
    req: undefined,
  };

  if (c.type !== "INSTAGRAM") {
    // Barcha oynalar Toshkent vaqti (UTC+5), kalendar kunlar:
    // Bugun = shu kun 00:00, 7 kun = bugun bilan 7 kun (6 kun oldin), 30 kun = 29 kun oldin.
    const today = daysAgoStartUz(0);
    const week = daysAgoStartUz(6);
    const month = daysAgoStartUz(29);

    const [
      botToday,
      botWeek,
      botMonth,
      botTotal,
      currentBot,
      memberCount,
      sourceMap,
      reqPending,
      botSignal,
    ] = await Promise.all([
      countDistinctBotJoins(c.chatId, { gte: today }),
      countDistinctBotJoins(c.chatId, { gte: week }),
      countDistinctBotJoins(c.chatId, { gte: month }),
      countDistinctBotJoins(c.chatId, null),
      currentBotMembers(c.chatId),
      getCachedMemberCount(ctx.api, c.chatId),
      countDistinctJoinsBySource(c.chatId, null),
      c.type === "REQUEST"
        ? prisma.joinRequest.count({ where: { channelId: c.chatId, status: "pending" } })
        : Promise.resolve(0),
      countBotJoinsBySignal(c.chatId, null),
    ]);

    // So'rovli kanalda asosiy metrika — zayifka soni (yuqoridagi izohga qarang).
    // `joinRequest.date` bo'yicha, kanal statistikasi bilan bir xil Toshkent oynalari.
    let req: ChannelStatsData["req"];
    if (c.type === "REQUEST") {
      const where = { channelId: c.chatId };
      const [rToday, rWeek, rMonth, rTotal, rApproved] = await Promise.all([
        prisma.joinRequest.count({ where: { ...where, date: { gte: today } } }),
        prisma.joinRequest.count({ where: { ...where, date: { gte: week } } }),
        prisma.joinRequest.count({ where: { ...where, date: { gte: month } } }),
        prisma.joinRequest.count({ where }),
        prisma.joinRequest.count({ where: { ...where, status: "approved" } }),
      ]);
      req = { today: rToday, week: rWeek, month: rMonth, total: rTotal, approved: rApproved };
    }

    // Havola kesimi — qisqacha xulosa (to'liq ro'yxat "🔗 Havolalar" ekranida).
    const linkStats = await collectInviteLinkStats(c.chatId, c.type === "REQUEST");
    const current = linkStats.rows.find((r) => r.isCurrent && r.name === "bot_tracking");

    // `direct` va `unknown` — ikkalasi ham "Telegram/tegishli manba bermagan" degani.
    // Adashtirmaslik uchun bitta "Noma'lum" bucket'ga birlashtiriladi (faqat ko'rsatish).
    statsData = {
      botToday,
      botWeek,
      botMonth,
      botTotal,
      currentBot,
      memberCount,
      reqPending,
      source: mergeSourceBuckets(sourceMap),
      req,
      links: {
        count: linkStats.rows.length,
        currentJoined: current?.joined ?? 0,
        currentRequests: current?.requests ?? 0,
      },
      botSignal,
      health,
    };
  }

  const text = buildChannelStatsPanel(c, statsData);

  const rows: ReturnType<typeof ibtn>[][] = [
    [
      ibtn(
        c.isActive ? "🔴 Majburiy obunani o'chirish" : "🟢 Majburiy obunani yoqish",
        `ch:subtoggle:${c.id}`,
        c.isActive ? "danger" : "success"
      ),
    ],
    [ibtn("✏️ Yorliqni tahrirlash", `ch:editlabel:${c.id}`, "primary")],
  ];
  if (c.type !== "INSTAGRAM") {
    rows.push([
      ibtn("🔄 Yangilash", `ch:refresh:${c.id}`, "primary"),
      ibtn("🔗 Havolalar", `ch:links:${c.id}`, "success"),
    ]);
    rows.push([
      ibtn("♻️ Yangi havola", `ch:newlinkask:${c.id}`, "primary"),
      ibtn("📎 Havolani ulash", `ch:setlink:${c.id}`, "primary"),
    ]);
  }
  if (c.type === "REQUEST") {
    rows.push([ibtn("📋 So'rovlarni boshqarish", "ch:jrstats", "primary")]);
  }
  // O'CHIRISH TUGMASI BU YERDA ATAYLAB YO'Q. Statistikani ko'rish oqimida
  // "danger" tugma yonma-yon turishi tasodifiy bosishga olib keladi. O'chirish
  // faqat "Kanal boshqaruvi → O'chirish" menyusi orqali (ch:del → ch:delconf).
  rows.push([backBtn("ch:list")]);

  await ctx
    .editMessageText(text, {
      // MAJBURIY: panelda `@username` havolasi bor. O'chirilmasa Telegram xabar
      // ostiga kanal kartochkasini ("Kanalni ko'rish") qo'shib yuboradi va
      // panel ikki barobar uzayadi.
      link_preview_options: { is_disabled: true },
      reply_markup: kb(...rows),
    })
    .catch(() => {});
}

channelsHandler.callbackQuery(/^ch:view:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await renderChannelDetail(ctx, Number(ctx.match[1]));
});

// ============ HAVOLALAR KESIMI (eski/yangi havola alohida) ============
async function renderInviteLinks(ctx: MyContext, id: number) {
  const c = await prisma.channel.findUnique({ where: { id } });
  if (!c || c.type === "INSTAGRAM") {
    await ctx.answerCallbackQuery({ text: "Kanal topilmadi.", show_alert: true });
    return;
  }
  // Registrga tushmay qolgan joriy havolani shu yerda tuzatamiz — aks holda u
  // "registrdan tashqari" bo'lib ko'rinardi.
  if (c.botInviteLink) await ensureInviteLinkRegistered(c.chatId, c.botInviteLink, "bot_tracking");
  if (c.inviteLink) await ensureInviteLinkRegistered(c.chatId, c.inviteLink, "majburiy_obuna");

  const stats = await collectInviteLinkStats(c.chatId, c.type === "REQUEST");
  const text = buildInviteLinkPanel(c.title, c.type === "REQUEST", stats);

  await ctx
    .editMessageText(text, {
      link_preview_options: { is_disabled: true },
      // BU EKRANDA HAVOLA ALMASHTIRADIGAN TUGMA YO'Q. Statistikani ko'rish
      // oqimida "Yangilash" yonida turgan "Yangi havola" tasodifan bosiladi va
      // eski havolani o'ldiradi — odamlar "havola yaroqsiz" xabarini oladi.
      reply_markup: kb(
        [ibtn("🔄 Yangilash", `ch:links:${id}`, "primary")],
        [backBtn(`ch:view:${id}`)]
      ),
    })
    .catch(() => {});
}

channelsHandler.callbackQuery(/^ch:links:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await renderInviteLinks(ctx, Number(ctx.match[1]));
});

channelsHandler.callbackQuery(/^ch:refresh:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: "🔄 Tekshirilmoqda..." });
  const id = Number(ctx.match[1]);
  const c = await prisma.channel.findUnique({ where: { id }, select: { chatId: true } });
  if (!c) return;
  // A'zo-soni keshi bypass — Telegram'dan yangi qiymat olinadi.
  clearMemberCount(c.chatId);
  // Sog'liq ham yangidan tekshiriladi (kesh emas) — admin aynan shuni kutadi.
  await renderChannelDetail(ctx, id, { recheck: true });
});

// Har bir kanal uchun alohida majburiy obuna toggle (popup bilan)
channelsHandler.callbackQuery(/^ch:subtoggle:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  const c = await prisma.channel.findUnique({ where: { id } });
  if (!c) {
    await ctx.answerCallbackQuery({ text: "Topilmadi.", show_alert: true });
    return;
  }
  const next = !c.isActive;
  await prisma.channel.update({ where: { id }, data: { isActive: next } });
  // Egasi qo'lda qaror qildi — sog'liq tekshiruvining "biz o'chirgan edik"
  // belgisi olib tashlanadi, aks holda u keyinroq holatni o'zicha qaytarardi.
  await setSetting(`chhealth:off:${c.chatId}`, "");
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
  if (!ch) {
    await ctx.answerCallbackQuery({ text: "Topilmadi.", show_alert: true });
    return;
  }
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

// ============ TRACKING HAVOLASI ============
// Statistika "bot orqali qo'shilgan" ni havolani KIM yaratganiga qarab sanaydi
// (index.ts: creator.id === bot.id), shuning uchun yangi havola yaratilsa ham
// eskisi bilan kelganlar yo'qolmaydi — ikkalasi ham botniki.
//
// Bundan tashqari har bir havola `channel_invite_links` registrida qoladi va
// qo'shilish yozuvlarida aynan qaysi havola ishlatilgani saqlanadi — shu tufayli
// "eski havola orqali qancha, yangisi orqali qancha" ajratib ko'rsatiladi.

/**
 * TASDIQ SO'RAYDI. Havolani almashtirish — qaytarib bo'lmaydigan amal: eski
 * havola Telegram'da o'ladi va uni saqlab qo'ygan/reklamaga joylagan odamlar
 * "havola yaroqsiz" xabarini oladi. Tasdiqsiz tugma tasodifan bosilardi.
 */
channelsHandler.callbackQuery(/^ch:newlinkask:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  const ch = await prisma.channel.findUnique({ where: { id } });
  if (!ch) {
    await ctx.answerCallbackQuery({ text: "Topilmadi.", show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();
  await ctx
    .editMessageText(
      `♻️ <b>${e.escapeHtml(ch.title)}</b> uchun yangi tracking havolasi?\n\n` +
        `⚠️ Hozirgi havola <b>BEKOR QILINADI</b>. Uni saqlab qo'ygan yoki ` +
        `reklamaga joylagan odamlar «havola yaroqsiz» xabarini oladi.\n\n` +
        `Statistikasi yo'qolmaydi — eski havola hisobi «🔗 Havolalar» ekranida qoladi.\n\n` +
        `Havola ishlayotgan bo'lsa — almashtirmang.`,
      {
        reply_markup: kb(
          [ibtn("Ha, yangisini yarat", `ch:newlink:${id}`, "danger")],
          [ibtn("Bekor qilish", `ch:view:${id}`, "success")]
        ),
      }
    )
    .catch(() => {});
});

/** Yangi "bot_tracking" havolasi yaratadi, eskisini bekor qiladi (registrda qoladi) */
channelsHandler.callbackQuery(/^ch:newlink:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  const ch = await prisma.channel.findUnique({ where: { id } });
  if (!ch || ch.type === "INSTAGRAM") {
    await ctx.answerCallbackQuery({ text: "Topilmadi.", show_alert: true });
    return;
  }
  try {
    const link = await ctx.api.createChatInviteLink(Number(ch.chatId), {
      name: "bot_tracking",
      // So'rovli kanalda tasdiqlash navbati saqlanishi shart — izoh
      // getOrCreateBotInviteLink da.
      creates_join_request: ch.type === "REQUEST",
    });
    // Eskisini BEKOR QILAMIZ. Aks holda eski havola tirik qoladi va uni
    // saqlab qo'ygan odamlar o'sha eski qoida bo'yicha kirishda davom etadi
    // (masalan so'rovli kanalga navbatsiz). Statistika yo'qolmaydi — atributsiya
    // havola satri bo'yicha emas, havolani KIM yaratgani bo'yicha ishlaydi.
    if (ch.botInviteLink) {
      await ctx.api.revokeChatInviteLink(Number(ch.chatId), ch.botInviteLink).catch(() => null);
      await markInviteLinkRevoked(ch.botInviteLink);
    }
    await prisma.channel.update({
      where: { id },
      data: { botInviteLink: link.invite_link },
    });
    // Registrga #N bo'lib tushadi — eski qatorlar o'chirilmaydi.
    await registerInviteLink(ch.chatId, link.invite_link, "bot_tracking");
    await ctx.answerCallbackQuery({
      text:
        ch.type === "REQUEST"
          ? "✅ Yangi havola yaratildi (tasdiqlash talab qiladi). Eskisi bekor qilindi — statistikasi saqlanadi."
          : "✅ Yangi havola yaratildi. Eskisi bekor qilindi — statistikasi saqlanadi.",
    });
  } catch (err) {
    await ctx.answerCallbackQuery({
      text: `❌ Yaratib bo'lmadi: ${(err as Error).message}\n\nBotda "Havola orqali taklif qilish" huquqi bormi?`,
      show_alert: true,
    });
    return;
  }
  await renderChannelDetail(ctx, id);
});

/**
 * Mavjud havolani ulash. Ikki xil havola qabul qilinadi:
 *  · BOT yaratgan → `botInviteLink`, to'liq atributsiya ("🤖 Bot" deb sanaladi)
 *  · ADMIN yaratgan → `inviteLink`, darvoza tugmasi shuni beradi, lekin
 *    atributsiya cheklangan: Telegram boshqa admin yaratgan havola satrini
 *    niqoblaydi va `creator.id` bot emas, shuning uchun u orqali kelganlar
 *    "🔗 Havola" bucket'iga tushadi. Bunday havola hisobini egasi Telegram'ning
 *    o'z statistikasida ko'radi.
 */
channelsHandler.callbackQuery(/^ch:setlink:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  const ch = await prisma.channel.findUnique({ where: { id } });
  if (!ch || ch.type === "INSTAGRAM") {
    await ctx.answerCallbackQuery({ text: "Topilmadi.", show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();
  ctx.session.scratch = { setChannelLink: id };
  await ctx.reply(
    `<b>${e.escapeHtml(ch.title)}</b> uchun havolani yuboring.\n\n` +
      `Bot havolasi: <code>${e.escapeHtml(ch.botInviteLink ?? "(yo'q)")}</code>\n` +
      `Zaxira havola: <code>${e.escapeHtml(ch.inviteLink ?? "(yo'q)")}</code>\n\n` +
      `<b>Ikkala xil havola ham bo'ladi:</b>\n` +
      `• <b>Bot yaratgan</b> havola — qo'shilishlar «🤖 Bot orqali» deb aniq sanaladi.\n` +
      `• <b>O'zingiz yaratgan</b> havola — ham ishlaydi, lekin Telegram uni botga ` +
      `niqoblab ko'rsatadi, shuning uchun statistikada «🔗 Havola» deb sanaladi. ` +
      `Uning hisobini Telegram'ning o'zida ko'rasiz.\n\n` +
      `Bot havolangizni qaysi turdaligini o'zi aniqlaydi — shunchaki yuboring.`,
    { reply_markup: kb([ibtn("Bekor qilish", "ch:setlink:cancel", "danger")]) }
  );
});

channelsHandler.callbackQuery("ch:setlink:cancel", async (ctx) => {
  await ctx.answerCallbackQuery({ text: "❌ Bekor qilindi." });
  if (ctx.session.scratch) delete ctx.session.scratch.setChannelLink;
  await refreshMenu(ctx);
});

// ============ KNOPKA SOZLAMALARI ============
channelsHandler.callbackQuery("ch:btnsettings", async (ctx) => {
  await ctx.answerCallbackQuery();
  await renderBtnSettings(ctx);
});

async function renderBtnSettings(ctx: MyContext, edit = true) {
  const btnText = await getSetting(KEYS.subCheckBtnText, "Tekshirish");
  const btnStyle = await getSetting(KEYS.subCheckBtnStyle, "");
  const chLabel = await getSetting(KEYS.subChannelBtnLabel, "+ Kanalga obuna bo'lish");

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
      ibtn("Ko'k", "ch:subbtnsty:primary", "primary"),
      ibtn("Yashil", "ch:subbtnsty:success", "success"),
      ibtn("Qizil", "ch:subbtnsty:danger", "danger"),
      ibtn("Tasodifiy", "ch:subbtnsty:random", "success"),
    ],
    [ibtn("Standartga qaytarish", "ch:subbtnreset", "danger")],
    [backBtn("ch:menu")]
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
    "Yangi \"Tekshirish\" knopkasi matnini yuboring:\n\nMasalan: <code>✅ A'zo bo'ldim</code>",
    { reply_markup: cancelKeyboard() }
  );
});

channelsHandler.callbackQuery(/^ch:subbtnsty:(primary|success|danger|random)$/, async (ctx) => {
  const style = resolveButtonStyle(ctx.match[1]);
  await setSetting(KEYS.subCheckBtnStyle, style);
  await ctx.answerCallbackQuery({ text: `Rang: ${buttonStyleLabel(style)}` });
  await renderBtnSettings(ctx);
});

channelsHandler.callbackQuery("ch:subbtnreset", async (ctx) => {
  await Promise.all([
    setSetting(KEYS.subCheckBtnText, "Tekshirish"),
    setSetting(KEYS.subCheckBtnStyle, ""),
    setSetting(KEYS.subChannelBtnLabel, "+ Kanalga obuna bo'lish"),
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
  await ctx
    .editMessageText(
      `<b>Qaysi turdagi kanal/guruh qo'shasiz?</b>\n\n` +
        `<b>Ommaviy</b> — @username bor. Forward yoki @username bilan ham qo'shish mumkin.\n` +
        `<b>Maxfiy</b> — havola orqali qo'shiladi.\n` +
        `<b>So'rovli</b> — so'rov yuboriladi, taklif havolasi kerak.\n` +
        `<b>Instagram/boshqa</b> — Instagram profil, Telegram bot yoki istalgan boshqa havola. ` +
        `A'zolik TEKSHIRILMAYDI — ro'yxatda ko'rinadi, lekin "Tekshirish"ni bloklamaydi.`,
      {
        reply_markup: kb(
          [
            ibtn("Ommaviy", "ch:type:PUBLIC", "primary", "5260268501515377807"),
            ibtn("Maxfiy", "ch:type:PRIVATE", "success", "5258476306152038031"),
          ],
          [
            ibtn("So'rovli", "ch:type:REQUEST", "danger", "5258419835922030550"),
            ibtn("Instagram/boshqa", "ch:type:INSTAGRAM", "primary", "5258205968025525531"),
          ],
          [backBtn("ch:menu")]
        ),
      }
    )
    .catch(() => {});
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
      request_title: true,
      request_username: true,
    })
    .row()
    .requestChat("👥 Guruhni tanlash", REQ_GROUP, {
      chat_is_channel: false,
      chat_has_username: requirePublic ? true : undefined,
      user_administrator_rights: MIN_RIGHTS,
      bot_administrator_rights: MIN_RIGHTS,
      request_title: true,
      request_username: true,
    })
    .row()
    .text("❌ Bekor qilish")
    .resized()
    .oneTime();

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
    await ctx.reply(
      `❌ Havola yaratib bo'lmadi: ${(err as Error).message}\n\nBotda <b>can_invite_users</b> huquqi borligini tekshiring.`
    );
  }
});

channelsHandler.callbackQuery("ch:cancelinvite", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.scratch = {};
  await refreshMenu(ctx);
});

// ============ BARCHA XABARLARNI USHLAB OLISH ============
channelsHandler.on("message", async (ctx, next) => {
  const hasPending = !!ctx.session.scratch?.pendingRequestChannel;
  const hasAddType = !!ctx.session.scratch?.addChannelType;
  const editLabelId = ctx.session.scratch?.editChannelLabel as number | undefined;
  const editSubBtn = !!ctx.session.scratch?.editSubBtnText;
  const editDefLabel = !!ctx.session.scratch?.editChannelDefLabel;
  const setLinkId = ctx.session.scratch?.setChannelLink as number | undefined;

  // Tracking havolasini qo'lda ulash
  if (setLinkId) {
    if (ctx.message?.chat_shared) return next();
    const msgText = ctx.message?.text?.trim();
    if (!msgText) return next();
    if (msgText === "❌ Bekor qilish" || msgText === "/cancel") {
      ctx.session.scratch = {};
      await ctx.reply("❌ Bekor qilindi.");
      return;
    }
    const ch = await prisma.channel.findUnique({ where: { id: setLinkId } });
    if (!ch) {
      ctx.session.scratch = {};
      await ctx.reply("❌ Kanal topilmadi.");
      return;
    }
    if (!/^https:\/\/t\.me\//i.test(msgText) || msgText.includes("…") || msgText.includes("...")) {
      await ctx.reply(
        "❌ Bu to'liq havolaga o'xshamaydi. <code>https://t.me/+...</code> ko'rinishida, " +
          "qisqartirilmagan holda yuboring."
      );
      return;
    }
    // EGALIKNI ANIQLASH: `editChatInviteLink` faqat BOT yaratgan (va birlamchi
    // bo'lmagan) havolani tahrirlaydi — muvaffaqiyat = havola botniki.
    // Yon ta'siri: havolaga "bot_tracking" nomi qo'yiladi, muddat/a'zo limiti
    // tozalanadi. So'rovli kanalda `creates_join_request` UZATILISHI SHART,
    // aks holda havola tasdiqlash navbatini chetlab o'tadigan bo'lib qoladi.
    const isBotLink = await ctx.api
      .editChatInviteLink(Number(ch.chatId), msgText, {
        name: "bot_tracking",
        creates_join_request: ch.type === "REQUEST",
      })
      .then(() => true)
      .catch(() => false);

    if (isBotLink) {
      if (ch.botInviteLink && ch.botInviteLink !== msgText) {
        await markInviteLinkRevoked(ch.botInviteLink);
      }
      await prisma.channel.update({ where: { id: setLinkId }, data: { botInviteLink: msgText } });
      await registerInviteLink(ch.chatId, msgText, "bot_tracking");
      ctx.session.scratch = {};
      await ctx.reply(
        `${ce("check")} <b>Bot havolasi</b> ulandi:\n<code>${e.escapeHtml(msgText)}</code>\n\n` +
          `Bu havola orqali kelganlar «🤖 Bot orqali» deb aniq sanaladi.`
      );
      return;
    }

    // ADMIN yaratgan havola. Uni ham qabul qilamiz — darvoza tugmasi shuni
    // beradi. Atributsiya cheklangan: Telegram bunday havola satrini niqoblaydi
    // va `creator.id` bot emas, shuning uchun qo'shilishlar "🔗 Havola"
    // bucket'iga tushadi. Havola hisobini egasi Telegram'ning o'zida ko'radi.
    await prisma.channel.update({ where: { id: setLinkId }, data: { inviteLink: msgText } });
    await registerInviteLink(ch.chatId, msgText, "majburiy_obuna");
    ctx.session.scratch = {};
    await ctx.reply(
      `${ce("check")} <b>O'z havolangiz</b> ulandi:\n<code>${e.escapeHtml(msgText)}</code>\n\n` +
        `ℹ️ Bu havolani bot yaratmagan, shuning uchun u orqali kelganlar ` +
        `statistikada «🔗 Havola» deb sanaladi — «🤖 Bot orqali» emas. ` +
        `Aniq hisobni Telegram'ning o'zida (Kanal → Taklif havolalari) ko'rasiz.` +
        (ch.botInviteLink
          ? `\n\n⚠️ Kanalda bot havolasi ham bor va darvoza tugmasi <b>o'shani</b> beradi. ` +
            `Sizning havolangiz faqat bot havolasi bo'lmaganda ishlatiladi.`
          : "")
    );
    return;
  }

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
    await ctx.reply(
      `${ce("check")} Kanal knopka matni saqlandi: <b>${e.escapeHtml(msgText.slice(0, 64))}</b>`
    );
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
    await prisma.channel
      .update({ where: { id: editLabelId }, data: { buttonLabel: newLabel } })
      .catch(() => null);
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
    await ctx.reply(
      `${ce("check")} Knopka matni saqlandi: <b>${e.escapeHtml(msgText.slice(0, 32))}</b>`
    );
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
    if (!msgText) {
      await ctx.reply("❌ Matn yuboring.");
      return;
    }
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
    if (!msgText) {
      await ctx.reply("❌ Havola yuboring.");
      return;
    }
    if (!isValidUrl(msgText)) {
      await ctx.reply(
        "❌ To'g'ri havola emas.\n\nMasalan: <code>https://instagram.com/username</code> yoki <code>https://t.me/botname</code>"
      );
      return;
    }
    const isInstagram = /instagram\.com|instagr\.am/i.test(msgText);
    let title: string;
    if (isInstagram) {
      const username = msgText
        .replace(/https?:\/\/(www\.)?instagram\.com\//i, "")
        .replace(/\/$/, "")
        .split("/")[0];
      title = username ? `Instagram: @${username}` : "Instagram";
    } else {
      title = (() => {
        try {
          return new URL(msgText).hostname.replace(/^www\./, "");
        } catch {
          return "Havola";
        }
      })();
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
    if (!target) {
      await ctx.reply("❌ Havola noto'g'ri.");
      return;
    }
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
  const type = (ctx.session.scratch?.addChannelType as ChannelType) ?? "PUBLIC";
  ctx.session.scratch = {};

  const chatId = shared.chat_id;
  const chat = await ctx.api.getChat(chatId).catch(() => null);
  const title = shared.title ?? (chat && "title" in chat ? chat.title : undefined) ?? "Noma'lum";
  const username =
    shared.username ?? (chat && "username" in chat ? chat.username : undefined) ?? null;

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
    await ctx.reply(`❌ Ommaviy kanal uchun <b>username</b> bo'lishi kerak.`, {
      reply_markup: { remove_keyboard: true },
    });
    const { text, markup } = await channelMenuData();
    await ctx.reply(text, { reply_markup: markup });
    return;
  }

  if (type === "REQUEST") {
    ctx.session.scratch = { pendingRequestChannel: info };
    await ctx.reply(
      `✅ Kanal aniqlandi: <b>${e.escapeHtml(title)}</b>\n\n` +
        `So'rovli kanal uchun <b>join-request havolasi</b> kerak.\n\n` +
        `ℹ️ Bu havola <b>"Apply to join"</b> (qo'shilish so'rovi) turdagi havola bo'lishi kerak.\n` +
        `Telegram'da kanal Sozlamalari → Invite Links → <b>"Request Admin Approval"</b> yoqilgan havola yarating va shu yerga yuboring.\n\n` +
        `Yoki pastdagi tugma orqali bot o'zi yaratsin.`,
      {
        reply_markup: kb(
          [ibtn("🔗 Avtomatik yaratish", "ch:autoinvite", "success", BE.chAdd)],
          [ibtn("❌ Bekor qilish", "ch:cancelinvite", "danger")]
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

  // Limitni YOZISH JOYIDA qayta tekshiramiz — ch:add dagi tekshiruv faqat kirishda.
  // Qo'shish oqimi bir necha qadam (tur tanlash → kanal tanlash) davom etayotganda
  // boshqa kanal qo'shilishi mumkin — TOCTOU orqali limitni chetlab o'tib bo'lmasin.
  const limit = getChannelLimit(ctx.from?.id ?? 0);
  if (limit !== null) {
    const count = await prisma.channel.count();
    if (count >= limit) {
      await ctx.reply(`❌ Siz maksimal <b>${limit}</b> ta kanal qo'sha olasiz. Limit to'ldi.`, {
        reply_markup: { remove_keyboard: true },
      });
      const { text, markup } = await channelMenuData();
      await ctx.reply(text, { reply_markup: markup });
      return;
    }
  }

  // Instagram uchun unikal chatId generatsiya qilish (agar conflict bo'lsa)
  let finalChatId = BigInt(chatId);
  if (type === "INSTAGRAM") {
    const existing = await prisma.channel.findFirst({ where: { type: "INSTAGRAM", inviteLink } });
    if (existing) {
      await ctx.reply(
        `ℹ️ Bu Instagram profil allaqachon qo'shilgan: <b>${e.escapeHtml(existing.title)}</b>`,
        {
          reply_markup: { remove_keyboard: true },
        }
      );
      const { text, markup } = await channelMenuData();
      await ctx.reply(text, { reply_markup: markup });
      return;
    }
    finalChatId = BigInt(-Date.now());
  }

  try {
    await prisma.channel.upsert({
      where: { chatId: finalChatId },
      create: {
        chatId: finalChatId,
        title,
        username,
        inviteLink,
        type,
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

  // QAYTA ULANISH: bu chatId ilgari qo'shilib, keyin o'chirilgan bo'lishi
  // mumkin. `channel_events` o'sha paytdan omon qolgan, `channel_members` esa
  // (eski cascade tufayli) yo'q bo'lishi mumkin — snapshotni jurnaldan
  // tiklaymiz, aks holda panel "hozir a'zo: 0" deb yolg'on ko'rsatadi.
  let restored = 0;
  if (type !== "INSTAGRAM") {
    restored = await rebuildMemberSnapshot(finalChatId);
  }

  // Bot tracking havolasini yaratamiz (INSTAGRAM uchun emas)
  let botInviteLink: string | null = null;
  if (type !== "INSTAGRAM") {
    // Zaxira havola (obuna tugmasi tracking havolasi bo'lmaganda shuni beradi)
    // ham registrga tushsin — u orqali kelganlar ham havola kesimida ko'rinadi.
    if (inviteLink) await registerInviteLink(finalChatId, inviteLink, "majburiy_obuna");
    botInviteLink = await getOrCreateBotInviteLink(ctx, BigInt(chatId));
  }

  await ctx.reply(
    `${ce("check")} <b>Qo'shildi!</b>\n\n<b>${e.escapeHtml(title)}</b>\n` +
      (type === "INSTAGRAM"
        ? `📸 ${e.escapeHtml(inviteLink ?? "")}`
        : username
          ? `@${e.escapeHtml(username)}`
          : inviteLink
            ? e.escapeHtml(inviteLink)
            : "") +
      (botInviteLink ? `\n🔗 Bot tracking: <code>${e.escapeHtml(botInviteLink)}</code>` : "") +
      `\nTur: <b>${type}</b>` +
      (restored > 0
        ? `\n\n♻️ Bu kanal ilgari ham qo'shilgan ekan — <b>${restored}</b> ta a'zolik yozuvi tarixdan tiklandi.`
        : ""),
    { reply_markup: { remove_keyboard: true } }
  );
  const { text, markup } = await channelMenuData();
  await ctx.reply(text, { reply_markup: markup });
}

// ============ O'CHIRISH ============

/**
 * O'chirish ro'yxatini chizadi. Kanal qolmagan bo'lsa `false` qaytaradi.
 *
 * Callback javobini ATAYLAB bermaydi — chaqiruvchi beradi. `ch:delconf`
 * allaqachon `answerCallbackQuery` chaqirgan bo'ladi, ikkinchi marta chaqirish
 * Telegram xatosi.
 */
async function renderDeleteList(ctx: MyContext): Promise<boolean> {
  const channels = await prisma.channel.findMany({ orderBy: { sortOrder: "asc" } });
  if (channels.length === 0) return false;
  const rows = channels.map((c) => [ibtn(c.title, `ch:delconf:${c.id}`, "danger", BE.chDelete)]);
  rows.push([backBtn("ch:menu")]);
  await ctx
    .editMessageText(`<b>Qaysi kanalni o'chirasiz?</b>`, { reply_markup: kb(...rows) })
    .catch(() => {});
  return true;
}

channelsHandler.callbackQuery("ch:del", async (ctx) => {
  const shown = await renderDeleteList(ctx);
  await ctx.answerCallbackQuery(
    shown ? undefined : { text: "O'chirish uchun kanal yo'q.", show_alert: true }
  );
});

channelsHandler.callbackQuery(/^ch:delconf:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  try {
    const ch = await prisma.channel.findUnique({
      where: { id },
      select: { chatId: true, botInviteLink: true },
    });
    // Tracking havolasi kanalda yetim qolmasin: kanal qayta qo'shilsa yangisi
    // yaratiladi va eskisi bilan kirganlar hamon "bot" deb sanaladi (creator
    // bo'yicha), lekin ishlatilmaydigan havolalar to'planib qolishi shart emas.
    // Registrda esa havola O'CHIRILMAYDI — faqat "bekor qilingan" deb
    // belgilanadi, uning statistikasi kanal qayta qo'shilganda ham ko'rinsin.
    if (ch?.botInviteLink) {
      await ctx.api.revokeChatInviteLink(Number(ch.chatId), ch.botInviteLink).catch(() => null);
      await markInviteLinkRevoked(ch.botInviteLink);
    }
    // TARIX SAQLANADI: zayifkalar, a'zolik snapshoti, havolalar registri va
    // hodisalar jurnali `chatId` ga bog'langan va cascade YO'Q — shu chatId
    // qayta qo'shilsa hammasi avtomatik ulanadi (20260813 migratsiyasi).
    await prisma.channel.delete({ where: { id } });
    // O'chirilgan kanalning a'zo-soni keshida eski qiymat qolib ketmasin.
    if (ch) clearMemberCount(ch.chatId);
    await ctx.answerCallbackQuery({
      text: "✅ O'chirildi.\n\nStatistika tarixi saqlanadi — bu kanalni qayta qo'shsangiz raqamlar tiklanadi.",
      show_alert: true,
    });
    // O'CHIRISH OQIMIDA QOLAMIZ: ketma-ket bir necha kanal o'chirish odatiy
    // holat. Ilgari "Kanallar ro'yxati" (statistika) ekraniga o'tib ketardi va
    // davom ettirish uchun har safar menyudan qaytadan kirish kerak bo'lardi.
    // Oxirgi kanal o'chirilsa ro'yxat bo'shaydi — menyuga qaytamiz.
    if (!(await renderDeleteList(ctx))) await refreshMenu(ctx);
  } catch (err) {
    await ctx.answerCallbackQuery({
      text: `❌ O'chirib bo'lmadi: ${(err as Error).message}`,
      show_alert: true,
    });
  }
});
