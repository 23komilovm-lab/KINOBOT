import { Composer } from "grammy";
import type { Conversation } from "@grammyjs/conversations";
import { prisma } from "../../prisma.js";
import { config, adminCan } from "../../config.js";
import { ce, e } from "../../utils/emoji.js";
import { ADMIN_MENU_BUTTONS, ibtn, BE, kb, cancelKeyboard, adminMenuKeyboard } from "../../utils/keyboard.js";
import { isValidUrl, resolveButtonStyle } from "../../utils/contentButton.js";
import { getSetting, setSetting, getGlobalButton, getBool, setBool, KEYS } from "../../utils/settings.js";
import { postToMovieChannel, describeError } from "../../services/movieChannel.js";
import { aiEnabled, askAI } from "../../services/ai.js";
import type { MyContext } from "../../types.js";

export const moviesHandler = new Composer<MyContext>();

const CANCEL = "❌ Bekor qilish";
const isCancel = (t?: string) => t === CANCEL || t === "/cancel";

/**
 * AI javobidan faqat janrlarni ajratib oladi.
 * AI ba'zan "«Titanic» filmi drama, melodrama." kabi to'liq gap qaytaradi —
 * shuning uchun ortiqcha so'zlar, tirnoq va nuqtalar tozalanadi.
 */
function cleanGenre(raw: string | null): string | null {
  if (!raw) return null;
  let s = raw.trim().split("\n")[0];            // faqat 1-qator
  s = s.replace(/^[^:]{0,40}:\s*/, "");          // "Janr:" kabi prefiks
  s = s.replace(/["'«»`*]/g, "");                // tirnoq/markdown
  s = s.replace(/\s*\.\s*$/, "");                // oxiridagi nuqta
  // "filmi/film/kino" kabi so'zlar va ulardan oldingi nom qismini olib tashlash
  s = s.replace(/^.*?\b(?:filmi|film|kinosi|kino)\b\s*/i, "");
  s = s.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 3).join(", ");
  s = s.slice(0, 100).trim();
  return s || null;
}

function movieMenu() {
  return kb(
    [ibtn("Kino qo'shish", "mv:add", "success", BE.chAdd), ibtn("Ro'yxat", "mv:list:0", "primary", BE.chList)],
    [ibtn("Knopka boshqaruvi", "mv:btnlist:0"), ibtn("O'chirish", "mv:del:0", "danger", BE.chDelete)],
    [ibtn("📲 Keyingi xabar (post)", "mv:pdmenu", "primary")],
    [ibtn("Menyuga qaytish", "mv:close", undefined, BE.backMenu)],
  );
}

moviesHandler.hears(ADMIN_MENU_BUTTONS.movies, async (ctx) => {
  if (!adminCan(ctx.from?.id ?? 0, "movies")) return;
  const count = await prisma.movie.count();
  await ctx.reply(
    `<tg-emoji emoji-id="${BE.movie}">🎬</tg-emoji> <b>Kino boshqaruvi</b>\n\n` +
      `Kinolar soni: <b>${count}</b>`,
    { reply_markup: movieMenu() }
  );
});

moviesHandler.callbackQuery("mv:close", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.deleteMessage().catch(() => {});
  await ctx.reply("Admin panel:", {
    reply_markup: adminMenuKeyboard(ctx.from.id),
  });
});

moviesHandler.callbackQuery("mv:add", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.conversation.enter("addMovie");
});

// ============ QO'SHISH (conversation) ============
export async function addMovie(conversation: Conversation<MyContext>, ctx: MyContext) {
  const ownerId = ctx.from?.id;

  await ctx.reply(
    `${ce("film")} <b>Yangi kino qo'shish</b>\n\n1️⃣ Kino <b>videosini</b> yuboring.`,
    { reply_markup: cancelKeyboard() }
  );

  const vidCtx = await conversation.wait();
  if (isCancel(vidCtx.message?.text))
    return vidCtx.reply("❌ Bekor qilindi.", { reply_markup: adminMenuKeyboard(ownerId) });
  const video = vidCtx.message?.video;
  if (!video)
    return vidCtx.reply("❌ Bu video emas.", { reply_markup: adminMenuKeyboard(ownerId) });
  const fileId   = video.file_id;
  const duration = video.duration ?? null;

  await vidCtx.reply("2️⃣ Kino <b>kodini</b> kiriting (raqam). Masalan: <code>123</code>");
  let code = 0;
  while (true) {
    const c = await conversation.wait();
    if (isCancel(c.message?.text))
      return c.reply("❌ Bekor qilindi.", { reply_markup: adminMenuKeyboard(ownerId) });
    const t = c.message?.text?.trim() ?? "";
    if (!/^\d+$/.test(t)) { await c.reply("❌ Faqat raqam."); continue; }
    code = Number(t);
    const exists = await conversation.external(() => prisma.movie.findUnique({ where: { code } }));
    if (exists) { await c.reply("⚠️ Bu kod band."); continue; }
    break;
  }

  await ctx.reply("3️⃣ Kino <b>nomini</b> kiriting.");
  const titleCtx = await conversation.wait();
  if (isCancel(titleCtx.message?.text))
    return titleCtx.reply("❌ Bekor qilindi.", { reply_markup: adminMenuKeyboard(ownerId) });
  const title = titleCtx.message?.text?.trim() || "Nomsiz";

  // 4️⃣ Janr — AI AVTOMATIK aniqlaydi, admin xohlasa o'zgartiradi
  let genre: string | null = null;
  if (aiEnabled()) {
    await ctx.reply("🤖 AI janrni aniqlamoqda...");
    const aiGenre = await conversation.external(() =>
      askAI("admin",
        `"${title}" nomli kino qaysi janrga mansub? Faqat 1-3 ta janr nomini vergul bilan yoz, ` +
        `boshqa hech narsa yozma (izoh, tirnoq, nuqta ham yo'q). O'zbekcha. Masalan: Jangari, Drama`,
      )
    );
    genre = cleanGenre(aiGenre);
  }

  if (genre) {
    await ctx.reply(
      `4️⃣ 🤖 AI aniqlagan janr: <b>${e.escapeHtml(genre)}</b>\n\n` +
      `Shu bo'lsa <code>+</code> deb yuboring (yoki "Tasdiqlash" tugmasi).\n` +
      `O'zgartirmoqchi bo'lsangiz — yangi janrni yozing.`,
      { reply_markup: cancelKeyboard() }
    );
  } else {
    await ctx.reply(
      `4️⃣ Kino <b>janrini</b> kiriting. Masalan: <code>Jangari, Drama</code>\n` +
      `Janrsiz davom etish uchun <code>-</code> yozing.` +
      (aiEnabled() ? `\n\n<i>⚠️ AI janrni aniqlay olmadi.</i>` : ""),
      { reply_markup: cancelKeyboard() }
    );
  }

  const genreCtx = await conversation.wait();
  if (isCancel(genreCtx.message?.text))
    return genreCtx.reply("❌ Bekor qilindi.", { reply_markup: adminMenuKeyboard(ownerId) });
  const genreInput = genreCtx.message?.text?.trim() ?? "";
  if (genreInput === "-") {
    genre = null;
  } else if (genreInput && genreInput !== "+") {
    genre = genreInput.slice(0, 100); // admin qo'lda kiritgan janr ustun
  }
  // "+" yoki bo'sh bo'lsa — AI aniqlagan janr o'z holida qoladi

  // 5️⃣ Qisqa (treyler) video — o'tkazib yuborish mumkin
  await ctx.reply(
    "5️⃣ Endi <b>qisqa (treyler) videosini</b> yuboring.\n\n" +
    "Bu video ommaviy kino kanaliga tashlanadi.\n" +
    "O'tkazib yuborish uchun <code>-</code> yozing.",
    { reply_markup: cancelKeyboard() }
  );
  let shortFileId: string | null = null;
  while (true) {
    const sc = await conversation.wait();
    if (isCancel(sc.message?.text))
      return sc.reply("❌ Bekor qilindi.", { reply_markup: adminMenuKeyboard(ownerId) });
    if (sc.message?.text?.trim() === "-") { shortFileId = null; break; }
    if (sc.message?.video) { shortFileId = sc.message.video.file_id; break; }
    await sc.reply("❌ Video yuboring yoki o'tkazib yuborish uchun <code>-</code> yozing.");
  }

  let baseMsgId: number | null = null;
  if (config.baseChannelId) {
    try {
      const sent = await ctx.api.sendVideo(config.baseChannelId, fileId, {
        caption: `#kino #${code}\n🎬 ${e.escapeHtml(title)}`,
      });
      baseMsgId = sent.message_id;
    } catch (err) {
      console.error(`🛑 Kino baza kanalga tashlanmadi (kod ${code}):`, err);
      await ctx.reply(`⚠️ Baza kanalga tashlab bo'lmadi: ${e.escapeHtml(describeError(err))}`);
    }
  }

  const movie = await conversation.external(() =>
    prisma.movie.create({
      data: { code, title, genre, fileId, baseMsgId, duration, shortFileId },
    })
  );

  // Qisqa videoni kino kanalga tashlash
  let shortStatus: string;
  if (shortFileId) {
    const { msgId, error } = await postToMovieChannel(ctx, movie, shortFileId);
    if (msgId) {
      await conversation.external(() =>
        prisma.movie.update({ where: { id: movie.id }, data: { shortMsgId: msgId } })
      );
      shortStatus = `📹 Qisqa video kino kanalga tashlandi.`;
    } else {
      shortStatus = `⚠️ Qisqa video tashlanmadi:\n<code>${e.escapeHtml(error ?? "noma'lum xato")}</code>`;
    }
  } else {
    shortStatus = `ℹ️ Qisqa video o'tkazib yuborildi.`;
  }

  await ctx.reply(
    `${ce("check")} <b>Kino qo'shildi!</b>\n\n` +
    `🎬 ${e.escapeHtml(movie.title)}\n` +
    `${ce("star")} Kod: <code>${movie.code}</code>\n` +
    (baseMsgId ? `📦 Baza kanalga tashlandi.\n` : `ℹ️ Baza kanal sozlanmagan.\n`) +
    shortStatus,
    { reply_markup: adminMenuKeyboard(ownerId) }
  );
}

// ============ RO'YXAT (sahifalangan) ============
const PAGE = 8;

moviesHandler.callbackQuery(/^mv:list:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await renderList(ctx, Number(ctx.match[1]), false);
});

moviesHandler.callbackQuery(/^mv:del:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await renderList(ctx, Number(ctx.match[1]), true);
});

async function renderList(ctx: MyContext, page: number, delMode: boolean) {
  const total  = await prisma.movie.count();
  const movies = await prisma.movie.findMany({
    orderBy: { code: "asc" }, skip: page * PAGE, take: PAGE,
  });

  if (movies.length === 0) {
    await ctx.editMessageText("📭 Kino yo'q.", { reply_markup: movieMenu() }).catch(() => {});
    return;
  }

  const rows: ReturnType<typeof ibtn>[][] = [];
  for (const m of movies) {
    rows.push(
      delMode
        ? [ibtn(`🗑 ${m.code} · ${m.title}`, `mv:delconf:${m.id}`, "danger")]
        : [ibtn(`🎬 ${m.code} · ${m.title} (${m.views}👁)`, `mv:view:${m.id}`, "primary")]
    );
  }

  const pages  = Math.ceil(total / PAGE);
  const prefix = delMode ? "mv:del" : "mv:list";
  const nav: ReturnType<typeof ibtn>[] = [];
  if (page > 0)         nav.push(ibtn("⬅️", `${prefix}:${page - 1}`));
  nav.push(ibtn(`${page + 1}/${pages}`, "noop"));
  if (page < pages - 1) nav.push(ibtn("➡️", `${prefix}:${page + 1}`));
  rows.push(nav);
  rows.push([ibtn("Orqaga", "mv:back", undefined, BE.home)]);

  await ctx.editMessageText(
    delMode ? "🗑 <b>O'chirish uchun tanlang:</b>" : `${ce("list")} <b>Kinolar</b> (jami ${total}):`,
    { reply_markup: kb(...rows) }
  ).catch(() => {});
}

moviesHandler.callbackQuery("noop", (ctx) => ctx.answerCallbackQuery());

moviesHandler.callbackQuery("mv:back", async (ctx) => {
  await ctx.answerCallbackQuery();
  const count = await prisma.movie.count();
  await ctx.editMessageText(
    `<tg-emoji emoji-id="${BE.movie}">🎬</tg-emoji> <b>Kino boshqaruvi</b>\n\n` +
      `Kinolar soni: <b>${count}</b>`,
    {
      reply_markup: movieMenu(),
    }
  ).catch(() => {});
});

moviesHandler.callbackQuery(/^mv:btnlist:\d+$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await renderGlobalMovieButtonEditor(ctx);
});

async function renderGlobalMovieButtonEditor(ctx: MyContext, edit = true) {
  const btn     = await getGlobalButton("movie");
  const enabled = await getBool(KEYS.movieBtnEnabled, true);
  const status  = btn.buttonUrl
    ? `Nom: <b>${e.escapeHtml(btn.buttonText ?? "Ko'rish")}</b>\nHavola: ${e.escapeHtml(btn.buttonUrl)}\nRang: <b>${btn.buttonStyle}</b>`
    : "Knopka hali sozlanmagan.";

  const text =
    `<tg-emoji emoji-id="${BE.movie}">🎬</tg-emoji> <b>Kino uchun global knopka</b>\n\n` +
    `Holat: <b>${enabled ? "Yoqilgan" : "O'chirilgan"}</b>\n` +
    `${status}\n\n<i>Bu knopka barcha kinolarda ko'rinadi.</i>`;

  const reply_markup = kb(
    [
      ibtn(
        enabled ? "🟢 Yoqilgan — O'chirish" : "🔴 O'chirilgan — Yoqish",
        "mv:gbtntoggle",
        enabled ? "success" : "danger"
      ),
    ],
    [
      ibtn("Nomni o'zgartirish",    "mv:gbtntext",   "primary", BE.editName),
      ibtn("Havolani o'zgartirish", "mv:gbtnurl",    "primary", BE.editUrl),
    ],
    [
      ibtn("🎨 Rangni tanlash", "mv:gbtncolors", "primary"),
      ibtn("O'chirish",          "mv:gbtnclear",  "danger", BE.chDelete),
    ],
    [ibtn("Orqaga", "mv:back", undefined, BE.backMenu)],
  );

  // Panelni bitta xabar sifatida ushlab turamiz: matn-kutish oqimidan keyin
  // (edit=false) eskisi o'chirilib, o'rniga yangisi yoziladi — aks holda har
  // tahrirlashda eski panel chatda tirik tugmalari bilan qolib ketardi.
  if (edit) {
    const ok = await ctx.editMessageText(text, { reply_markup }).catch(() => null);
    if (ok) {
      const mid = ctx.callbackQuery?.message?.message_id;
      if (mid) ctx.session.scratch = { ...(ctx.session.scratch ?? {}), gbtnPanelMsgId: mid };
      return;
    }
  }
  const prevId = ctx.session.scratch?.gbtnPanelMsgId as number | undefined;
  if (prevId) await ctx.api.deleteMessage(ctx.chat!.id, prevId).catch(() => {});
  const sent = await ctx.reply(text, { reply_markup });
  ctx.session.scratch = { ...(ctx.session.scratch ?? {}), gbtnPanelMsgId: sent.message_id };
}

moviesHandler.callbackQuery("mv:gbtncolors", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    "🎨 <b>Knopka rangini tanlang:</b>",
    {
      reply_markup: kb(
        [
          ibtn("Ko'k",   "mv:gbtnsty:primary", "primary"),
          ibtn("Yashil", "mv:gbtnsty:success", "success"),
          ibtn("Qizil",  "mv:gbtnsty:danger",  "danger"),
          ibtn("Random", "mv:gbtnsty:random",  "success"),
        ],
        [ibtn("Orqaga", "mv:btnlist:0", undefined, BE.backMenu)],
      ),
    }
  ).catch(() => {});
});

moviesHandler.callbackQuery("mv:gbtntoggle", async (ctx) => {
  const cur = await getBool(KEYS.movieBtnEnabled, true);
  await setBool(KEYS.movieBtnEnabled, !cur);
  await ctx.answerCallbackQuery({ text: !cur ? "✅ Knopka yoqildi" : "❌ Knopka o'chirildi", show_alert: true });
  await renderGlobalMovieButtonEditor(ctx);
});

moviesHandler.callbackQuery("mv:gbtntext", async (ctx) => {
  ctx.session.scratch = { ...(ctx.session.scratch ?? {}), movieBtnField: "text" };
  await ctx.answerCallbackQuery();
  await ctx.reply("Yangi knopka nomini yuboring. Masalan: <code>Tomosha qilish</code>", { reply_markup: cancelKeyboard() });
});

moviesHandler.callbackQuery("mv:gbtnurl", async (ctx) => {
  ctx.session.scratch = { ...(ctx.session.scratch ?? {}), movieBtnField: "url" };
  await ctx.answerCallbackQuery();
  await ctx.reply("Knopka havolasini yuboring. Masalan: <code>https://t.me/kanal</code>", { reply_markup: cancelKeyboard() });
});

moviesHandler.callbackQuery(/^mv:gbtnsty:(primary|success|danger|random)$/, async (ctx) => {
  const style = resolveButtonStyle(ctx.match[1]);
  await setSetting(KEYS.movieBtnStyle, style);
  await ctx.answerCallbackQuery({ text: `Rang: ${style}` });
  await renderGlobalMovieButtonEditor(ctx);
});

moviesHandler.callbackQuery("mv:gbtnclear", async (ctx) => {
  await Promise.all([
    setSetting(KEYS.movieBtnText, ""),
    setSetting(KEYS.movieBtnUrl, ""),
    setSetting(KEYS.movieBtnStyle, "primary"),
  ]);
  await ctx.answerCallbackQuery({ text: "Knopka o'chirildi." });
  await renderGlobalMovieButtonEditor(ctx);
});

// ─── Kino yuborilgandan keyingi qo'shimcha post (reklama va h.k.) ────────────
moviesHandler.callbackQuery("mv:pdmenu", async (ctx) => {
  await ctx.answerCallbackQuery();
  await renderPostDeliveryEditor(ctx);
});

async function renderPostDeliveryEditor(ctx: MyContext, edit = true) {
  const [enabled, text, btnText, btnUrl, btnStyle] = await Promise.all([
    getBool(KEYS.postDeliveryEnabled, false),
    getSetting(KEYS.postDeliveryText, ""),
    getSetting(KEYS.postDeliveryBtnText, ""),
    getSetting(KEYS.postDeliveryBtnUrl, ""),
    getSetting(KEYS.postDeliveryBtnStyle, "primary"),
  ]);

  const status =
    (text ? `Matn:\n${e.escapeHtml(text)}\n\n` : "Matn hali sozlanmagan.\n\n") +
    (btnUrl ? `Knopka: <b>${e.escapeHtml(btnText || "—")}</b>\nHavola: ${e.escapeHtml(btnUrl)}\nRang: <b>${btnStyle}</b>` : "Knopka sozlanmagan (ixtiyoriy).");

  const msg =
    `<tg-emoji emoji-id="${BE.movie}">📲</tg-emoji> <b>Kino keyingi xabari</b>\n\n` +
    `Holat: <b>${enabled ? "Yoqilgan" : "O'chirilgan"}</b>\n` +
    `<i>Kino yuborilgandan so'ng darhol shu xabar (masalan APK ilova reklamasi) qo'shimcha yuboriladi.</i>\n\n` +
    status;

  const reply_markup = kb(
    [
      ibtn(
        enabled ? "🟢 Yoqilgan — O'chirish" : "🔴 O'chirilgan — Yoqish",
        "mv:pdtoggle",
        enabled ? "success" : "danger"
      ),
    ],
    [ibtn("✏️ Matnni o'zgartirish", "mv:pdtext", "primary")],
    [
      ibtn("Knopka nomi", "mv:pdbtntext", "primary", BE.editName),
      ibtn("Knopka havolasi", "mv:pdbtnurl", "primary", BE.editUrl),
    ],
    [
      ibtn("🎨 Rangni tanlash", "mv:pdbtncolors", "primary"),
      ibtn("Hammasini tozalash", "mv:pdclear", "danger", BE.chDelete),
    ],
    [ibtn("Orqaga", "mv:back", undefined, BE.backMenu)],
  );

  // Panelni bitta xabar sifatida ushlab turamiz — izoh yuqoridagi
  // renderGlobalMovieButtonEditor'da (bir xil naqsh, xuddi shu bug edi).
  if (edit) {
    const ok = await ctx.editMessageText(msg, { reply_markup }).catch(() => null);
    if (ok) {
      const mid = ctx.callbackQuery?.message?.message_id;
      if (mid) ctx.session.scratch = { ...(ctx.session.scratch ?? {}), pdPanelMsgId: mid };
      return;
    }
  }
  const prevId = ctx.session.scratch?.pdPanelMsgId as number | undefined;
  if (prevId) await ctx.api.deleteMessage(ctx.chat!.id, prevId).catch(() => {});
  const sent = await ctx.reply(msg, { reply_markup });
  ctx.session.scratch = { ...(ctx.session.scratch ?? {}), pdPanelMsgId: sent.message_id };
}

moviesHandler.callbackQuery("mv:pdtoggle", async (ctx) => {
  const cur = await getBool(KEYS.postDeliveryEnabled, false);
  const next = !cur;
  if (next) {
    const text = await getSetting(KEYS.postDeliveryText, "");
    if (!text.trim()) {
      await ctx.answerCallbackQuery({ text: "❌ Avval matnni sozlang, keyin yoqing.", show_alert: true });
      return;
    }
  }
  await setBool(KEYS.postDeliveryEnabled, next);
  await ctx.answerCallbackQuery({ text: next ? "✅ Yoqildi" : "❌ O'chirildi", show_alert: true });
  await renderPostDeliveryEditor(ctx);
});

moviesHandler.callbackQuery("mv:pdtext", async (ctx) => {
  ctx.session.scratch = { ...(ctx.session.scratch ?? {}), pdField: "text" };
  await ctx.answerCallbackQuery();
  await ctx.reply(
    "Kino yuborilgandan keyin chiqadigan <b>matnni</b> yuboring (HTML teglar mumkin).\n\n" +
    "Masalan: <code>📲 Ilovalar do'koni kerakmi? Apk Topla orqali yuklab oling!</code>",
    { reply_markup: cancelKeyboard() }
  );
});

moviesHandler.callbackQuery("mv:pdbtntext", async (ctx) => {
  ctx.session.scratch = { ...(ctx.session.scratch ?? {}), pdField: "btntext" };
  await ctx.answerCallbackQuery();
  await ctx.reply("Knopka nomini yuboring. Masalan: <code>📥 Apk Topla'ni yuklash</code>", { reply_markup: cancelKeyboard() });
});

moviesHandler.callbackQuery("mv:pdbtnurl", async (ctx) => {
  ctx.session.scratch = { ...(ctx.session.scratch ?? {}), pdField: "btnurl" };
  await ctx.answerCallbackQuery();
  await ctx.reply("Knopka havolasini yuboring. Masalan: <code>https://t.me/apktopla</code>", { reply_markup: cancelKeyboard() });
});

moviesHandler.callbackQuery("mv:pdbtncolors", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    "🎨 <b>Knopka rangini tanlang:</b>",
    {
      reply_markup: kb(
        [
          ibtn("Ko'k",   "mv:pdbtnsty:primary", "primary"),
          ibtn("Yashil", "mv:pdbtnsty:success", "success"),
          ibtn("Qizil",  "mv:pdbtnsty:danger",  "danger"),
          ibtn("Random", "mv:pdbtnsty:random",  "success"),
        ],
        [ibtn("Orqaga", "mv:pdmenu", undefined, BE.backMenu)],
      ),
    }
  ).catch(() => {});
});

moviesHandler.callbackQuery(/^mv:pdbtnsty:(primary|success|danger|random)$/, async (ctx) => {
  const style = resolveButtonStyle(ctx.match[1]);
  await setSetting(KEYS.postDeliveryBtnStyle, style);
  await ctx.answerCallbackQuery({ text: `Rang: ${style}` });
  await renderPostDeliveryEditor(ctx);
});

moviesHandler.callbackQuery("mv:pdclear", async (ctx) => {
  await Promise.all([
    setBool(KEYS.postDeliveryEnabled, false),
    setSetting(KEYS.postDeliveryText, ""),
    setSetting(KEYS.postDeliveryBtnText, ""),
    setSetting(KEYS.postDeliveryBtnUrl, ""),
    setSetting(KEYS.postDeliveryBtnStyle, "primary"),
  ]);
  await ctx.answerCallbackQuery({ text: "Tozalandi va o'chirildi." });
  await renderPostDeliveryEditor(ctx);
});

moviesHandler.on("message:text", async (ctx, next) => {
  const pdField = ctx.session.scratch?.pdField as string | undefined;
  if (pdField) {
    const text = ctx.message.text.trim();
    if (isCancel(text)) {
      if (ctx.session.scratch) delete ctx.session.scratch.pdField;
      await ctx.reply("❌ Bekor qilindi.");
      return;
    }

    if (pdField === "text") {
      await setSetting(KEYS.postDeliveryText, text.slice(0, 1024));
      if (ctx.session.scratch) delete ctx.session.scratch.pdField;
      await ctx.reply(`${ce("check")} Matn saqlandi.`);
      await renderPostDeliveryEditor(ctx, false);
      return;
    }
    if (pdField === "btntext") {
      await setSetting(KEYS.postDeliveryBtnText, text.slice(0, 64));
      if (ctx.session.scratch) delete ctx.session.scratch.pdField;
      await ctx.reply(`${ce("check")} Knopka nomi saqlandi.`);
      await renderPostDeliveryEditor(ctx, false);
      return;
    }
    // btnurl
    if (!isValidUrl(text)) {
      await ctx.reply("❌ Havola <code>http://</code> yoki <code>https://</code> bilan boshlanishi kerak.");
      return;
    }
    await setSetting(KEYS.postDeliveryBtnUrl, text);
    if (ctx.session.scratch) delete ctx.session.scratch.pdField;
    await ctx.reply(`${ce("check")} Knopka havolasi saqlandi.`);
    await renderPostDeliveryEditor(ctx, false);
    return;
  }

  const field = ctx.session.scratch?.movieBtnField as string | undefined;
  if (!field) return next();

  const text = ctx.message.text.trim();
  if (isCancel(text)) {
    if (ctx.session.scratch) delete ctx.session.scratch.movieBtnField;
    await ctx.reply("❌ Bekor qilindi.");
    return;
  }

  if (field === "text") {
    await setSetting(KEYS.movieBtnText, text.slice(0, 64));
    if (ctx.session.scratch) delete ctx.session.scratch.movieBtnField;
    await ctx.reply(`${ce("check")} Knopka nomi saqlandi.`);
    await renderGlobalMovieButtonEditor(ctx, false);
    return;
  }

  if (!isValidUrl(text)) {
    await ctx.reply("❌ Havola <code>http://</code> yoki <code>https://</code> bilan boshlanishi kerak.");
    return;
  }

  await setSetting(KEYS.movieBtnUrl, text);
  const currentName = await getSetting(KEYS.movieBtnText);
  if (!currentName) await setSetting(KEYS.movieBtnText, "Ko'rish");
  if (ctx.session.scratch) delete ctx.session.scratch.movieBtnField;
  await ctx.reply(`${ce("check")} Knopka havolasi saqlandi.`);
  await renderGlobalMovieButtonEditor(ctx, false);
});

moviesHandler.callbackQuery(/^mv:view:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const m = await prisma.movie.findUnique({ where: { id: Number(ctx.match[1]) } });
  if (!m) return;
  await ctx.replyWithVideo(m.fileId, {
    caption:
      `🎬 <b>${e.escapeHtml(m.title)}</b>\n` +
      `${ce("star")} Kod: <code>${m.code}</code>\n👁 Ko'rishlar: ${m.views}`,
    reply_markup: kb(
      [
        ibtn("Knopkani tahrirlash", "mv:btnlist:0", "primary", BE.editName),
        ibtn("O'chirish", `mv:delconf:${m.id}`, "danger", BE.chDelete),
      ]
    ),
  });
});

moviesHandler.callbackQuery(/^mv:delconf:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  const m  = await prisma.movie.findUnique({ where: { id } });
  await prisma.movie.delete({ where: { id } }).catch(() => {});
  if (m?.baseMsgId && config.baseChannelId)
    await ctx.api.deleteMessage(config.baseChannelId, m.baseMsgId).catch(() => {});
  await ctx.answerCallbackQuery({ text: "🗑 O'chirildi" });
  await ctx.editMessageText("🗑 Kino o'chirildi.").catch(() => {});
});
