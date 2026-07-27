import { Composer } from "grammy";
import { adminCan } from "../../config.js";
import { prisma } from "../../prisma.js";
import { ce, e } from "../../utils/emoji.js";
import {
  ADMIN_MENU_BUTTONS, BOT_SETTINGS_TEXT, adminMenuKeyboard, ibtn, BE, kb,
} from "../../utils/keyboard.js";
import { resolveButtonStyle } from "../../utils/contentButton.js";
import { formatUzDateTime } from "../../utils/dateRange.js";
import {
  acquireBulkLock, bulkSend, cancelBulk, formatBulkResult, isBulkCancelled,
  isBulkRunning, releaseBulkLock, type BulkResult,
} from "../../services/bulkSend.js";
import type { MyContext } from "../../types.js";

export const broadcastHandler = new Composer<MyContext>();

/** Bir vaqtda faqat bitta ommaviy yuborish bo'lsin */
const BULK_KEY = "broadcast";

/**
 * Admin doimiy (reply) klaviaturasidagi tugmalar — bular hech qachon
 * broadcast shabloni bo'lib qolmasligi kerak. Bu tugmalarning bir qismi
 * admin/index.ts da broadcastHandler'dan KEYIN ro'yxatdan o'tgan, shuning
 * uchun quyidagi `.on("message")` ularni ushlab qolib, admin sezmagan holda
 * "Backup" degan so'zni butun bazaga yuborib yuborishi mumkin edi.
 */
const NAV_TEXTS = new Set<string>([
  ...Object.values(ADMIN_MENU_BUTTONS),
  ...Object.values(BOT_SETTINGS_TEXT),
  "AI yordamchi",
  "❌ Chiqish",
  "❌ Bekor qilish",
]);

function isNavigation(text: string | undefined): boolean {
  if (!text) return false;
  return text.startsWith("/") || NAV_TEXTS.has(text.trim());
}

// ─── Yordamchi tiplar ────────────────────────────────────────────────────────

interface InlineBtn {
  text: string;
  url: string;
  style: string;
}

interface BcastData {
  state: string;
  target: { type: string; region?: string; surveyId?: number; optionId?: number };
  templateChatId?: number;
  templateMsgId?: number;
  buttons: InlineBtn[][];
  pendingBtnText?: string;
  pendingBtnUrl?: string;
  pendingRowBtn?: InlineBtn;
  /** Ochiq turgan ko'rinish xabarlari — yangisini ko'rsatishdan oldin o'chiriladi,
   *  aks holda chatda bir nechta tirik "Yuborish" tugmasi qolib ketardi. */
  previewPanelMsgId?: number;
  previewCopyMsgId?: number;
}

/** Telegram cheklovlari — oshib ketsa butun klaviatura rad etiladi va xabar hech kimga bormaydi */
const MAX_BTN_PER_ROW = 4;
const MAX_BTN_TOTAL = 20;

function getBcast(ctx: MyContext): BcastData | null {
  return (ctx.session.scratch?.bcast as BcastData) ?? null;
}
function setBcast(ctx: MyContext, d: BcastData) {
  ctx.session.scratch = { ...(ctx.session.scratch ?? {}), bcast: d };
}
function clearBcast(ctx: MyContext) {
  if (ctx.session.scratch) delete ctx.session.scratch.bcast;
}

function buildInlineKb(buttons: InlineBtn[][]) {
  if (!buttons.length) return undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const inline_keyboard: any[][] = buttons.map((row) =>
    row.map((b) => ({ text: b.text, url: b.url, style: b.style }))
  );
  return { inline_keyboard };
}

// ─── Asosiy menyu ────────────────────────────────────────────────────────────

function broadcastMenu() {
  return kb(
    [ibtn("📤 Hammaga yuborish", "bc:target:all", "primary")],
    [
      ibtn("🗺 Viloyat bo'yicha",        "bc:target:region",    "success"),
      ibtn("📊 Funnel javobchilari",     "bc:target:funnel",    "success"),
    ],
    [ibtn("📋 So'rovnomalar (Funnel)",   "fn:menu",             "primary", BE.trend)],
    [ibtn("🗂 Yuborishlar tarixi",       "bc:history:0",        "primary", BE.list)],
    [ibtn("♻️ Bloklanganlar ro'yxatini tiklash", "bc:unblock", "primary")],
    [ibtn("Menyuga qaytish", "bc:close", undefined, BE.backMenu)],
  );
}

broadcastHandler.hears(ADMIN_MENU_BUTTONS.broadcast, async (ctx) => {
  if (!adminCan(ctx.from?.id ?? 0, "broadcast")) return;
  clearBcast(ctx);
  await ctx.reply(
    `${ce("fire")} <b>Xabar yuborish</b>\n\nKimga yubormoqchisiz?`,
    { reply_markup: broadcastMenu() }
  );
});

broadcastHandler.callbackQuery("bc:close", async (ctx) => {
  await ctx.answerCallbackQuery();
  clearBcast(ctx);
  await ctx.deleteMessage().catch(() => {});
  await ctx.reply("Admin panel:", { reply_markup: adminMenuKeyboard(ctx.from.id) });
});

broadcastHandler.callbackQuery("bc:menu", async (ctx) => {
  await ctx.answerCallbackQuery();
  clearBcast(ctx);
  await ctx.editMessageText(
    `${ce("fire")} <b>Xabar yuborish</b>\n\nKimga yubormoqchisiz?`,
    { reply_markup: broadcastMenu() }
  ).catch(() => {});
});

// ─── Nishon tanlash ──────────────────────────────────────────────────────────

broadcastHandler.callbackQuery("bc:target:all", async (ctx) => {
  await ctx.answerCallbackQuery();
  const count = await prisma.user.count({ where: { isBlocked: false } });
  setBcast(ctx, { state: "compose", target: { type: "all" }, buttons: [] });
  await ctx.editMessageText(
    `👥 Jami: <b>${count}</b> ta foydalanuvchi\n\nXabarni yuboring (matn, rasm, video, fayl):`,
    { reply_markup: kb([ibtn("❌ Bekor", "bc:menu", "danger")]) }
  ).catch(() => {});
});

broadcastHandler.callbackQuery("bc:target:region", async (ctx) => {
  const regions = await prisma.user.groupBy({
    by: ["region"],
    where: { region: { not: null }, isBlocked: false },
    _count: { id: true },
    orderBy: { _count: { id: "desc" } },
  });

  // DIQQAT: answerCallbackQuery bir marta chaqirilishi kerak — ilgari yuqorida
  // bo'sh javob berilib, quyidagi ogohlantirish hech qachon ko'rinmasdi.
  if (regions.length === 0) {
    await ctx.answerCallbackQuery({
      text: "Hozircha hech bir foydalanuvchi viloyatini ko'rsatmagan.\nAvval Funnel orqali viloyat so'rovnomasini yuboring.",
      show_alert: true,
    });
    return;
  }
  await ctx.answerCallbackQuery();

  // callback_data 64 baytdan oshmasligi kerak — uzun nomlarni chiqarib tashlaymiz
  const fitting = regions.filter((r) => Buffer.byteLength(`bc:region:${r.region}`, "utf8") <= 64);
  const rows = fitting.map((r) => [
    ibtn(`${r.region} (${r._count.id})`, `bc:region:${r.region}`, "primary"),
  ]);
  rows.push([ibtn("❌ Bekor", "bc:menu", "danger")]);

  await ctx.editMessageText(
    "🗺 <b>Qaysi viloyat/shaharga yubormoqchisiz?</b>",
    { reply_markup: kb(...rows) }
  ).catch(() => {});
});

broadcastHandler.callbackQuery(/^bc:region:(.+)$/, async (ctx) => {
  const region = ctx.match[1];
  const count = await prisma.user.count({ where: { region, isBlocked: false } });
  await ctx.answerCallbackQuery();
  setBcast(ctx, { state: "compose", target: { type: "region", region }, buttons: [] });
  await ctx.editMessageText(
    `🗺 Viloyat: <b>${e.escapeHtml(region)}</b>\n👥 Foydalanuvchilar: <b>${count}</b>\n\nXabarni yuboring:`,
    { reply_markup: kb([ibtn("❌ Bekor", "bc:menu", "danger")]) }
  ).catch(() => {});
});

broadcastHandler.callbackQuery("bc:target:funnel", async (ctx) => {
  const surveys = await prisma.survey.findMany({ orderBy: { createdAt: "desc" }, take: 20 });
  if (surveys.length === 0) {
    await ctx.answerCallbackQuery({ text: "Hozircha so'rovnoma yaratilmagan.", show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();
  const rows = surveys.map((s) => [ibtn(s.title, `bc:survey:${s.id}`, "primary")]);
  rows.push([ibtn("❌ Bekor", "bc:menu", "danger")]);
  await ctx.editMessageText(
    "📊 <b>Qaysi so'rovnoma javobchilariga yubormoqchisiz?</b>",
    { reply_markup: kb(...rows) }
  ).catch(() => {});
});

broadcastHandler.callbackQuery(/^bc:survey:(\d+)$/, async (ctx) => {
  const surveyId = Number(ctx.match[1]);
  const survey = await prisma.survey.findUnique({
    where: { id: surveyId },
    include: { options: { orderBy: { sortOrder: "asc" } } },
  });
  if (!survey) { await ctx.answerCallbackQuery(); return; }
  await ctx.answerCallbackQuery();

  // Har bir variant bo'yicha javoblar soni
  const counts = await prisma.surveyResponse.groupBy({
    by: ["optionId"],
    where: { surveyId },
    _count: { userId: true },
  });
  const countOf = (optionId: number) =>
    counts.find((c) => c.optionId === optionId)?._count.userId ?? 0;
  const totalAnswers = counts.reduce((s, c) => s + c._count.userId, 0);

  const rows = survey.options.map((o) => [
    ibtn(`${o.text} (${countOf(o.id)})`, `bc:survopt:${surveyId}:${o.id}`, "primary"),
  ]);
  rows.push([ibtn(`📊 Barcha javobchilar (${totalAnswers})`, `bc:survopt:${surveyId}:0`, "success")]);
  rows.push([ibtn("❌ Bekor", "bc:menu", "danger")]);
  await ctx.editMessageText(
    `📊 <b>${e.escapeHtml(survey.title)}</b>\n\nQaysi javob berganlar?`,
    { reply_markup: kb(...rows) }
  ).catch(() => {});
});

broadcastHandler.callbackQuery(/^bc:survopt:(\d+):(\d+)$/, async (ctx) => {
  const [surveyId, optionId] = [Number(ctx.match[1]), Number(ctx.match[2])];
  const where = optionId === 0
    ? { surveyId }
    : { surveyId, optionId };
  const count = await prisma.surveyResponse.count({ where });
  await ctx.answerCallbackQuery();
  setBcast(ctx, { state: "compose", target: { type: "funnel", surveyId, optionId }, buttons: [] });
  await ctx.editMessageText(
    `📊 Javobchilar: <b>${count}</b> ta\n\nXabarni yuboring:`,
    { reply_markup: kb([ibtn("❌ Bekor", "bc:menu", "danger")]) }
  ).catch(() => {});
});

// ─── Xabar shabloni qabul qilish ─────────────────────────────────────────────

broadcastHandler.on("message", async (ctx, next) => {
  if (!adminCan(ctx.from?.id ?? 0, "broadcast")) return next();
  const bcast = getBcast(ctx);
  if (!bcast) return next();

  const text = ctx.message.text?.trim();

  // Admin menyu tugmasi yoki komanda bosilgan bo'lsa — bu broadcast uchun kiritish
  // emas, navigatsiya. Qoralamani bekor qilib, tegishli handlerga o'tkazamiz.
  if (isNavigation(text)) {
    clearBcast(ctx);
    await ctx.reply("ℹ️ Xabar yuborish bekor qilindi (boshqa bo'limga o'tdingiz).");
    return next();
  }

  // ── Knopka matni ──
  if (bcast.state === "btnText") {
    if (!text) { await ctx.reply("❌ Knopka matnini <b>yozib</b> yuboring."); return; }
    bcast.pendingBtnText = text.slice(0, 64);
    bcast.state = "btnUrl";
    setBcast(ctx, bcast);
    await ctx.reply("🔗 Knopka URL ini kiriting (https://...):");
    return;
  }

  // ── Knopka URL ──
  if (bcast.state === "btnUrl") {
    const url = text ?? "";
    if (!url.startsWith("http://") && !url.startsWith("https://") && !url.startsWith("tg://")) {
      await ctx.reply("❌ URL <code>https://</code> bilan boshlanishi kerak.");
      return;
    }
    if (url.length > 512) {
      await ctx.reply("❌ URL juda uzun (512 belgidan oshmasin).");
      return;
    }
    // URL callback_data ichida EMAS, sessiyada saqlanadi — callback_data 64 bayt
    // bilan cheklangan va uzunroq havolalar butun klaviaturani buzardi.
    bcast.pendingBtnUrl = url;
    setBcast(ctx, bcast);
    await ctx.reply(
      "🎨 Knopka rangini tanlang:",
      {
        reply_markup: kb(
          [
            ibtn("Ko'k",   "bc:btnstyle:primary", "primary"),
            ibtn("Yashil", "bc:btnstyle:success", "success"),
            ibtn("Qizil",  "bc:btnstyle:danger",  "danger"),
            ibtn("Random", "bc:btnstyle:random",  "success"),
          ],
        ),
      }
    );
    return;
  }

  // ── Xabar shabloni (yangi yoki almashtirish) ──
  // "preview" holatida yangi xabar yuborilsa — shablon almashadi. Ilgari bunday
  // xabar hech qayerga tushmasdan yo'qolib ketardi.
  if (bcast.state === "compose" || bcast.state === "preview") {
    bcast.templateChatId = ctx.chat.id;
    bcast.templateMsgId  = ctx.message.message_id;
    bcast.state = "preview";
    setBcast(ctx, bcast);
    await showPreview(ctx, bcast);
    return;
  }

  return next();
});

// ─── Knopka rang tanlash ─────────────────────────────────────────────────────

broadcastHandler.callbackQuery(/^bc:btnstyle:(primary|success|danger|random)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const bcast = getBcast(ctx);
  if (!bcast?.pendingBtnText || !bcast.pendingBtnUrl) return;

  const style = resolveButtonStyle(ctx.match[1]);
  const url   = bcast.pendingBtnUrl;

  const btn: InlineBtn = { text: bcast.pendingBtnText, url, style };
  delete bcast.pendingBtnText;
  delete bcast.pendingBtnUrl;

  // Birinchi knopka bo'lsa — "qatorga qo'shish" savoli ma'nosiz (qo'shadigan avvalgi
  // qator yo'q), shu zahoti yangi qator sifatida qo'shib preview'ga o'tamiz.
  if (bcast.buttons.length === 0) {
    bcast.buttons.push([btn]);
    bcast.state = "preview";
    setBcast(ctx, bcast);
    await ctx.deleteMessage().catch(() => {}); // rang tanlash so'rovi endi keraksiz
    await showPreview(ctx, bcast);
    return;
  }

  await ctx.editMessageText(
    "Yangi qatorda yoki avvalgisi bilan?",
    {
      reply_markup: kb(
        [
          ibtn("➕ Shu qatorda", `bc:btnadd:same`,  "primary"),
          ibtn("🆕 Yangi qator", `bc:btnadd:new`,   "success"),
        ],
      ),
    }
  ).catch(() => {});

  // Kutilayotgan knopka bcast ichida saqlanadi — ilgari u scratch'ning ildizida
  // turardi va clearBcast uni o'chirmasdi, natijada eski knopka keyingi
  // broadcast'ga tushib ketishi mumkin edi.
  bcast.state = "btnRow";
  bcast.pendingRowBtn = btn;
  setBcast(ctx, bcast);
});

broadcastHandler.callbackQuery(/^bc:btnadd:(same|new)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const bcast = getBcast(ctx);
  const btn = bcast?.pendingRowBtn;
  if (!bcast || !btn || bcast.state !== "btnRow") return;

  const lastRow = bcast.buttons[bcast.buttons.length - 1];
  if (ctx.match[1] === "same" && lastRow && lastRow.length < MAX_BTN_PER_ROW) {
    lastRow.push(btn);
  } else {
    bcast.buttons.push([btn]);
  }

  delete bcast.pendingRowBtn;
  bcast.state = "preview";
  setBcast(ctx, bcast);
  await ctx.deleteMessage().catch(() => {}); // qator tanlash so'rovi endi keraksiz
  await showPreview(ctx, bcast);
});

// ─── Ko'rinish ───────────────────────────────────────────────────────────────

async function showPreview(ctx: MyContext, bcast: BcastData) {
  const chatId = ctx.chat!.id;

  // Avvalgi ko'rinishni o'chiramiz — chatda bir vaqtda faqat bitta tirik
  // "Yuborish" tugmasi qolsin (eskisini bosish noto'g'ri xabar yuborardi).
  for (const id of [bcast.previewCopyMsgId, bcast.previewPanelMsgId]) {
    if (id) await ctx.api.deleteMessage(chatId, id).catch(() => {});
  }
  delete bcast.previewCopyMsgId;
  delete bcast.previewPanelMsgId;

  // Avval shablonning o'zi
  if (bcast.templateChatId && bcast.templateMsgId) {
    const ikb = buildInlineKb(bcast.buttons);
    const copy = await ctx.api.copyMessage(chatId, bcast.templateChatId, bcast.templateMsgId, {
      reply_markup: ikb,
    }).catch(() => null);
    if (copy) bcast.previewCopyMsgId = copy.message_id;
    else {
      await ctx.reply(
        "⚠️ <b>Shablonni ko'rsatib bo'lmadi</b> — xabar o'chirilgan bo'lishi mumkin.\n" +
        "Yuborishdan oldin xabarni qaytadan yuboring."
      );
    }
  }

  const btnCount = bcast.buttons.flat().length;
  const panel = await ctx.reply(
    `👁 <b>Ko'rinish</b>\n\n` +
    `🎯 Nishon: <b>${targetLabel(bcast)}</b>\n` +
    `🔘 Knopkalar: <b>${btnCount}</b> ta`,
    {
      reply_markup: kb(
        [ibtn("➕ Knopka qo'shish", "bc:addbtn",  "primary", BE.chAdd)],
        ...(btnCount > 0 ? [[ibtn("🗑 Barcha knopkalarni tozalash", "bc:clearbtn", "danger")]] : []),
        [ibtn("▶️ Yuborish",  "bc:confirm", "success", BE.check)],
        [ibtn("❌ Bekor",      "bc:menu",   "danger")],
      ),
    }
  );
  bcast.previewPanelMsgId = panel.message_id;
  setBcast(ctx, bcast);
}

function targetLabel(bcast: BcastData): string {
  if (bcast.target.type === "all") return "Hammaga";
  if (bcast.target.type === "region") return `Viloyat: ${bcast.target.region}`;
  if (bcast.target.type === "funnel") return `Funnel javobchilari`;
  return "?";
}

// ─── Knopka qo'shish ─────────────────────────────────────────────────────────

broadcastHandler.callbackQuery("bc:addbtn", async (ctx) => {
  const bcast = getBcast(ctx);
  if (!bcast) { await ctx.answerCallbackQuery(); return; }
  if (bcast.buttons.flat().length >= MAX_BTN_TOTAL) {
    await ctx.answerCallbackQuery({
      text: `Knopkalar soni ${MAX_BTN_TOTAL} tadan oshmasligi kerak.`,
      show_alert: true,
    });
    return;
  }
  await ctx.answerCallbackQuery();
  bcast.state = "btnText";
  setBcast(ctx, bcast);
  await ctx.reply("✏️ Knopka <b>matnini</b> kiriting:");
});

broadcastHandler.callbackQuery("bc:clearbtn", async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Barcha knopkalar tozalandi." });
  const bcast = getBcast(ctx);
  if (!bcast) return;
  bcast.buttons = [];
  bcast.state = "preview";
  setBcast(ctx, bcast);
  await showPreview(ctx, bcast);
});

// ─── Yuborish ────────────────────────────────────────────────────────────────

// Tasdiqlash — bir bosishda butun bazaga ketib qolmasin
broadcastHandler.callbackQuery("bc:confirm", async (ctx) => {
  const bcast = getBcast(ctx);
  if (!bcast?.templateChatId || !bcast.templateMsgId) {
    await ctx.answerCallbackQuery({ text: "Xabar shabloni topilmadi.", show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();

  const users = await getTargetUsers(bcast);
  if (users.length === 0) {
    await ctx.editMessageText(
      "⚠️ <b>Bu nishonda birorta ham foydalanuvchi yo'q.</b>",
      { reply_markup: kb([ibtn("Orqaga", "bc:menu", undefined, BE.backMenu)]) }
    ).catch(() => {});
    return;
  }

  const btnCount = bcast.buttons.flat().length;
  // ~20 xabar/sekund
  const mins = Math.max(1, Math.ceil(users.length / 20 / 60));

  await ctx.editMessageText(
    `⚠️ <b>Tasdiqlang</b>\n\n` +
    `🎯 Nishon: <b>${targetLabel(bcast)}</b>\n` +
    `👥 Qabul qiluvchilar: <b>${users.length}</b> ta\n` +
    `🔘 Knopkalar: <b>${btnCount}</b> ta\n` +
    `⏱ Taxminiy vaqt: <b>~${mins} daqiqa</b>\n\n` +
    `<i>Yuborilgan xabarni qaytarib bo'lmaydi.</i>`,
    {
      reply_markup: kb(
        [ibtn(`✅ Ha, ${users.length} kishiga yuborish`, "bc:send", "success", BE.check)],
        [ibtn("⬅️ Orqaga", "bc:preview", undefined, BE.backMenu)],
        [ibtn("❌ Bekor", "bc:menu", "danger")],
      ),
    }
  ).catch(() => {});
});

// Tasdiqlash ekranidan ko'rinishga qaytish
broadcastHandler.callbackQuery("bc:preview", async (ctx) => {
  await ctx.answerCallbackQuery();
  const bcast = getBcast(ctx);
  if (!bcast) return;
  // Tasdiqlash ekrani panelning o'rniga chizilgan — uni ham tozalab yuboramiz
  bcast.previewPanelMsgId = ctx.callbackQuery.message?.message_id;
  await showPreview(ctx, bcast);
});

broadcastHandler.callbackQuery("bc:send", async (ctx) => {
  const bcast = getBcast(ctx);
  if (!bcast?.templateChatId || !bcast.templateMsgId) {
    await ctx.answerCallbackQuery({ text: "Xabar shabloni topilmadi.", show_alert: true });
    return;
  }
  // Qulf: webhook rejimida Telegram javob kutmay update'ni qayta yuborishi va
  // xabar ikki marta ketishi mumkin edi; ikkita parallel broadcast ham bo'lmasin.
  if (!acquireBulkLock(BULK_KEY)) {
    await ctx.answerCallbackQuery({ text: "Hozir boshqa yuborish davom etmoqda.", show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery({ text: "Yuborilmoqda..." });
  clearBcast(ctx);

  const chatId = ctx.chat!.id;
  const statusMsgId = ctx.callbackQuery.message?.message_id;

  // Ko'rinish nusxasi endi keraksiz — chatni tozalab qo'yamiz
  if (bcast.previewCopyMsgId) {
    await ctx.api.deleteMessage(chatId, bcast.previewCopyMsgId).catch(() => {});
  }

  // MUHIM: siklni handler ichida kutib turmaymiz. Aks holda webhook rejimida
  // HTTP so'rov daqiqalab ochiq qolib, Telegram update'ni qayta yuborardi.
  void runBroadcast(ctx, bcast, chatId, statusMsgId);
});

/** Ommaviy yuborishni fon rejimida bajaradi va holatni tahrirlab boradi */
async function runBroadcast(
  ctx: MyContext,
  bcast: BcastData,
  chatId: number,
  statusMsgId?: number,
): Promise<void> {
  try {
    const users = await getTargetUsers(bcast);
    const ikb = buildInlineKb(bcast.buttons);

    const cancelKb = kb([ibtn("⛔️ To'xtatish", "bc:stop", "danger")]);
    const setStatus = async (text: string, markup?: ReturnType<typeof kb>) => {
      if (!statusMsgId) return;
      await ctx.api.editMessageText(chatId, statusMsgId, text, { reply_markup: markup }).catch(() => {});
    };

    await setStatus(`⏳ Yuborilmoqda: 0 / ${users.length}...`, cancelKb);

    const result = await bulkSend({
      userIds: users,
      send: (uid) =>
        ctx.api.copyMessage(uid, bcast.templateChatId!, bcast.templateMsgId!, { reply_markup: ikb }),
      isCancelled: () => isBulkCancelled(BULK_KEY),
      onProgress: async (r) => {
        if (r.processed < r.total) {
          await setStatus(`⏳ Yuborilmoqda: ${r.processed} / ${r.total}...`, cancelKb);
        }
      },
    });

    // Tarixga yozamiz — shablon va xato bo'lganlar bilan (qayta yuborish uchun)
    const record = await saveBroadcastRecord(bcast, result);

    const rows = [[ibtn("Menyuga", "bc:menu", "primary", BE.backMenu)]];
    if (record && result.failedIds.length > 0) {
      rows.unshift([
        ibtn(`🔁 Xato bo'lganlarga qayta yuborish (${result.failedIds.length})`, `bc:retry:${record.id}`, "primary"),
      ]);
    }

    await setStatus(
      `${ce("check")} <b>Xabar yuborish tugadi!</b>\n\n` +
      `🎯 Nishon: <b>${targetLabel(bcast)}</b>\n` +
      `${formatBulkResult(result)}`,
      kb(...rows),
    );
  } catch (err) {
    console.error("🛑 Broadcast xatosi:", err);
    await ctx.api.sendMessage(chatId, "❌ Yuborishda kutilmagan xato yuz berdi.").catch(() => {});
  } finally {
    releaseBulkLock(BULK_KEY);
  }
}

/** Yuborish natijasini tarixga yozadi (qayta yuborish uchun shablon bilan) */
async function saveBroadcastRecord(bcast: BcastData, result: BulkResult) {
  return prisma.broadcast.create({
    data: {
      targetType: bcast.target.type,
      targetExtra: JSON.stringify(bcast.target),
      sentCount: result.sent,
      failCount: result.failed,
      blockedCount: result.blocked,
      abortReason: result.aborted ? (result.abortReason ?? "to'xtatildi") : null,
      templateChatId: bcast.templateChatId ? BigInt(bcast.templateChatId) : null,
      templateMsgId: bcast.templateMsgId ?? null,
      buttonsJson: bcast.buttons.length ? JSON.stringify(bcast.buttons) : null,
      failedIds: result.failedIds.length ? JSON.stringify(result.failedIds.map(String)) : null,
    },
  }).catch(() => null);
}

// ─── Tarix ───────────────────────────────────────────────────────────────────

const HISTORY_PAGE = 8;

/** Saqlangan id ro'yxatini xavfsiz o'qish (buzuq JSON botni yiqitmasin) */
function parseIdList(json: string | null): string[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr.map(String) : [];
  } catch {
    return [];
  }
}

/** Saqlangan knopkalarni xavfsiz o'qish */
function parseButtons(json: string | null): InlineBtn[][] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? (arr as InlineBtn[][]) : [];
  } catch {
    return [];
  }
}

function targetTypeLabel(type: string): string {
  return { all: "Hammaga", daterange: "Sana oralig'i", region: "Viloyat", funnel: "Funnel" }[type] ?? type;
}

broadcastHandler.callbackQuery(/^bc:history:(\d+)$/, async (ctx) => {
  const page = Number(ctx.match[1]);
  const total = await prisma.broadcast.count();
  if (total === 0) {
    await ctx.answerCallbackQuery({ text: "Hozircha yuborishlar tarixi bo'sh.", show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();

  const items = await prisma.broadcast.findMany({
    orderBy: { createdAt: "desc" },
    skip: page * HISTORY_PAGE,
    take: HISTORY_PAGE,
  });

  const rows = items.map((b) => [
    ibtn(
      `${b.abortReason ? "⛔️" : "✅"} ${formatUzDateTime(b.createdAt)} · ${b.sentCount} ta`,
      `bc:hist:${b.id}`,
      "primary",
    ),
  ]);

  const pages = Math.max(1, Math.ceil(total / HISTORY_PAGE));
  const nav: ReturnType<typeof ibtn>[] = [];
  if (page > 0) nav.push(ibtn("⬅️", `bc:history:${page - 1}`));
  if (pages > 1) nav.push(ibtn(`${page + 1}/${pages}`, "bc:noop"));
  if (page < pages - 1) nav.push(ibtn("➡️", `bc:history:${page + 1}`));
  if (nav.length) rows.push(nav);
  rows.push([ibtn("Orqaga", "bc:menu", undefined, BE.backMenu)]);

  await ctx.editMessageText(
    `🗂 <b>Yuborishlar tarixi</b> (${total})\n\n<i>Batafsil ko'rish uchun tanlang.</i>`,
    { reply_markup: kb(...rows) }
  ).catch(() => {});
});

broadcastHandler.callbackQuery("bc:noop", (ctx) => ctx.answerCallbackQuery());

broadcastHandler.callbackQuery(/^bc:hist:(\d+)$/, async (ctx) => {
  const b = await prisma.broadcast.findUnique({ where: { id: Number(ctx.match[1]) } });
  if (!b) { await ctx.answerCallbackQuery({ text: "Topilmadi.", show_alert: true }); return; }
  await ctx.answerCallbackQuery();

  let targetText = targetTypeLabel(b.targetType);
  try {
    const t = JSON.parse(b.targetExtra ?? "{}");
    if (t.region) targetText += `: ${t.region}`;
    if (t.dateFrom && t.dateTo) targetText += `: ${t.dateFrom} – ${t.dateTo}`;
  } catch { /* eski yozuvlar boshqa formatda bo'lishi mumkin */ }

  const failedIds = parseIdList(b.failedIds);
  const canRetry = failedIds.length > 0 && b.templateChatId != null && b.templateMsgId != null;

  const text =
    `🗂 <b>Yuborish #${b.id}</b>\n\n` +
    `📅 Sana: <b>${formatUzDateTime(b.createdAt)}</b>\n` +
    `🎯 Nishon: <b>${e.escapeHtml(targetText)}</b>\n` +
    `✅ Yuborildi: <b>${b.sentCount}</b>\n` +
    `🚫 Bloklagan/o'chirgan: <b>${b.blockedCount}</b>\n` +
    `⚠️ Vaqtinchalik xato: <b>${b.failCount}</b>\n` +
    (b.abortReason ? `\n⛔️ <b>To'xtatilgan:</b> ${e.escapeHtml(b.abortReason)}\n` : "") +
    (failedIds.length > 0
      ? `\n<i>${failedIds.length} ta foydalanuvchiga qayta yuborish mumkin.</i>`
      : "");

  const rows: ReturnType<typeof ibtn>[][] = [];
  if (canRetry) {
    rows.push([ibtn(`🔁 Qayta yuborish (${failedIds.length})`, `bc:retry:${b.id}`, "success")]);
  } else if (failedIds.length > 0) {
    rows.push([ibtn("🔁 Shablon saqlanmagan — qayta yuborib bo'lmaydi", "bc:noop")]);
  }
  rows.push([ibtn("Orqaga", "bc:history:0", undefined, BE.backMenu)]);

  await ctx.editMessageText(text, { reply_markup: kb(...rows) }).catch(() => {});
});

// ─── Xato bo'lganlarga qayta yuborish ────────────────────────────────────────

broadcastHandler.callbackQuery(/^bc:retry:(\d+)$/, async (ctx) => {
  const b = await prisma.broadcast.findUnique({ where: { id: Number(ctx.match[1]) } });
  const idStrings = parseIdList(b?.failedIds ?? null);
  if (!b || idStrings.length === 0 || b.templateChatId == null || b.templateMsgId == null) {
    await ctx.answerCallbackQuery({ text: "Qayta yuborish uchun ma'lumot yo'q.", show_alert: true });
    return;
  }
  if (!acquireBulkLock(BULK_KEY)) {
    await ctx.answerCallbackQuery({ text: "Hozir boshqa yuborish davom etmoqda.", show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery({ text: "Qayta yuborilmoqda..." });

  const ids = idStrings.map((s) => BigInt(s));
  const ikb = buildInlineKb(parseButtons(b.buttonsJson));
  const chatId = ctx.chat!.id;
  const statusMsgId = ctx.callbackQuery.message?.message_id;

  void (async () => {
    try {
      const setStatus = async (text: string, markup?: ReturnType<typeof kb>) => {
        if (!statusMsgId) return;
        await ctx.api.editMessageText(chatId, statusMsgId, text, { reply_markup: markup }).catch(() => {});
      };
      await setStatus(`🔁 Qayta yuborilmoqda: 0 / ${ids.length}...`, kb([ibtn("⛔️ To'xtatish", "bc:stop", "danger")]));

      const result = await bulkSend({
        userIds: ids,
        send: (uid) =>
          ctx.api.copyMessage(uid, Number(b.templateChatId), b.templateMsgId!, { reply_markup: ikb }),
        isCancelled: () => isBulkCancelled(BULK_KEY),
        onProgress: async (r) => {
          if (r.processed < r.total) {
            await setStatus(`🔁 Qayta yuborilmoqda: ${r.processed} / ${r.total}...`);
          }
        },
      });

      // Yangi natijani yozib, eski yozuvdagi xatolar ro'yxatini yopamiz
      await prisma.broadcast.update({
        where: { id: b.id },
        data: { failedIds: null },
      }).catch(() => null);
      await prisma.broadcast.create({
        data: {
          targetType: b.targetType,
          targetExtra: b.targetExtra,
          sentCount: result.sent,
          failCount: result.failed,
          blockedCount: result.blocked,
          abortReason: result.aborted ? (result.abortReason ?? "to'xtatildi") : null,
          templateChatId: b.templateChatId,
          templateMsgId: b.templateMsgId,
          buttonsJson: b.buttonsJson,
          failedIds: result.failedIds.length ? JSON.stringify(result.failedIds.map(String)) : null,
        },
      }).catch(() => null);

      await setStatus(
        `${ce("check")} <b>Qayta yuborish tugadi!</b>\n\n${formatBulkResult(result)}`,
        kb([ibtn("Tarixga", "bc:history:0", "primary", BE.backMenu)]),
      );
    } catch (err) {
      console.error("🛑 Qayta yuborish xatosi:", err);
    } finally {
      releaseBulkLock(BULK_KEY);
    }
  })();
});

broadcastHandler.callbackQuery("bc:stop", async (ctx) => {
  if (!isBulkRunning(BULK_KEY)) {
    await ctx.answerCallbackQuery({ text: "Yuborish allaqachon tugagan.", show_alert: true });
    return;
  }
  cancelBulk(BULK_KEY);
  await ctx.answerCallbackQuery({ text: "⛔️ To'xtatilmoqda...", show_alert: true });
});

// ─── Noto'g'ri bloklanganlarni tiklash ───────────────────────────────────────
// Eski kod har qanday xatoni (429, tarmoq uzilishi, Telegram 5xx) "foydalanuvchi
// bloklagan" deb belgilagan. Bu tugma ro'yxatni tozalaydi — keyingi yuborishda
// haqiqatan bloklaganlar to'g'ri tasnif bilan qaytadan aniqlanadi.
broadcastHandler.callbackQuery("bc:unblock", async (ctx) => {
  const count = await prisma.user.count({ where: { isBlocked: true } });
  if (count === 0) {
    await ctx.answerCallbackQuery({ text: "Bloklangan foydalanuvchi yo'q.", show_alert: true });
    return;
  }
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    `♻️ <b>Bloklanganlar ro'yxatini tiklash</b>\n\n` +
    `Hozir <b>${count}</b> ta foydalanuvchi "bloklagan" deb belgilangan.\n\n` +
    `<i>Ular orasida tarmoq xatosi tufayli noto'g'ri belgilanganlari ham bor. ` +
    `Tiklasangiz keyingi yuborishda haqiqatan bloklaganlar qaytadan aniqlanadi — ` +
    `bir martalik qo'shimcha yuklama, lekin ro'yxat to'g'rilanadi.</i>`,
    {
      reply_markup: kb(
        [ibtn(`♻️ Ha, ${count} tasini tiklash`, "bc:unblock:yes", "success")],
        [ibtn("❌ Bekor", "bc:menu", "danger")],
      ),
    }
  ).catch(() => {});
});

broadcastHandler.callbackQuery("bc:unblock:yes", async (ctx) => {
  const res = await prisma.user.updateMany({ where: { isBlocked: true }, data: { isBlocked: false } });
  await ctx.answerCallbackQuery({ text: `♻️ ${res.count} ta foydalanuvchi tiklandi.`, show_alert: true });
  await ctx.editMessageText(
    `${ce("check")} <b>${res.count}</b> ta foydalanuvchi ro'yxatga qaytarildi.`,
    { reply_markup: kb([ibtn("Menyuga", "bc:menu", "primary", BE.backMenu)]) }
  ).catch(() => {});
});

async function getTargetUsers(bcast: BcastData): Promise<bigint[]> {
  const t = bcast.target;

  if (t.type === "all") {
    const rows = await prisma.user.findMany({ where: { isBlocked: false }, select: { id: true } });
    return rows.map((r) => r.id);
  }

  if (t.type === "region" && t.region) {
    const rows = await prisma.user.findMany({
      where: { isBlocked: false, region: t.region },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }

  if (t.type === "funnel" && t.surveyId) {
    const where = t.optionId
      ? { surveyId: t.surveyId, optionId: t.optionId }
      : { surveyId: t.surveyId };
    const responses = await prisma.surveyResponse.findMany({ where, select: { userId: true } });
    // Bloklaganlarni chiqarib tashlaymiz — boshqa nishonlarda bu filtr bor edi, bu yerda yo'q edi
    const alive = await prisma.user.findMany({
      where: { id: { in: responses.map((r) => r.userId) }, isBlocked: false },
      select: { id: true },
    });
    return alive.map((u) => u.id);
  }

  return [];
}
