import { Composer } from "grammy";
import { adminCan } from "../../config.js";
import { prisma } from "../../prisma.js";
import { ce, e } from "../../utils/emoji.js";
import { ADMIN_MENU_BUTTONS, ibtn, BE, kb, adminMenuKeyboard } from "../../utils/keyboard.js";
import { getBool, setBool, KEYS } from "../../utils/settings.js";
import { UZ_REGIONS } from "../../utils/regions.js";
import { formatYmd, parseYmd, rangeFromStrings } from "../../utils/dateRange.js";
import {
  acquireBulkLock,
  bulkSend,
  formatBulkResult,
  isBulkCancelled,
  releaseBulkLock,
} from "../../services/bulkSend.js";
import type { MyContext } from "../../types.js";

/** broadcast.ts bilan bir xil qulf — bir vaqtda bitta ommaviy yuborish */
const BULK_KEY = "broadcast";
import type { Survey, SurveyOption } from "@prisma/client";

export const funnelHandler = new Composer<MyContext>();

// ─── Foydalanuvchiga so'rovnoma yuborish (broadcast va zanjir uchun umumiy) ──

/** Bitta foydalanuvchiga so'rovnoma savolini yuboradi; viloyat so'rovi bo'lsa va
 * avto-manzil yoqilgan bo'lsa, GPS orqali aniqlash tugmasi bilan qo'shimcha xabar ham yuboradi. */
export async function pushSurveyToUser(
  ctx: MyContext,
  userId: number | bigint,
  survey: Pick<Survey, "id" | "question" | "isRegionSurvey"> & {
    options: Pick<SurveyOption, "id" | "text">[];
  }
): Promise<void> {
  // Viloyat so'rovnomasi — 1 qatorda 2 tadan (qisqa nomlar); boshqalari 1 qatorda 1 tadan
  const perRow = survey.isRegionSurvey ? 2 : 1;
  const buttons = survey.options.map((o) => ({
    text: o.text,
    callback_data: `svr:ans:${survey.id}:${o.id}`,
  }));
  const inline_keyboard: (typeof buttons)[number][][] = [];
  for (let i = 0; i < buttons.length; i += perRow)
    inline_keyboard.push(buttons.slice(i, i + perRow));
  const ikb = { inline_keyboard };
  // Asosiy xabar — muvaffaqiyatsiz bo'lsa chaqiruvchiga otiladi (bloklangan foydalanuvchini aniqlash uchun)
  // Savol admin kiritgan matn — parse_mode HTML bilan ishlatiladi. Qochirilmasa bitta
  // '<' yoki '&' butun ommaviy yuborishni FATAL deb to'xtatib qo'yardi.
  await ctx.api.sendMessage(Number(userId), e.escapeHtml(survey.question), {
    reply_markup: ikb,
    parse_mode: "HTML",
  });

  if (survey.isRegionSurvey && (await getBool(KEYS.geoDetectEnabled, false))) {
    await ctx.api
      .sendMessage(
        Number(userId),
        "📍 Yoki manzilingizni <b>avtomatik</b> aniqlatishingiz mumkin:",
        {
          parse_mode: "HTML",
          reply_markup: {
            keyboard: [[{ text: "📍 Manzilni avtomatik aniqlash", request_location: true }]],
            resize_keyboard: true,
            one_time_keyboard: true,
          },
        }
      )
      .catch(() => {});
  }
}

/** Javob berilgach zanjirdagi keyingi so'rovnomani (bo'lsa) avtomatik yuboradi */
export async function continueSurveyChain(
  ctx: MyContext,
  userId: number | bigint,
  prevSurveyId: number
): Promise<void> {
  const prev = await prisma.survey.findUnique({ where: { id: prevSurveyId } });
  if (!prev?.nextSurveyId) return;
  const next = await prisma.survey.findUnique({
    where: { id: prev.nextSurveyId },
    include: { options: { orderBy: { sortOrder: "asc" } } },
  });
  if (!next) return;
  try {
    await pushSurveyToUser(ctx, userId, next);
    await prisma.survey
      .update({ where: { id: next.id }, data: { sentCount: { increment: 1 } } })
      .catch(() => null);
  } catch {
    // Foydalanuvchi botni bloklagan bo'lishi mumkin — e'tibor bermaymiz
  }
}

// ─── Session yordamchilari ───────────────────────────────────────────────────

type FState =
  "title" | "question" | "options" | "sendTarget" | "sendDateFrom" | "sendDateTo" | "sendSurvey";

interface FData {
  state: FState;
  surveyId?: number;
  title?: string;
  question?: string;
  options: string[];
  sendDateFrom?: string;
}

function getF(ctx: MyContext): FData | null {
  return (ctx.session.scratch?.funnel as FData) ?? null;
}
function setF(ctx: MyContext, d: FData) {
  ctx.session.scratch = { ...(ctx.session.scratch ?? {}), funnel: d };
}
function clearF(ctx: MyContext) {
  if (ctx.session.scratch) delete ctx.session.scratch.funnel;
}

// ─── Asosiy menyu ────────────────────────────────────────────────────────────

async function funnelMenu() {
  const geoOn = await getBool(KEYS.geoDetectEnabled, false);
  return kb(
    [ibtn("So'rovnoma yaratish", "fn:create", "success", BE.chAdd)],
    [ibtn("✨ Standart (Viloyat+Jins)", "fn:defaultcreate", "primary")],
    [ibtn("Natijalar", "fn:stat:0", "primary", BE.stats)],
    [ibtn("So'rovnoma yuborish", "fn:send:0", "primary", BE.broadcast)],
    [
      ibtn(
        geoOn ? "📍 Avto-manzil: Yoqilgan" : "📍 Avto-manzil: O'chirilgan",
        "fn:geotoggle",
        geoOn ? "success" : "danger"
      ),
    ],
    [ibtn("O'chirish", "fn:delete:0", "danger", BE.chDelete)],
    [ibtn("Orqaga", "bc:menu", undefined, BE.backMenu)]
  );
}

funnelHandler.hears(ADMIN_MENU_BUTTONS.funnel, async (ctx) => {
  if (!adminCan(ctx.from?.id ?? 0, "funnel")) return;
  clearF(ctx);
  await ctx.reply("<b>Funnel — So'rovnomalar</b>", { reply_markup: await funnelMenu() });
});

funnelHandler.callbackQuery("fn:geotoggle", async (ctx) => {
  const cur = await getBool(KEYS.geoDetectEnabled, false);
  await setBool(KEYS.geoDetectEnabled, !cur);
  await ctx.answerCallbackQuery({
    text: !cur ? "✅ Avto-manzil aniqlash yoqildi" : "❌ Avto-manzil aniqlash o'chirildi",
    show_alert: true,
  });
  await ctx.editMessageReplyMarkup({ reply_markup: await funnelMenu() }).catch(() => {});
});

// Standart so'rovnoma zanjiri: Viloyat (barcha hududlar) -> javobdan keyin Jins.
// O'ZI TUZATADIGAN: agar eski (zanjirlanmagan) viloyat so'rovnomasi mavjud bo'lsa,
// yangisini yaratmaydi — o'shanga Jins so'rovnomasini bog'lab qo'yadi.
funnelHandler.callbackQuery("fn:defaultcreate", async (ctx) => {
  await ctx.answerCallbackQuery();

  const existingRegion = await prisma.survey.findFirst({
    where: { isRegionSurvey: true },
    orderBy: { createdAt: "desc" },
  });

  if (existingRegion?.nextSurveyId) {
    await ctx
      .editMessageText("ℹ️ Standart so'rovnoma zanjiri allaqachon mavjud va bog'langan.", {
        reply_markup: kb(
          [
            ibtn(
              "▶️ Hozir yuborish",
              `fn:sendsurvey:${existingRegion.id}`,
              "success",
              BE.broadcast
            ),
          ],
          [ibtn("Menyuga qaytish", "fn:menu", "primary", BE.backMenu)]
        ),
      })
      .catch(() => {});
    return;
  }

  const genderSurvey = await prisma.survey.create({
    data: {
      title: "Jins",
      question: "👤 Jinsingizni tanlang:",
      isGenderSurvey: true,
      options: {
        create: [
          { text: "👨 Erkak", sortOrder: 0 },
          { text: "👩 Ayol", sortOrder: 1 },
        ],
      },
    },
  });

  const regionSurvey = existingRegion
    ? await prisma.survey.update({
        where: { id: existingRegion.id },
        data: { nextSurveyId: genderSurvey.id },
      })
    : await prisma.survey.create({
        data: {
          title: "Viloyat",
          question: "🗺 Qaysi hududdansiz?",
          isRegionSurvey: true,
          nextSurveyId: genderSurvey.id,
          options: { create: UZ_REGIONS.map((r, i) => ({ text: r.name, sortOrder: i })) },
        },
      });

  await ctx
    .editMessageText(
      `✅ <b>Standart so'rovnoma zanjiri yaratildi!</b>\n\n` +
        `1️⃣ Viloyat (${UZ_REGIONS.length} ta hudud, 1 qatorda 2 tadan)\n` +
        `2️⃣ Jins — javob berilgach avtomatik yuboriladi\n\n` +
        `<i>Yuborilganda foydalanuvchi ro'yxatdan viloyatini tanlaydi yoki (yoqilgan bo'lsa) ` +
        `GPS orqali avtomatik aniqlatadi. Natijalarni "Auditoriyaga qarab yuborish" uchun ` +
        `Xabar yuborish → Viloyat bo'yicha bo'limida ishlating.</i>`,
      {
        reply_markup: kb(
          [ibtn("▶️ Hozir yuborish", `fn:sendsurvey:${regionSurvey.id}`, "success", BE.broadcast)],
          [ibtn("Menyuga qaytish", "fn:menu", "primary", BE.backMenu)]
        ),
      }
    )
    .catch(() => {});
});

funnelHandler.callbackQuery("fn:close", async (ctx) => {
  await ctx.answerCallbackQuery();
  clearF(ctx);
  await ctx.deleteMessage().catch(() => {});
  await ctx.reply("Admin panel:", { reply_markup: adminMenuKeyboard(ctx.from.id) });
});

funnelHandler.callbackQuery("fn:menu", async (ctx) => {
  await ctx.answerCallbackQuery();
  clearF(ctx);
  await ctx
    .editMessageText("<b>Funnel — So'rovnomalar</b>", { reply_markup: await funnelMenu() })
    .catch(() => {});
});

// ─── Yaratish ────────────────────────────────────────────────────────────────

funnelHandler.callbackQuery("fn:create", async (ctx) => {
  await ctx.answerCallbackQuery();
  setF(ctx, { state: "title", options: [] });
  await ctx
    .editMessageText(
      "1️⃣ So'rovnoma <b>sarlavhasini</b> kiriting (admin uchun, foydalanuvchiga ko'rinmaydi):",
      { reply_markup: kb([ibtn("❌ Bekor qilish", "fn:menu", "danger")]) }
    )
    .catch(() => {});
});

// ─── Natijalar ───────────────────────────────────────────────────────────────

// So'rovnoma tanlash (natija/yuborish/o'chirish) — sahifalanadi, aks holda
// 20 tadan ko'p so'rovnoma bo'lsa eskilarga umuman erishib bo'lmas edi.
type SurveyPickerMode = "stat" | "send" | "delete";
const FUNNEL_PAGE = 15;

async function renderSurveyPicker(ctx: MyContext, mode: SurveyPickerMode, page: number) {
  const total = await prisma.survey.count();
  const pages = Math.max(1, Math.ceil(total / FUNNEL_PAGE));
  const p = Math.min(page, pages - 1); // oxirgi sahifadagi so'rovnoma o'chirilsa clamp
  const surveys = await prisma.survey.findMany({
    orderBy: { createdAt: "desc" },
    skip: p * FUNNEL_PAGE,
    take: FUNNEL_PAGE,
  });
  if (surveys.length === 0) {
    await ctx.answerCallbackQuery({ text: "Hozircha so'rovnoma yo'q.", show_alert: true });
    return;
  }

  const rows: ReturnType<typeof ibtn>[][] = [];
  for (const s of surveys) {
    if (mode === "stat") rows.push([ibtn(s.title, `fn:stat:${s.id}`, "primary")]);
    else if (mode === "send") rows.push([ibtn(s.title, `fn:sendsurvey:${s.id}`, "primary")]);
    else rows.push([ibtn(s.title, `fn:delask:${s.id}`, "danger", BE.chDelete)]);
  }
  const nav: ReturnType<typeof ibtn>[] = [];
  if (p > 0) nav.push(ibtn("⬅️", `fn:${mode}:${p - 1}`));
  nav.push(ibtn(`${p + 1}/${pages}`, "noop:fn"));
  if (p < pages - 1) nav.push(ibtn("➡️", `fn:${mode}:${p + 1}`));
  rows.push(nav);
  rows.push([ibtn("Orqaga", "fn:menu", undefined, BE.backMenu)]);

  const titles: Record<SurveyPickerMode, string> = {
    stat: "<b>Qaysi so'rovnoma natijasi?</b>",
    send: "<b>Qaysi so'rovnomani yuborasiz?</b>",
    delete: "<b>Qaysi so'rovnomani o'chirasiz?</b>",
  };
  await ctx.editMessageText(titles[mode], { reply_markup: kb(...rows) }).catch(() => {});
}

funnelHandler.callbackQuery(/^fn:(stat|send|delete):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await renderSurveyPicker(ctx, ctx.match[1] as SurveyPickerMode, Number(ctx.match[2]));
});

funnelHandler.callbackQuery("noop:fn", (ctx) => ctx.answerCallbackQuery());

funnelHandler.callbackQuery(/^fn:stat:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const survey = await prisma.survey.findUnique({
    where: { id: Number(ctx.match[1]) },
    include: {
      options: {
        orderBy: { sortOrder: "asc" },
        include: { _count: { select: { responses: true } } },
      },
    },
  });
  if (!survey) return;

  const totalSent = survey.sentCount;
  const totalAnswered = await prisma.surveyResponse.count({ where: { surveyId: survey.id } });
  const notAnswered = Math.max(0, totalSent - totalAnswered);

  const lines = [
    `<b>${e.escapeHtml(survey.title)}</b>`,
    `${e.escapeHtml(survey.question)}`,
    ``,
    `Yuborilgan: <b>${totalSent}</b>`,
    `Javob berdi: <b>${totalAnswered}</b>`,
    `Javob bermadi: <b>${notAnswered}</b>`,
    ``,
    `<b>Natijalar:</b>`,
  ];

  for (const opt of survey.options) {
    const cnt = opt._count.responses;
    const pct = totalAnswered > 0 ? Math.round((cnt / totalAnswered) * 100) : 0;
    const bar = "█".repeat(Math.round(pct / 10)) + "░".repeat(10 - Math.round(pct / 10));
    lines.push(`${e.escapeHtml(opt.text)}: <b>${cnt}</b> (${pct}%)\n${bar}`);
  }

  await ctx
    .editMessageText(lines.join("\n"), {
      reply_markup: kb(
        [ibtn("Viloyat bo'yicha", `fn:statregion:${survey.id}`, "primary", BE.trend)],
        [ibtn("Orqaga", "fn:stat:0", undefined, BE.backMenu)]
      ),
    })
    .catch(() => {});
});

funnelHandler.callbackQuery(/^fn:statregion:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const surveyId = Number(ctx.match[1]);

  const responses = await prisma.surveyResponse.findMany({
    where: { surveyId },
    include: { option: true },
  });

  const byRegion: Record<string, Record<string, number>> = {};
  for (const r of responses) {
    const user = await prisma.user.findUnique({
      where: { id: r.userId },
      select: { region: true },
    });
    const region = user?.region ?? "Noma'lum";
    if (!byRegion[region]) byRegion[region] = {};
    const optText = r.option.text;
    byRegion[region][optText] = (byRegion[region][optText] ?? 0) + 1;
  }

  const lines = ["<b>Viloyat bo'yicha natijalar:</b>", ""];
  if (Object.keys(byRegion).length === 0) {
    lines.push("<i>Bu so'rovnomaga hali javob berilmagan.</i>");
  }
  for (const [region, opts] of Object.entries(byRegion).sort()) {
    const total = Object.values(opts).reduce((a, b) => a + b, 0);
    lines.push(`<b>${e.escapeHtml(region)}</b>: ${total} ta`);
    for (const [opt, cnt] of Object.entries(opts)) {
      lines.push(`  • ${e.escapeHtml(opt)}: ${cnt}`);
    }
  }

  await ctx
    .editMessageText(lines.join("\n"), {
      reply_markup: kb([ibtn("Orqaga", `fn:stat:${surveyId}`, undefined, BE.backMenu)]),
    })
    .catch(() => {});
});

// ─── Yuborish ────────────────────────────────────────────────────────────────

funnelHandler.callbackQuery(/^fn:sendsurvey:(\d+)$/, async (ctx) => {
  const surveyId = Number(ctx.match[1]);
  await ctx.answerCallbackQuery();
  setF(ctx, { state: "sendTarget", surveyId, options: [] });
  const count = await prisma.user.count({ where: { isBlocked: false } });
  await ctx
    .editMessageText(`<b>So'rovnoma yuborish</b>\n\nKimga yuborasiz?`, {
      reply_markup: kb(
        [ibtn("🧪 Sinov (faqat menga)", `fn:dosend:me`, "success")],
        [ibtn(`Hammaga (${count})`, `fn:dosend:all`, "primary", BE.stats)],
        [ibtn("Sana oralig'i bo'yicha", `fn:dosend:daterange`, "primary")],
        [ibtn("Orqaga", "fn:send:0", undefined, BE.backMenu)]
      ),
    })
    .catch(() => {});
});

funnelHandler.callbackQuery(/^fn:dosend:(all|daterange|me)$/, async (ctx) => {
  const mode = ctx.match[1];
  const f = getF(ctx);
  if (!f?.surveyId) {
    await ctx.answerCallbackQuery();
    return;
  }

  if (mode === "daterange") {
    await ctx.answerCallbackQuery();
    f.state = "sendDateFrom";
    setF(ctx, f);
    await ctx
      .editMessageText("Boshlanish sanasini kiriting (DD.MM.YYYY):", {
        reply_markup: kb([ibtn("❌ Bekor qilish", "fn:menu", "danger")]),
      })
      .catch(() => {});
    return;
  }

  if (mode === "me") {
    await ctx.answerCallbackQuery({ text: "Sinov yuborilmoqda..." });
    const survey = await prisma.survey.findUnique({
      where: { id: f.surveyId },
      include: { options: { orderBy: { sortOrder: "asc" } } },
    });
    if (!survey) {
      await ctx.reply("❌ So'rovnoma topilmadi.");
      return;
    }
    clearF(ctx);

    // Qayta-qayta sinash uchun ushbu zanjirdagi oldingi test javoblarini tozalaymiz
    // (aks holda "allaqachon javob bergansiz" bloklab, zanjir davom etmaydi)
    const userId = BigInt(ctx.from.id);
    let cur: { id: number; nextSurveyId: number | null } | null = survey;
    const visited = new Set<number>();
    while (cur && !visited.has(cur.id)) {
      visited.add(cur.id);
      await prisma.surveyResponse
        .deleteMany({ where: { surveyId: cur.id, userId } })
        .catch(() => null);
      cur = cur.nextSurveyId
        ? await prisma.survey.findUnique({
            where: { id: cur.nextSurveyId },
            select: { id: true, nextSurveyId: true },
          })
        : null;
    }

    try {
      await pushSurveyToUser(ctx, ctx.from.id, survey);
      // Admin javoblari statistikaga YOZILMAYDI (index.ts svr:ans admin-guard).
      // Pastdagi qoldiq tozalash eski test javoblari bo'lsa ham xavfsizroq.
      await ctx.reply(
        `${ce("check")} Sinov sifatida sizga yuborildi. Javoblaringiz statistikaga kirmaydi va profilingiz buzilmaydi.`
      );
    } catch {
      await ctx.reply("❌ Yuborib bo'lmadi.");
    }
    return;
  }

  await ctx.answerCallbackQuery({ text: "Yuborilmoqda..." });
  await sendSurveyToUsers(ctx, f.surveyId);
});

async function sendSurveyToUsers(ctx: MyContext, surveyId: number, from?: Date, to?: Date) {
  const survey = await prisma.survey.findUnique({
    where: { id: surveyId },
    include: { options: { orderBy: { sortOrder: "asc" } } },
  });
  if (!survey) return;

  let whereClause: Parameters<typeof prisma.user.findMany>[0] = { where: { isBlocked: false } };
  if (from && to) {
    whereClause = { where: { isBlocked: false, createdAt: { gte: from, lte: to } } };
  }

  const users = await prisma.user.findMany({ ...whereClause, select: { id: true } });
  const total = users.length;

  if (!acquireBulkLock(BULK_KEY)) {
    await ctx.reply("⏳ Hozir boshqa ommaviy yuborish davom etmoqda. Tugashini kuting.");
    return;
  }

  const chatId = ctx.chat!.id;
  // Katta so'rovnoma yuborilayotganda admin jarayonni to'xtata olsin.
  // bc:stop tugmasi broadcast.ts'da ishlanadi (bir xil BULK_KEY qulfi).
  const cancelKb = kb([ibtn("⛔️ To'xtatish", "bc:stop", "danger")]);
  const statusMsg = await ctx.reply(`Yuborilmoqda: 0 / ${total}...`, { reply_markup: cancelKb });
  clearF(ctx);

  // Fon rejimida — webhook so'rovi daqiqalab ochiq qolmasin
  void (async () => {
    try {
      const result = await bulkSend({
        userIds: users.map((u) => u.id),
        send: (uid) => pushSurveyToUser(ctx, uid, survey),
        isCancelled: () => isBulkCancelled(BULK_KEY),
        onProgress: async (r) => {
          if (r.processed < r.total) {
            await ctx.api
              .editMessageText(chatId, statusMsg.message_id, `⏳ ${r.processed} / ${r.total}...`, {
                reply_markup: cancelKb,
              })
              .catch(() => {});
          }
        },
      });

      if (result.sent > 0) {
        await prisma.survey
          .update({ where: { id: surveyId }, data: { sentCount: { increment: result.sent } } })
          .catch(() => null);
      }

      await ctx.api
        .editMessageText(
          chatId,
          statusMsg.message_id,
          `<b>So'rovnoma yuborildi!</b>\n\n${formatBulkResult(result)}`
        )
        .catch(() => {});
    } catch (err) {
      console.error("🛑 So'rovnoma yuborish xatosi:", err);
    } finally {
      releaseBulkLock(BULK_KEY);
    }
  })();
}

// ─── O'chirish ───────────────────────────────────────────────────────────────

// Tasdiqlash bosqichi — bitta bosishda so'rovnoma + barcha javoblar
// qaytarib bo'lmaydigan o'chib ketmasin (bc:unblock oqimidagidek ikki qadam).
funnelHandler.callbackQuery(/^fn:delask:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const survey = await prisma.survey.findUnique({
    where: { id: Number(ctx.match[1]) },
    select: { title: true },
  });
  if (!survey) return;
  await ctx
    .editMessageText(
      `⚠️ <b>${e.escapeHtml(survey.title)}</b> so'rovnomasi va unga berilgan ` +
        `<b>barcha javoblar</b> qaytarib bo'lmaydigan o'chiriladi.\n\nDavom etasizmi?`,
      {
        reply_markup: kb(
          [ibtn("🗑 Ha, o'chirish", `fn:delconf:${ctx.match[1]}`, "danger")],
          [ibtn("Yo'q", "fn:delete:0", "primary")]
        ),
      }
    )
    .catch(() => {});
});

funnelHandler.callbackQuery(/^fn:delconf:(\d+)$/, async (ctx) => {
  await prisma.survey.delete({ where: { id: Number(ctx.match[1]) } }).catch(() => {});
  await ctx.answerCallbackQuery({ text: "O'chirildi." });
  await ctx
    .editMessageText("So'rovnoma o'chirildi.", {
      reply_markup: kb([ibtn("Orqaga", "fn:menu", undefined, BE.backMenu)]),
    })
    .catch(() => {});
});

// ─── Matn kiritish (message handler) ────────────────────────────────────────

funnelHandler.on("message:text", async (ctx, next) => {
  if (!adminCan(ctx.from?.id ?? 0, "funnel")) return next();
  const f = getF(ctx);
  if (!f) return next();

  const text = ctx.message.text.trim();

  if (text === "❌ Bekor" || text === "❌ Bekor qilish" || text === "/cancel") {
    clearF(ctx);
    await ctx.reply("❌ Bekor qilindi.");
    return;
  }

  if (f.state === "title") {
    f.title = text.slice(0, 100);
    f.state = "question";
    setF(ctx, f);
    await ctx.reply("2️⃣ Foydalanuvchiga ko'rsatiladigan <b>savol</b> matnini kiriting:", {
      reply_markup: kb([ibtn("❌ Bekor qilish", "fn:menu", "danger")]),
    });
    return;
  }

  if (f.state === "question") {
    f.question = text.slice(0, 500);
    f.state = "options";
    setF(ctx, f);
    await ctx.reply(
      `3️⃣ Javob <b>variantlarini</b> kiriting — har biri alohida xabar.\n` +
        `Tugatish uchun <b>Tayyor</b> deb yozing.\n\n` +
        `<i>Viloyat so'rovnomasini yaratayotgan bo'lsangiz, har bir variant viloyat nomi bo'lsin.</i>`,
      {
        reply_markup: kb([
          ibtn("✅ Tayyor", "fn:optsdone", "success"),
          ibtn("❌ Bekor qilish", "fn:menu", "danger"),
        ]),
      }
    );
    return;
  }

  if (f.state === "options") {
    if (text.toLowerCase() === "tayyor") {
      await saveSurvey(ctx, f);
      return;
    }
    f.options.push(text.slice(0, 100));
    setF(ctx, f);
    await ctx.reply(
      `✅ Variant qo'shildi: <b>${e.escapeHtml(text.slice(0, 100))}</b>\n\n` +
        `Jami: ${f.options.length} ta variant. Yana kiriting yoki <b>Tayyor</b> deng:`,
      {
        reply_markup: kb([
          ibtn("✅ Tayyor", "fn:optsdone", "success"),
          ibtn("❌ Bekor qilish", "fn:menu", "danger"),
        ]),
      }
    );
    return;
  }

  if (f.state === "sendDateFrom") {
    const p = parseYmd(text);
    if (!p) {
      await ctx.reply("❌ Format: <code>DD.MM.YYYY</code> (mavjud sana bo'lsin)");
      return;
    }
    f.sendDateFrom = formatYmd(p);
    f.state = "sendDateTo";
    setF(ctx, f);
    await ctx.reply("Tugash sanasini kiriting (DD.MM.YYYY):", {
      reply_markup: kb([ibtn("❌ Bekor qilish", "fn:menu", "danger")]),
    });
    return;
  }

  if (f.state === "sendDateTo") {
    const p = parseYmd(text);
    if (!p) {
      await ctx.reply("❌ Format: <code>DD.MM.YYYY</code> (mavjud sana bo'lsin)");
      return;
    }
    // Sana oralig'i Toshkent vaqti (UTC+5) bo'yicha hisoblanadi
    const range = rangeFromStrings(f.sendDateFrom!, formatYmd(p));
    if (!range) {
      await ctx.reply("❌ Tugash sanasi boshlanish sanasidan oldin bo'lishi mumkin emas.");
      return;
    }
    if (!f.surveyId) return;
    await ctx.reply("⏳ Yuborilmoqda...");
    await sendSurveyToUsers(ctx, f.surveyId, range.gte, range.lte);
    return;
  }

  return next();
});

funnelHandler.callbackQuery("fn:optsdone", async (ctx) => {
  await ctx.answerCallbackQuery();
  const f = getF(ctx);
  if (!f) return;
  await saveSurvey(ctx, f);
});

async function saveSurvey(ctx: MyContext, f: FData) {
  if (!f.title || !f.question) {
    await ctx.reply("❌ Sarlavha yoki savol yo'q.");
    return;
  }
  if (f.options.length < 2) {
    await ctx.reply("❌ Kamida 2 ta variant kerak.");
    return;
  }

  const isRegion = f.options.some((o) =>
    /viloyat|shahar|toshkent|samarqand|farg|buxoro|xorazm|qashqadaryo|surxondaryo|jizzax|sirdaryo|navoiy|andijon|namangan/i.test(
      o
    )
  );
  const isGender =
    !isRegion &&
    f.options.length === 2 &&
    f.options.some((o) => /erkak|o'g'il|male/i.test(o)) &&
    f.options.some((o) => /ayol|qiz|female/i.test(o));

  const survey = await prisma.survey.create({
    data: {
      title: f.title,
      question: f.question,
      isRegionSurvey: isRegion,
      isGenderSurvey: isGender,
      options: {
        create: f.options.map((text, i) => ({ text, sortOrder: i })),
      },
    },
  });

  clearF(ctx);
  await ctx.reply(
    `<b>So'rovnoma yaratildi!</b>\n\n` +
      `Sarlavha: <b>${e.escapeHtml(f.title)}</b>\n` +
      `Savol: <b>${e.escapeHtml(f.question)}</b>\n` +
      `Variantlar: <b>${f.options.length}</b> ta\n` +
      (isRegion ? `Viloyat so'rovnomasi sifatida belgilandi.` : "") +
      (isGender ? `Jins so'rovnomasi sifatida belgilandi.` : ""),
    {
      reply_markup: kb(
        [ibtn("Hozir yuborish", `fn:sendsurvey:${survey.id}`, "success", BE.broadcast)],
        [ibtn("Menyuga qaytish", "fn:menu", "primary", BE.backMenu)]
      ),
    }
  );
}
