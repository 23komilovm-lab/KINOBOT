import { Composer } from "grammy";
import type { Conversation } from "@grammyjs/conversations";
import { prisma } from "../../prisma.js";
import { config, adminCan } from "../../config.js";
import { ce, e } from "../../utils/emoji.js";
import { ADMIN_MENU_BUTTONS, ibtn, BE, kb, cancelKeyboard, adminMenuKeyboard } from "../../utils/keyboard.js";
import { isValidUrl, resolveButtonStyle } from "../../utils/contentButton.js";
import { getSetting, setSetting, getGlobalButton, getBool, setBool, KEYS } from "../../utils/settings.js";
import type { MyContext } from "../../types.js";

export const serialsHandler = new Composer<MyContext>();

const CANCEL = "❌ Bekor qilish";
const isCancel = (t?: string) => t === CANCEL || t === "/cancel";
const stop = (ctx: MyContext) =>
  ctx.reply("❌ Bekor qilindi.", {
    reply_markup: adminMenuKeyboard(ctx.from?.id),
  });

function serialMenu() {
  return kb(
    [ibtn("Serial qo'shish", "sr:add", "success", BE.chAdd), ibtn("Qism qo'shish", "sr:addep", "success", BE.movie)],
    [ibtn("Ro'yxat", "sr:list", "primary", BE.chList), ibtn("O'chirish", "sr:dellist", "danger", BE.chDelete)],
    [ibtn("Knopka boshqaruvi", "sr:btnlist:0")],
    [ibtn("Menyuga qaytish", "sr:close", undefined, BE.backMenu)]
  );
}

serialsHandler.hears(ADMIN_MENU_BUTTONS.serials, async (ctx) => {
  if (!adminCan(ctx.from?.id ?? 0, "serials")) return;
  const count = await prisma.serial.count();
  await ctx.reply(
    `<tg-emoji emoji-id="${BE.serial}">📺</tg-emoji> <b>Serial boshqaruvi</b>\n\n` +
      `Seriallar soni: <b>${count}</b>`,
    { reply_markup: serialMenu() }
  );
});

serialsHandler.callbackQuery("sr:close", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.deleteMessage().catch(() => {});
  await ctx.reply("Admin panel:", {
    reply_markup: adminMenuKeyboard(ctx.from.id),
  });
});

// ============ SERIAL QO'SHISH ============
serialsHandler.callbackQuery("sr:add", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.conversation.enter("addSerial");
});

export async function addSerial(conversation: Conversation<MyContext>, ctx: MyContext) {
  await ctx.reply(
    `${ce("tv")} <b>Yangi serial</b>\n\n1️⃣ Serial uchun <b>kod</b> (raqam) kiriting.`,
    { reply_markup: cancelKeyboard() }
  );

  let code = 0;
  while (true) {
    const c = await conversation.wait();
    if (isCancel(c.message?.text)) return stop(c);
    const t = c.message?.text?.trim() ?? "";
    if (!/^\d+$/.test(t)) {
      await c.reply("❌ Faqat raqam kiriting.");
      continue;
    }
    code = Number(t);
    const exists = await conversation.external(() =>
      prisma.serial.findUnique({ where: { code } })
    );
    if (exists) {
      await c.reply("⚠️ Bu kod band.");
      continue;
    }
    break;
  }

  await ctx.reply("2️⃣ Serial <b>nomini</b> kiriting.");
  const titleCtx = await conversation.wait();
  if (isCancel(titleCtx.message?.text)) return stop(titleCtx);
  const title = titleCtx.message?.text?.trim() || "Nomsiz";

  await ctx.reply("3️⃣ Tavsif/yili — ixtiyoriy. Kerak bo'lmasa <code>-</code>.");
  const capCtx = await conversation.wait();
  if (isCancel(capCtx.message?.text)) return stop(capCtx);
  const cap = capCtx.message?.text?.trim() ?? "-";

  const serial = await conversation.external(() =>
    prisma.serial.create({
      data: { code, title, caption: cap === "-" ? null : cap },
    })
  );

  await ctx.reply(
    `${ce("check")} Serial qo'shildi: <b>${e.escapeHtml(serial.title)}</b> (kod <code>${serial.code}</code>)\n` +
      `Endi "🎞 Qism qo'shish" orqali sezon va qismlarni qo'shing.`,
    { reply_markup: adminMenuKeyboard(ctx.from?.id) }
  );
}

// ============ QISM QO'SHISH ============
serialsHandler.callbackQuery("sr:addep", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.conversation.enter("addEpisode");
});

export async function addEpisode(conversation: Conversation<MyContext>, ctx: MyContext) {
  // ── 1️⃣ Serialni TUGMA orqali tanlash ──
  const serials = await conversation.external(() =>
    prisma.serial.findMany({
      orderBy: { createdAt: "desc" },
      select: { id: true, code: true, title: true },
    })
  );

  if (serials.length === 0) {
    return ctx.reply("📭 Hozircha serial yo'q. Avval <b>Serial qo'shish</b> orqali serial qo'shing.", {
      reply_markup: adminMenuKeyboard(ctx.from?.id),
    });
  }

  const serialRows = serials.map((s) => [
    ibtn(`${s.code} · ${s.title}`.slice(0, 60), `ep:s:${s.id}`, "primary", BE.serial),
  ]);
  serialRows.push([ibtn("❌ Bekor qilish", "ep:cancel", "danger")]);

  await ctx.reply(`🎞 <b>Qism qo'shish</b>\n\n1️⃣ Qaysi serialga qo'shamiz?`, {
    reply_markup: kb(...serialRows),
  });

  const sPick = await conversation.waitForCallbackQuery(/^ep:(s:\d+|cancel)$/);
  await sPick.answerCallbackQuery();
  if (sPick.callbackQuery.data === "ep:cancel") return stop(sPick);

  const serialId = Number(sPick.callbackQuery.data.split(":")[2]);
  const serial = serials.find((s) => s.id === serialId)!;
  const serialTitle = serial.title;

  // ── 2️⃣ Sezonni TUGMA orqali tanlash (yoki yangi qo'shish) ──
  const seasons = await conversation.external(() =>
    prisma.season.findMany({
      where: { serialId },
      orderBy: { number: "asc" },
      select: { number: true, _count: { select: { episodes: true } } },
    })
  );

  const seasonRows = seasons.map((s) => [
    ibtn(`${s.number}-sezon (${s._count.episodes} qism)`, `ep:se:${s.number}`, "primary", BE.folder),
  ]);
  const nextSeason = seasons.length ? Math.max(...seasons.map((s) => s.number)) + 1 : 1;
  seasonRows.push([ibtn(`➕ Yangi sezon (${nextSeason})`, `ep:se:${nextSeason}`, "success", BE.chAdd)]);
  seasonRows.push([ibtn("❌ Bekor qilish", "ep:cancel", "danger")]);

  await ctx.reply(
    `<b>${e.escapeHtml(serialTitle)}</b>\n\n2️⃣ Qaysi sezon?` +
    (seasons.length === 0 ? `\n\n<i>Hozircha sezon yo'q — yangi sezon qo'shiladi.</i>` : ""),
    { reply_markup: kb(...seasonRows) }
  );

  const sePick = await conversation.waitForCallbackQuery(/^ep:(se:\d+|cancel)$/);
  await sePick.answerCallbackQuery();
  if (sePick.callbackQuery.data === "ep:cancel") return stop(sePick);

  const seasonNum = Number(sePick.callbackQuery.data.split(":")[2]);

  // ── 3️⃣ Qism raqami — keyingisi avtomatik taklif qilinadi ──
  const lastEp = await conversation.external(() =>
    prisma.episode.findFirst({
      where: { season: { serialId, number: seasonNum } },
      orderBy: { number: "desc" },
      select: { number: true },
    })
  );
  const suggested = (lastEp?.number ?? 0) + 1;

  await ctx.reply(
    `<b>${e.escapeHtml(serialTitle)}</b> — ${seasonNum}-sezon\n\n` +
    `3️⃣ <b>Qism</b> raqami: keyingisi <b>${suggested}</b>.\n\n` +
    `Shu bo'lsa <code>+</code> deb yuboring, yoki boshqa raqam yozing.`,
    { reply_markup: cancelKeyboard() }
  );

  let epNum = 0;
  while (true) {
    const c = await conversation.wait();
    if (isCancel(c.message?.text)) return stop(c);
    const t = c.message?.text?.trim() ?? "";
    if (t === "+") { epNum = suggested; break; }
    if (!/^\d+$/.test(t)) {
      await c.reply(`❌ Faqat raqam, yoki <code>+</code> (${suggested}-qism uchun).`);
      continue;
    }
    epNum = Number(t);
    break;
  }

  await ctx.reply(`4️⃣ Endi <b>${seasonNum}-sezon ${epNum}-qism</b> videosini yuboring.`);
  const vidCtx = await conversation.wait();
  if (isCancel(vidCtx.message?.text)) return stop(vidCtx);
  const video = vidCtx.message?.video;
  if (!video) {
    await vidCtx.reply("❌ Bu video emas.", {
      reply_markup: adminMenuKeyboard(vidCtx.from?.id),
    });
    return;
  }
  const fileId = video.file_id;

  // baza kanalga tashlash
  let baseMsgId: number | null = null;
  if (config.baseChannelId) {
    try {
      const sent = await ctx.api.sendVideo(config.baseChannelId, fileId, {
        caption: `#serial ${e.escapeHtml(serialTitle)} · S${seasonNum}E${epNum}`,
      });
      baseMsgId = sent.message_id;
    } catch {
      /* ignore */
    }
  }

  // sezon + qismni saqlash
  const result = await conversation.external(async () => {
    const season = await prisma.season.upsert({
      where: { serialId_number: { serialId, number: seasonNum } },
      create: { serialId, number: seasonNum },
      update: {},
    });
    return prisma.episode.upsert({
      where: { seasonId_number: { seasonId: season.id, number: epNum } },
      create: { seasonId: season.id, number: epNum, fileId, baseMsgId },
      update: { fileId, baseMsgId },
    });
  });

  await ctx.reply(
    `${ce("check")} Qism saqlandi: <b>${e.escapeHtml(serialTitle)}</b> — ${seasonNum}-sezon, ${result.number}-qism.`,
    { reply_markup: adminMenuKeyboard(ctx.from?.id) }
  );
  // Ketma-ket qism qo'shish uchun tezkor tugma
  await ctx.reply("Yana qism qo'shasizmi?", {
    reply_markup: kb(
      [ibtn("➕ Yana qism qo'shish", "sr:addep", "success", BE.chAdd)],
      [ibtn("🎞 Serial bo'limi", "sr:back", "primary", BE.backMenu)],
    ),
  });
}

// ============ RO'YXAT ============
serialsHandler.callbackQuery("sr:list", async (ctx) => {
  await ctx.answerCallbackQuery();
  const serials = await prisma.serial.findMany({
    orderBy: { code: "asc" },
    include: { _count: { select: { seasons: true } }, seasons: { include: { _count: { select: { episodes: true } } } } },
  });
  if (serials.length === 0) {
    await ctx.editMessageText("📭 Serial yo'q.", { reply_markup: serialMenu() }).catch(() => {});
    return;
  }
  const rows = serials.map((s) => {
    const eps = s.seasons.reduce((a, x) => a + x._count.episodes, 0);
    return [ibtn(`${s.code} · ${s.title} · ${s._count.seasons} sezon, ${eps} qism`, `sr:view:${s.id}`, "primary", BE.serial)];
  });
  rows.push([ibtn("Orqaga", "sr:back", undefined, BE.home)]);
  await ctx.editMessageText(
    `${ce("list")} <b>Seriallar:</b>\n\nSerialni tanlang:`,
    { reply_markup: kb(...rows) }
  ).catch(() => {});
});

serialsHandler.callbackQuery(/^sr:view:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const serial = await prisma.serial.findUnique({
    where: { id: Number(ctx.match[1]) },
    include: { seasons: { include: { _count: { select: { episodes: true } } } } },
  });
  if (!serial) return;
  const eps = serial.seasons.reduce((a, x) => a + x._count.episodes, 0);
  await ctx.editMessageText(
    `<tg-emoji emoji-id="${BE.serial}">📺</tg-emoji> <b>${e.escapeHtml(serial.title)}</b>\n` +
      `Kod: <code>${serial.code}</code>\n` +
      `Sezonlar: <b>${serial.seasons.length}</b>\n` +
      `Qismlar: <b>${eps}</b>`,
    {
      reply_markup: kb(
        [ibtn("Knopkani tahrirlash", "sr:btnlist:0", "primary", BE.editName)],
        [ibtn("Orqaga", "sr:list", undefined, BE.home)]
      ),
    }
  ).catch(() => {});
});

serialsHandler.callbackQuery("sr:back", async (ctx) => {
  await ctx.answerCallbackQuery();
  const count = await prisma.serial.count();
  await ctx
    .editMessageText(
      `<tg-emoji emoji-id="${BE.serial}">📺</tg-emoji> <b>Serial boshqaruvi</b>\n\n` +
        `Seriallar soni: <b>${count}</b>`,
      { reply_markup: serialMenu() }
    )
    .catch(() => {});
});

serialsHandler.callbackQuery(/^sr:btnlist:\d+$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await renderGlobalSerialButtonEditor(ctx);
});

async function renderGlobalSerialButtonEditor(ctx: MyContext, edit = true) {
  const btn     = await getGlobalButton("serial");
  const enabled = await getBool(KEYS.serialBtnEnabled, true);
  const status  = btn.buttonUrl
    ? `Nom: <b>${e.escapeHtml(btn.buttonText ?? "Ko'rish")}</b>\nHavola: ${e.escapeHtml(btn.buttonUrl)}\nRang: <b>${btn.buttonStyle}</b>`
    : "Knopka hali sozlanmagan.";

  const text =
    `<tg-emoji emoji-id="${BE.serial}">📺</tg-emoji> <b>Serial uchun global knopka</b>\n\n` +
    `Holat: <b>${enabled ? "Yoqilgan" : "O'chirilgan"}</b>\n` +
    `${status}\n\n<i>Bu knopka barcha seriallarda ko'rinadi.</i>`;

  const reply_markup = kb(
    [
      ibtn(
        enabled ? "🟢 Yoqilgan — O'chirish" : "🔴 O'chirilgan — Yoqish",
        "sr:gbtntoggle",
        enabled ? "success" : "danger"
      ),
    ],
    [
      ibtn("Nomni o'zgartirish",    "sr:gbtntext",   "primary", BE.editName),
      ibtn("Havolani o'zgartirish", "sr:gbtnurl",    "primary", BE.editUrl),
    ],
    [
      ibtn("🎨 Rangni tanlash", "sr:gbtncolors", "primary"),
      ibtn("O'chirish",          "sr:gbtnclear",  "danger", BE.chDelete),
    ],
    [ibtn("Orqaga", "sr:back", undefined, BE.backMenu)],
  );

  if (edit) {
    await ctx.editMessageText(text, { reply_markup }).catch(() => {});
  } else {
    await ctx.reply(text, { reply_markup });
  }
}

serialsHandler.callbackQuery("sr:gbtncolors", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    "🎨 <b>Knopka rangini tanlang:</b>",
    {
      reply_markup: kb(
        [
          ibtn("Ko'k",   "sr:gbtnsty:primary", "primary"),
          ibtn("Yashil", "sr:gbtnsty:success", "success"),
          ibtn("Qizil",  "sr:gbtnsty:danger",  "danger"),
          ibtn("Random", "sr:gbtnsty:random",  "success"),
        ],
        [ibtn("Orqaga", "sr:btnlist:0", undefined, BE.backMenu)],
      ),
    }
  ).catch(() => {});
});

serialsHandler.callbackQuery("sr:gbtntoggle", async (ctx) => {
  const cur = await getBool(KEYS.serialBtnEnabled, true);
  await setBool(KEYS.serialBtnEnabled, !cur);
  await ctx.answerCallbackQuery({ text: !cur ? "✅ Knopka yoqildi" : "❌ Knopka o'chirildi", show_alert: true });
  await renderGlobalSerialButtonEditor(ctx);
});

serialsHandler.callbackQuery("sr:gbtntext", async (ctx) => {
  ctx.session.scratch = { ...(ctx.session.scratch ?? {}), serialBtnField: "text" };
  await ctx.answerCallbackQuery();
  await ctx.reply("Yangi knopka nomini yuboring. Masalan: <code>Tomosha qilish</code>");
});

serialsHandler.callbackQuery("sr:gbtnurl", async (ctx) => {
  ctx.session.scratch = { ...(ctx.session.scratch ?? {}), serialBtnField: "url" };
  await ctx.answerCallbackQuery();
  await ctx.reply("Knopka havolasini yuboring. Masalan: <code>https://t.me/kanal</code>");
});

serialsHandler.callbackQuery(/^sr:gbtnsty:(primary|success|danger|random)$/, async (ctx) => {
  const style = resolveButtonStyle(ctx.match[1]);
  await setSetting(KEYS.serialBtnStyle, style);
  await ctx.answerCallbackQuery({ text: `Rang: ${style}` });
  await renderGlobalSerialButtonEditor(ctx);
});

serialsHandler.callbackQuery("sr:gbtnclear", async (ctx) => {
  await Promise.all([
    setSetting(KEYS.serialBtnText, ""),
    setSetting(KEYS.serialBtnUrl, ""),
    setSetting(KEYS.serialBtnStyle, "primary"),
  ]);
  await ctx.answerCallbackQuery({ text: "Knopka o'chirildi." });
  await renderGlobalSerialButtonEditor(ctx);
});

serialsHandler.on("message:text", async (ctx, next) => {
  const field = ctx.session.scratch?.serialBtnField as string | undefined;
  if (!field) return next();

  const text = ctx.message.text.trim();
  if (isCancel(text)) {
    if (ctx.session.scratch) delete ctx.session.scratch.serialBtnField;
    await ctx.reply("❌ Bekor qilindi.");
    return;
  }

  if (field === "text") {
    await setSetting(KEYS.serialBtnText, text.slice(0, 64));
    if (ctx.session.scratch) delete ctx.session.scratch.serialBtnField;
    await ctx.reply(`${ce("check")} Knopka nomi saqlandi.`);
    await renderGlobalSerialButtonEditor(ctx, false);
    return;
  }

  if (!isValidUrl(text)) {
    await ctx.reply("❌ Havola <code>http://</code> yoki <code>https://</code> bilan boshlanishi kerak.");
    return;
  }

  await setSetting(KEYS.serialBtnUrl, text);
  const currentName = await getSetting(KEYS.serialBtnText);
  if (!currentName) await setSetting(KEYS.serialBtnText, "Ko'rish");
  if (ctx.session.scratch) delete ctx.session.scratch.serialBtnField;
  await ctx.reply(`${ce("check")} Knopka havolasi saqlandi.`);
  await renderGlobalSerialButtonEditor(ctx, false);
});

// ============ O'CHIRISH ============
serialsHandler.callbackQuery("sr:dellist", async (ctx) => {
  await ctx.answerCallbackQuery();
  const serials = await prisma.serial.findMany({ orderBy: { code: "asc" } });
  if (serials.length === 0) {
    await ctx.editMessageText("📭 Serial yo'q.", { reply_markup: serialMenu() }).catch(() => {});
    return;
  }
  const rows = serials.map((s) => [ibtn(`🗑 ${s.code} · ${s.title}`, `sr:delconf:${s.id}`, "danger")]);
  rows.push([ibtn("Orqaga", "sr:back", undefined, BE.home)]);

  await ctx.editMessageText("🗑 Qaysi serialni o'chirasiz? (barcha sezon/qismlari bilan)", {
    reply_markup: kb(...rows),
  }).catch(() => {});
});

serialsHandler.callbackQuery(/^sr:delconf:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  await prisma.serial.delete({ where: { id } }).catch(() => {});
  await ctx.answerCallbackQuery({ text: "🗑 O'chirildi" });
  await ctx.editMessageText("🗑 Serial o'chirildi.").catch(() => {});
});
