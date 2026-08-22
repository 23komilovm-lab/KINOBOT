import { Composer } from "grammy";
import type { Conversation } from "@grammyjs/conversations";
import { bot } from "../../bot.js";
import { prisma } from "../../prisma.js";
import { config, adminCan } from "../../config.js";
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
import { buttonStyleLabel, isValidUrl, resolveButtonStyle } from "../../utils/contentButton.js";
import {
  getSetting,
  setSetting,
  getGlobalButton,
  getBool,
  setBool,
  KEYS,
} from "../../utils/settings.js";
import { normalizeTitle } from "../../utils/translit.js";
import { describeError } from "../../services/movieChannel.js";
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
    [
      ibtn("Serial qo'shish", "sr:add", "success", BE.chAdd),
      // Qism — serial tushunchasi, film emojisi emas
      ibtn("Qism qo'shish", "sr:addep", "success", BE.serial),
    ],
    [
      ibtn("Ro'yxat", "sr:list:0", "primary", BE.chList),
      ibtn("O'chirish", "sr:del:0", "danger", BE.chDelete),
    ],
    [ibtn("Knopka boshqaruvi", "sr:btnlist:0")],
    [homeBtn("sr:close")]
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
  // Panel xabari olib tashlanadi — izoh `movies.ts` dagi `mv:add` da.
  await ctx.deleteMessage().catch(() => {});
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
    const exists = await conversation.external(() => prisma.serial.findUnique({ where: { code } }));
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
      data: { code, title, caption: cap === "-" ? null : cap, titleNorm: normalizeTitle(title) },
    })
  );

  await ctx.reply(
    `${ce("check")} Serial qo'shildi: <b>${e.escapeHtml(serial.title)}</b> (kod <code>${serial.code}</code>)\n` +
      `Endi "🎞 Qism qo'shish" orqali qismlarni qo'shing.`,
    { reply_markup: adminMenuKeyboard(ctx.from?.id) }
  );
}

// ============ QISM QO'SHISH ============
serialsHandler.callbackQuery("sr:addep", async (ctx) => {
  await ctx.answerCallbackQuery();
  // Panel xabari olib tashlanadi — izoh `movies.ts` dagi `mv:add` da.
  await ctx.deleteMessage().catch(() => {});
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
    return ctx.reply(
      "📭 Hozircha serial yo'q. Avval <b>Serial qo'shish</b> orqali serial qo'shing.",
      {
        reply_markup: adminMenuKeyboard(ctx.from?.id),
      }
    );
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

  // Sezon alohida tanlanmaydi — barcha yangi qismlar 1-sezonga yoziladi.
  const seasonNum = 1;

  // ── 2️⃣ Qism raqami — keyingisi avtomatik taklif qilinadi ──
  const lastEp = await conversation.external(() =>
    prisma.episode.findFirst({
      where: { season: { serialId, number: seasonNum } },
      orderBy: { number: "desc" },
      select: { number: true },
    })
  );
  const suggested = (lastEp?.number ?? 0) + 1;

  await ctx.reply(
    `<b>${e.escapeHtml(serialTitle)}</b>\n\n` +
      `2️⃣ <b>Qism</b> raqami: keyingisi <b>${suggested}</b>.\n\n` +
      `Shu bo'lsa <code>+</code> deb yuboring, yoki boshqa raqam yozing.`,
    { reply_markup: cancelKeyboard() }
  );

  let epNum = 0;
  while (true) {
    const c = await conversation.wait();
    if (isCancel(c.message?.text)) return stop(c);
    const t = c.message?.text?.trim() ?? "";
    if (t === "+") {
      epNum = suggested;
      break;
    }
    if (!/^\d+$/.test(t)) {
      await c.reply(`❌ Faqat raqam, yoki <code>+</code> (${suggested}-qism uchun).`);
      continue;
    }
    epNum = Number(t);
    break;
  }

  await ctx.reply(`3️⃣ Endi <b>${epNum}-qism</b> videosini yuboring.`);
  // Video o'rniga boshqa kontent kelsa qo'shish BOSHLANGANCHA bekor bo'lmasin —
  // qayta so'raladi, faqat aniq cancel'da tugaydi.
  let fileId = "";
  while (!fileId) {
    const vidCtx = await conversation.wait();
    if (isCancel(vidCtx.message?.text)) return stop(vidCtx);
    const video = vidCtx.message?.video;
    if (!video) {
      await vidCtx.reply(
        `❌ Bu video emas. Video yuboring (bekor qilish uchun — "❌ Bekor qilish").`
      );
      continue;
    }
    fileId = video.file_id;
  }

  // Sezonni topish/yratish (takroriy raqam tekshiruvi uchun alohida)
  const season = await conversation.external(() =>
    prisma.season.upsert({
      where: { serialId_number: { serialId, number: seasonNum } },
      create: { serialId, number: seasonNum },
      update: {},
    })
  );

  // Takroriy qism raqami — eski video jimgina ustiga yozilmasin. Eski video
  // va baza-kanal posti yo'qolishini admin tushunib "+" bilan tasdiqlaydi.
  const existingEp = await conversation.external(() =>
    prisma.episode.findUnique({
      where: { seasonId_number: { seasonId: season.id, number: epNum } },
      select: { id: true },
    })
  );
  if (existingEp) {
    await ctx.reply(
      `⚠️ <b>${seasonNum}-sezon ${epNum}-qism</b> allaqachon bor. ` +
        `Uni yangi video bilan almashtirish uchun <code>+</code> yuboring.`,
      { reply_markup: cancelKeyboard() }
    );
    while (true) {
      const c = await conversation.wait();
      if (isCancel(c.message?.text)) return stop(c);
      if ((c.message?.text?.trim() ?? "") === "+") break;
      await c.reply(
        "Almashtirish uchun <code>+</code> yuboring, bekor qilish uchun <code>❌ Bekor qilish</code>."
      );
    }
  }

  // baza kanalga tashlash — xato yutilmaydi, adminga ko'rsatiladi (episod baribir saqlanadi)
  let baseMsgId: number | null = null;
  if (config.baseChannelId) {
    try {
      // conversation.external + bot.api — `ctx.api` suhbat ichida qayta
      // o'ynatishga tushib, Telegram'ga bormasdan bo'sh javob qaytarishi mumkin.
      const sent = await conversation.external(() =>
        bot.api.sendVideo(config.baseChannelId!, fileId, {
          caption: `#serial ${e.escapeHtml(serialTitle)} · S${seasonNum}E${epNum}`,
        })
      );
      // Telegram ba'zi kanallarda `message_id: 0` qaytaradi — xabar joylanadi,
      // lekin id berilmaydi. 0 ni saqlamaymiz (u bilan tahrirlab/o'chirib
      // bo'lmaydi), lekin bu yuborish muvaffaqiyatsiz degani EMAS.
      baseMsgId = sent?.message_id && sent.message_id > 0 ? sent.message_id : null;
    } catch (err) {
      console.error(`🛑 Serial episod baza kanalga tashlanmadi (S${seasonNum}E${epNum}):`, err);
      await ctx.reply(
        `⚠️ Baza kanalga tashlab bo'lmadi (qism baribir saqlanadi): ${e.escapeHtml(describeError(err))}`
      );
    }
  }

  // Qismni saqlash (mavjud bo'lsa — yangi video bilan almashtirish)
  const result = await conversation.external(() =>
    prisma.episode.upsert({
      where: { seasonId_number: { seasonId: season.id, number: epNum } },
      create: { seasonId: season.id, number: epNum, fileId, baseMsgId },
      update: { fileId, baseMsgId },
    })
  );

  await ctx.reply(
    `${ce("check")} Qism saqlandi: <b>${e.escapeHtml(serialTitle)}</b> — ${seasonNum}-sezon, ${result.number}-qism.`,
    { reply_markup: adminMenuKeyboard(ctx.from?.id) }
  );
  // Ketma-ket qism qo'shish uchun tezkor tugma
  await ctx.reply("Yana qism qo'shasizmi?", {
    reply_markup: kb(
      [ibtn("➕ Yana qism qo'shish", "sr:addep", "success", BE.chAdd)],
      [ibtn("🎞 Serial bo'limi", "sr:back", "primary")]
    ),
  });
}

// ============ RO'YXAT (sahifalangan) ============
// Seriallar ko'p bo'lsa bitta xabarga sig'maydi — sahifalanadi (movies renderList
// bilan bir xil naqsh). 3 ustun emas, 1 serial = 1 qator, sahifada 8 ta.
const PAGE_S = 8;

serialsHandler.callbackQuery(/^sr:list:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await renderSerialList(ctx, Number(ctx.match[1]), false);
});

serialsHandler.callbackQuery(/^sr:del:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await renderSerialList(ctx, Number(ctx.match[1]), true);
});

async function renderSerialList(ctx: MyContext, page: number, delMode: boolean) {
  const total = await prisma.serial.count();
  const pages = Math.max(1, Math.ceil(total / PAGE_S));
  // Oxirgi sahifadagi seriallar o'chirilsa page to'xtab qolmasin — clamp.
  const p = Math.min(page, pages - 1);
  const serials = await prisma.serial.findMany({
    orderBy: { code: "asc" },
    skip: p * PAGE_S,
    take: PAGE_S,
    include: {
      _count: { select: { seasons: true } },
      seasons: { include: { _count: { select: { episodes: true } } } },
    },
  });

  if (serials.length === 0) {
    await ctx.editMessageText("📭 Serial yo'q.", { reply_markup: serialMenu() }).catch(() => {});
    return;
  }

  const rows: ReturnType<typeof ibtn>[][] = [];
  for (const s of serials) {
    const eps = s.seasons.reduce((a, x) => a + x._count.episodes, 0);
    rows.push(
      delMode
        ? [ibtn(`🗑 ${s.code} · ${s.title}`, `sr:delconf:${s.id}`, "danger")]
        : [
            ibtn(
              `${s.code} · ${s.title} · ${s._count.seasons} sezon, ${eps} qism`,
              `sr:view:${s.id}`,
              "primary",
              BE.serial
            ),
          ]
    );
  }

  const prefix = delMode ? "sr:del" : "sr:list";
  const nav: ReturnType<typeof ibtn>[] = [];
  if (p > 0) nav.push(ibtn("⬅️", `${prefix}:${p - 1}`));
  nav.push(ibtn(`${p + 1}/${pages}`, "noop:sr"));
  if (p < pages - 1) nav.push(ibtn("➡️", `${prefix}:${p + 1}`));
  rows.push(nav);
  rows.push([backBtn("sr:back")]);

  await ctx
    .editMessageText(
      delMode
        ? "🗑 <b>O'chirish uchun tanlang:</b>"
        : `${ce("list")} <b>Seriallar</b> (jami ${total}):`,
      { reply_markup: kb(...rows) }
    )
    .catch(() => {});
}

serialsHandler.callbackQuery("noop:sr", (ctx) => ctx.answerCallbackQuery());

serialsHandler.callbackQuery(/^sr:view:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const serial = await prisma.serial.findUnique({
    where: { id: Number(ctx.match[1]) },
    include: { seasons: { include: { _count: { select: { episodes: true } } } } },
  });
  if (!serial) return;
  const eps = serial.seasons.reduce((a, x) => a + x._count.episodes, 0);
  await ctx
    .editMessageText(
      `<tg-emoji emoji-id="${BE.serial}">📺</tg-emoji> <b>${e.escapeHtml(serial.title)}</b>\n` +
        `Kod: <code>${serial.code}</code>\n` +
        `Sezonlar: <b>${serial.seasons.length}</b>\n` +
        `Qismlar: <b>${eps}</b>`,
      {
        reply_markup: kb(
          [ibtn("Knopkani tahrirlash", "sr:btnlist:0", "primary", BE.editName)],
          [backBtn("sr:list:0")]
        ),
      }
    )
    .catch(() => {});
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
  const btn = await getGlobalButton("serial");
  const enabled = await getBool(KEYS.serialBtnEnabled, true);
  const status = btn.buttonUrl
    ? `Nom: <b>${e.escapeHtml(btn.buttonText ?? "Ko'rish")}</b>\nHavola: ${e.escapeHtml(btn.buttonUrl)}\nRang: <b>${buttonStyleLabel(btn.buttonStyle)}</b>`
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
      ibtn("Nomni o'zgartirish", "sr:gbtntext", "primary", BE.editName),
      ibtn("Havolani o'zgartirish", "sr:gbtnurl", "primary", BE.editUrl),
    ],
    [
      ibtn("🎨 Rangni tanlash", "sr:gbtncolors", "primary"),
      ibtn("O'chirish", "sr:gbtnclear", "danger", BE.chDelete),
    ],
    [backBtn("sr:back")]
  );

  // Panelni bitta xabar sifatida ushlab turamiz: matn-kutish oqimidan keyin
  // (edit=false) eskisi o'chirilib, o'rniga yangisi yoziladi.
  if (edit) {
    const ok = await ctx.editMessageText(text, { reply_markup }).catch(() => null);
    if (ok) {
      const mid = ctx.callbackQuery?.message?.message_id;
      if (mid) ctx.session.scratch = { ...(ctx.session.scratch ?? {}), sbtnPanelMsgId: mid };
      return;
    }
  }
  const prevId = ctx.session.scratch?.sbtnPanelMsgId as number | undefined;
  if (prevId) await ctx.api.deleteMessage(ctx.chat!.id, prevId).catch(() => {});
  const sent = await ctx.reply(text, { reply_markup });
  ctx.session.scratch = { ...(ctx.session.scratch ?? {}), sbtnPanelMsgId: sent.message_id };
}

serialsHandler.callbackQuery("sr:gbtncolors", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx
    .editMessageText("🎨 <b>Knopka rangini tanlang:</b>", {
      reply_markup: kb(
        [
          ibtn("Ko'k", "sr:gbtnsty:primary", "primary"),
          ibtn("Yashil", "sr:gbtnsty:success", "success"),
          ibtn("Qizil", "sr:gbtnsty:danger", "danger"),
          ibtn("Tasodifiy", "sr:gbtnsty:random", "success"),
        ],
        [backBtn("sr:btnlist:0")]
      ),
    })
    .catch(() => {});
});

serialsHandler.callbackQuery("sr:gbtntoggle", async (ctx) => {
  const cur = await getBool(KEYS.serialBtnEnabled, true);
  await setBool(KEYS.serialBtnEnabled, !cur);
  await ctx.answerCallbackQuery({
    text: !cur ? "✅ Knopka yoqildi" : "❌ Knopka o'chirildi",
    show_alert: true,
  });
  await renderGlobalSerialButtonEditor(ctx);
});

serialsHandler.callbackQuery("sr:gbtntext", async (ctx) => {
  ctx.session.scratch = { ...(ctx.session.scratch ?? {}), serialBtnField: "text" };
  await ctx.answerCallbackQuery();
  await ctx.reply("Yangi knopka nomini yuboring. Masalan: <code>Tomosha qilish</code>", {
    reply_markup: cancelKeyboard(),
  });
});

serialsHandler.callbackQuery("sr:gbtnurl", async (ctx) => {
  ctx.session.scratch = { ...(ctx.session.scratch ?? {}), serialBtnField: "url" };
  await ctx.answerCallbackQuery();
  await ctx.reply("Knopka havolasini yuboring. Masalan: <code>https://t.me/kanal</code>", {
    reply_markup: cancelKeyboard(),
  });
});

serialsHandler.callbackQuery(/^sr:gbtnsty:(primary|success|danger|random)$/, async (ctx) => {
  const style = resolveButtonStyle(ctx.match[1]);
  await setSetting(KEYS.serialBtnStyle, style);
  await ctx.answerCallbackQuery({ text: `Rang: ${buttonStyleLabel(style)}` });
  await renderGlobalSerialButtonEditor(ctx);
});

serialsHandler.callbackQuery("sr:gbtnclear", async (ctx) => {
  await Promise.all([
    setSetting(KEYS.serialBtnText, ""),
    setSetting(KEYS.serialBtnUrl, ""),
    setSetting(KEYS.serialBtnStyle, "primary"),
    // Matn/havola tozalanayotganda holatni ham o'chiramiz — aks holda "Yoqilgan"
    // ko'rinib, ichida bo'sh knopka sozlamasi qolardi (chalg'ituvchi).
    setBool(KEYS.serialBtnEnabled, false),
  ]);
  await ctx.answerCallbackQuery({ text: "Knopka sozlamalari tozalandi." });
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
    await ctx.reply(
      "❌ Havola <code>http://</code> yoki <code>https://</code> bilan boshlanishi kerak."
    );
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
serialsHandler.callbackQuery(/^sr:delconf:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  // Baza kanaldagi episod postlarini ham o'chiramiz (episodlar kaskadli o'chadi,
  // lekin kanal postlari mustaqil — aks holda o'lgan postlar qolib ketardi).
  const episodes = await prisma.episode.findMany({
    where: { season: { serialId: id }, baseMsgId: { not: null } },
    select: { baseMsgId: true },
  });
  if (config.baseChannelId) {
    for (const ep of episodes) {
      if (ep.baseMsgId)
        await ctx.api.deleteMessage(config.baseChannelId, ep.baseMsgId).catch(() => {});
    }
  }
  await prisma.serial.delete({ where: { id } }).catch(() => {});
  await ctx.answerCallbackQuery({ text: "🗑 O'chirildi" });
  // O'chirilgach navigatsiyasiz o'lik matn qolmasin — ro'yxat/menyuga qaytish yo'li.
  await ctx
    .editMessageText("🗑 Serial o'chirildi.", {
      reply_markup: kb([ibtn("📺 Seriallar ro'yxati", "sr:list:0", "primary"), backBtn("sr:back")]),
    })
    .catch(() => {});
});
