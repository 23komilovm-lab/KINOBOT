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
    await ctx.reply("⚠️ Bu serialda hali sezon/qism qo'shilmagan.");
    return;
  }

  // "Davom etish" — foydalanuvchining oxirgi qismidan keyingisi
  const uid = ctx.from?.id;
  const next = uid && !isAdmin(uid) ? await getNextEpisode(BigInt(uid), serial.id) : null;

  const rows = [];
  if (next) {
    rows.push([
      {
        text: `▶️ Davom etish — ${next.season.number}-sezon ${next.number}-qism`,
        callback_data: `ep:${next.id}`,
      },
    ]);
  }
  for (const s of serial.seasons) {
    rows.push([
      {
        text: `📂 ${s.number}-sezon${s.title ? ` · ${s.title}` : ""}`,
        callback_data: `season:${s.id}:0`,
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

/**
 * Sezon qismlari ro'yxati.
 * `edit` flag manzil data'sida aniq uzatiladi (`season:<id>:<from>`:
 * 0 = sezonlar ro'yxatidan → yangi xabar, 1 = qismlar navigatsiyasidan → tahrir).
 * Ilgari bu "Qismni tanlang:" matnidan snifflanardi — yorliq o'zgarsa buzilardi.
 */
async function renderSeasonEpisodes(ctx: MyContext, seasonId: number, edit: boolean) {
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
    await ctx.reply("⚠️ Bu sezonda qismlar yo'q.");
    return;
  }

  const seasons = season.serial.seasons;
  const idx = seasons.findIndex((s) => s.id === season.id);
  const prevSeason = idx > 0 ? seasons[idx - 1] : null;
  const nextSeason = idx < seasons.length - 1 ? seasons[idx + 1] : null;

  const kb = new InlineKeyboard();
  let i = 0;
  for (const ep of season.episodes) {
    kb.text(`${ep.number}-qism`, `ep:${ep.id}`);
    if (++i % 3 === 0) kb.row();
  }
  kb.row();
  if (prevSeason) kb.text("◀️", `season:${prevSeason.id}:1`);
  kb.text("❌", "serial:close");
  if (nextSeason) kb.text("▶️", `season:${nextSeason.id}:1`);
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

// Sezon tanlandi → qismlar ro'yxati. `from` 1 bo'lsa navigatsiya ichidan (tahrir),
// 0 bo'lsa sezonlar ro'yxatidan (yangi xabar, rasmli bo'lishi mumkin).
serialViewHandler.callbackQuery(/^season:(\d+):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await renderSeasonEpisodes(ctx, Number(ctx.match[1]), ctx.match[2] === "1");
});

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

// Orqaga (sezonlar)
serialViewHandler.callbackQuery(/^serialBack:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await sendSerialSeasons(ctx, Number(ctx.match[1]));
});

serialViewHandler.callbackQuery("serial:close", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.deleteMessage().catch(() => {});
});
