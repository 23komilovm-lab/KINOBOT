import { Composer, InlineKeyboard } from "grammy";
import { prisma } from "../prisma.js";
import { isAdmin } from "../config.js";
import { ce, e } from "../utils/emoji.js";
import { contentButtonMarkup } from "../utils/contentButton.js";
import { getGlobalButton, getBool, KEYS } from "../utils/settings.js";
import { deliverEpisode } from "../services/delivery.js";
import { getNextEpisode } from "../services/serialProgress.js";
import type { MyContext } from "../types.js";

export const serialViewHandler = new Composer<MyContext>();

/**
 * Serial sezonlari ro'yxatini chiqaradi. Views OSHIRILMAYDI — serial "ko'rildi"
 * faqat episod haqiqatan yetkazilganda hisoblanadi (deliverEpisode).
 *
 * Progress mavjud bo'lsa boshga "▶️ Davom etish" tugmasi qo'shiladi — keyingi
 * ko'rilmagan qismni ochadi (serialProgress.ts getNextEpisode).
 */
export async function sendSerialSeasons(ctx: MyContext, serialId: number) {
  const serial = await prisma.serial.findUnique({
    where: { id: serialId },
    include: { seasons: { orderBy: { number: "asc" } } },
  });
  if (!serial) {
    await ctx.reply("❌ Serial topilmadi.");
    return;
  }

  if (serial.seasons.length === 0) {
    await ctx.reply("⚠️ Bu serialda hali hech qanday sezon qo'shilmagan.");
    return;
  }

  // "Davom etish" — foydalanuvchining oxirgi qismidan keyingisi
  const uid = ctx.from?.id;
  const next = uid && !isAdmin(uid) ? await getNextEpisode(BigInt(uid), serial.id) : null;

  const rows = [];
  if (next) {
    rows.push([
      {
        // Qism formati video caption bilan bir xil: "N-sezon · M-qism"
        text: `▶️ Davom etish — ${next.season.number}-sezon · ${next.number}-qism`,
        callback_data: `ep:${next.id}`,
      },
    ]);
  }
  for (const s of serial.seasons) {
    rows.push([
      {
        text: `📂 ${s.number}-sezon${s.title ? ` · ${s.title}` : ""}`,
        callback_data: `season:${s.id}:0:0`,
      },
    ]);
  }
  rows.push([{ text: "❌ Yopish", callback_data: "serial:close" }]);

  const caption =
    `${ce("tv")} <b>${e.escapeHtml(serial.title)}</b>\n` +
    (serial.year ? `📅 ${serial.year}\n` : "") +
    (serial.caption ? `\n${e.escapeHtml(serial.caption)}\n` : "") +
    `\nSezonni tanlang:`;

  const enabled = await getBool(KEYS.serialBtnEnabled, true);
  const globalBtn = enabled
    ? await getGlobalButton("serial")
    : { buttonText: null, buttonUrl: null, buttonStyle: "primary" };
  const markup = contentButtonMarkup(globalBtn, rows);
  if (serial.posterId) {
    // Poster yuborilmasa (bloklangan user / eskirgan file_id) — butun ro'yxat
    // yiqilib ketmasin, matnli variantga tushamiz.
    try {
      await ctx.replyWithPhoto(serial.posterId, { caption, reply_markup: markup });
    } catch {
      await ctx.reply(caption, { reply_markup: markup });
    }
  } else {
    await ctx.reply(caption, { reply_markup: markup });
  }
}

// Har sahifada nechta qism tugmasi (3 ustunli qatorlar). Telegram 100 tugma
// chegarasiga tushmaslik va panelni ixcham saqlash uchun sahifalanadi.
const EPISODES_PER_PAGE = 15;

/**
 * Sezon qismlari ro'yxati (sahifalangan).
 *
 * Manzil formati `season:<id>:<from>:<page>`:
 *   from = 0 — sezonlar ro'yxatidan (yangi xabar, rasmli bo'lishi mumkin)
 *   from = 1 — qismlar navigatsiyasidan (mavjud xabarni tahrir)
 * Ilgari bu "Qismni tanlang:" matnidan snifflanardi — yorliq o'zgarsa buzilardi.
 * Ko'p qismli sezonlarda qismlar sahifalanadi va sahifa indikatori ko'rsatiladi.
 */
async function renderSeasonEpisodes(ctx: MyContext, seasonId: number, edit: boolean, page = 0) {
  const season = await prisma.season.findUnique({
    where: { id: seasonId },
    include: {
      episodes: { orderBy: { number: "asc" } },
      serial: { include: { seasons: { orderBy: { number: "asc" } } } },
    },
  });
  if (!season) {
    await ctx.reply("❌ Sezon topilmadi.");
    return;
  }
  if (season.episodes.length === 0) {
    // Bo'sh sezondan chiqish yo'li qolsin — "Orqaga" tugmasi bilan sezonlar ro'yxatiga.
    await ctx.reply("⚠️ Bu sezonda qismlar yo'q.", {
      reply_markup: new InlineKeyboard().text(
        "🔙 Barcha sezonlar",
        `serialBack:${season.serialId}`
      ),
    });
    return;
  }

  const seasons = season.serial.seasons;
  const idx = seasons.findIndex((s) => s.id === season.id);
  const prevSeason = idx > 0 ? seasons[idx - 1] : null;
  const nextSeason = idx < seasons.length - 1 ? seasons[idx + 1] : null;

  const all = season.episodes;
  const totalPages = Math.max(1, Math.ceil(all.length / EPISODES_PER_PAGE));
  const p = Math.min(page, totalPages - 1); // oxirgi sahifadagi qism o'chirilsa clamp
  const pageEps = all.slice(p * EPISODES_PER_PAGE, (p + 1) * EPISODES_PER_PAGE);

  // Foydalanuvchining ushbu sezon progressi — oxirgi ko'rgan qism (page=0 uchun)
  let userProgress = 0;
  const uid = ctx.from?.id;
  if (uid && !isAdmin(uid) && p === 0) {
    const watch = await prisma.serialWatch.findUnique({
      where: { userId_serialId: { userId: BigInt(uid), serialId: season.serialId } },
      select: { episodeId: true },
    });
    if (watch?.episodeId) {
      const idx = all.findIndex((ep) => ep.id === watch.episodeId);
      if (idx >= 0) userProgress = idx + 1; // 1-based
    }
  }

  const kb = new InlineKeyboard();
  let i = 0;
  for (const ep of pageEps) {
    const isWatched = userProgress && ep.number <= userProgress;
    const prefix = isWatched ? "✅ " : "";
    kb.text(`${prefix}${ep.number}-qism`, `ep:${ep.id}`);
    if (++i % 3 === 0) kb.row();
  }

  // Sahifa navigatsiyasi (ko'p qismli sezonlar uchun)
  if (totalPages > 1) {
    kb.row();
    if (p > 0) kb.text("◀️", `sep:${season.id}:${p - 1}`);
    kb.text(`${p + 1}/${totalPages}`, "noop:sep");
    if (p < totalPages - 1) kb.text("▶️", `sep:${season.id}:${p + 1}`);
  }

  // "Boshidan boshlash" — faqat progress bor va page=0 bo'lsa
  if (p === 0 && userProgress > 1) {
    kb.row().text("🔁 Boshidan boshlash", `ep:${all[0].id}`);
  }

  // "Keyingi qism" — oxirgi ko'rilmagan qism (progress + 1) mavjud bo'lsa
  if (userProgress > 0 && userProgress < all.length) {
    const nextEp = all[userProgress]; // 0-based: progress=1 → index 1 (2-qism)
    kb.row().text(`⏭ Keyingi qism (${nextEp.number}-qism)`, `ep:${nextEp.id}`);
  }

  // Sezon navigatsiyasi — yorliqsiz ◀️/▶️ o'rniga qaysi sezonga ketayotgani aniq
  kb.row();
  if (prevSeason) kb.text(`◀️ ${prevSeason.number}-sezon`, `season:${prevSeason.id}:1:0`);
  kb.text("❌ Yopish", "serial:close");
  if (nextSeason) kb.text(`${nextSeason.number}-sezon ▶️`, `season:${nextSeason.id}:1:0`);
  kb.row().text("🔙 Barcha sezonlar", `serialBack:${season.serialId}`);

  const text =
    `${ce("tv")} <b>${e.escapeHtml(season.serial.title)}</b> — ${season.number}-sezon\n` +
    `Qismni tanlang:`;

  if (edit) {
    await ctx.editMessageText(text, { reply_markup: kb }).catch(async () => {
      await ctx.reply(text, { reply_markup: kb });
    });
  } else {
    await ctx.reply(text, { reply_markup: kb });
  }
}

// Sezon tanlandi → qismlar ro'yxati. from=1 bo'lsa navigatsiya ichidan (tahrir),
// 0 bo'lsa sezonlar ro'yxatidan (yangi xabar, rasmli bo'lishi mumkin).
serialViewHandler.callbackQuery(/^season:(\d+):([01]):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await renderSeasonEpisodes(ctx, Number(ctx.match[1]), ctx.match[2] === "1", Number(ctx.match[3]));
});

// Sahifa navigatsiyasi (mavjud xabarni tahrir qiladi)
serialViewHandler.callbackQuery(/^sep:(\d+):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await renderSeasonEpisodes(ctx, Number(ctx.match[1]), true, Number(ctx.match[2]));
});

serialViewHandler.callbackQuery("noop:sep", (ctx) => ctx.answerCallbackQuery());

// Qism tanlandi → videoni yuborish (kvota gate + count + views — delivery.ts)
serialViewHandler.callbackQuery(/^ep:(\d+)$/, async (ctx) => {
  const epId = Number(ctx.match[1]);
  await ctx.answerCallbackQuery();

  const ep = await prisma.episode.findUnique({
    where: { id: epId },
    include: { season: { include: { serial: true } } },
  });
  if (!ep) {
    await ctx.reply("❌ Qism topilmadi.");
    return;
  }
  await deliverEpisode(ctx, ep);
});

// Orqaga (sezonlar). Sezonlar ro'yxati rasmli bo'lishi mumkin — matnli qismlar
// xabarini unga aylantirib bo'lmaydi, shuning uchun eskisi o'chirilib yangisi yuboriladi
// (aks holda eski qismlar paneli yonida yetim qolardi).
serialViewHandler.callbackQuery(/^serialBack:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.deleteMessage().catch(() => {});
  await sendSerialSeasons(ctx, Number(ctx.match[1]));
});

serialViewHandler.callbackQuery("serial:close", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.deleteMessage().catch(() => {});
});
