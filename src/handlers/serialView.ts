import { Composer, InlineKeyboard } from "grammy";
import { prisma } from "../prisma.js";
import { ce, e } from "../utils/emoji.js";
import { contentButtonMarkup } from "../utils/contentButton.js";
import { getGlobalButton, getBool, KEYS } from "../utils/settings.js";
import { ensurePremiumSerialAccess } from "../services/media.js";
import type { MyContext } from "../types.js";

export const serialViewHandler = new Composer<MyContext>();

/** Serial sezonlari ro'yxatini chiqaradi */
export async function sendSerialSeasons(ctx: MyContext, serialId: number) {
  const serial = await prisma.serial.findUnique({
    where: { id: serialId },
    include: { seasons: { orderBy: { number: "asc" } } },
  });
  if (!serial) {
    await ctx.reply("❌ Serial topilmadi.");
    return;
  }

  await prisma.serial.update({
    where: { id: serialId },
    data: { views: { increment: 1 } },
  });

  if (serial.seasons.length === 0) {
    await ctx.reply("⚠️ Bu serialda hali sezon/qism qo'shilmagan.");
    return;
  }

  const rows = [];
  for (const s of serial.seasons) {
    rows.push([
      {
        text: `📂 ${s.number}-sezon${s.title ? ` · ${s.title}` : ""}`,
        callback_data: `season:${s.id}`,
      },
    ]);
  }
  rows.push([{ text: "❌ Yopish", callback_data: "serial:close" }]);

  const caption =
    `${ce("tv")} <b>${e.escapeHtml(serial.title)}</b>\n` +
    (serial.year ? `📅 ${serial.year}\n` : "") +
    (serial.caption ? `\n${e.escapeHtml(serial.caption)}\n` : "") +
    `\nSezonni tanlang:`;

  const enabled   = await getBool(KEYS.serialBtnEnabled, true);
  const globalBtn = enabled ? await getGlobalButton("serial") : { buttonText: null, buttonUrl: null, buttonStyle: "primary" };
  const markup    = contentButtonMarkup(globalBtn, rows);
  if (serial.posterId) {
    await ctx.replyWithPhoto(serial.posterId, { caption, reply_markup: markup });
  } else {
    await ctx.reply(caption, { reply_markup: markup });
  }
}

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
  if (prevSeason) kb.text("◀️", `season:${prevSeason.id}`);
  kb.text("❌", "serial:close");
  if (nextSeason) kb.text("▶️", `season:${nextSeason.id}`);
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

// Sezon tanlandi → qismlar ro'yxati (birinchi kirish — yangi xabar)
serialViewHandler.callbackQuery(/^season:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  // Oldingi xabar ham qismlar ro'yxati bo'lsa (◀️/▶️ orqali) — tahrirlaymiz,
  // aks holda (sezonlar ro'yxatidan, ehtimol rasmli) yangi xabar yuboramiz.
  const fromEpisodeNav = !!ctx.callbackQuery.message?.text?.includes("Qismni tanlang:");
  await renderSeasonEpisodes(ctx, Number(ctx.match[1]), fromEpisodeNav);
});

// Qism tanlandi → videoni yuborish
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
  if (!(await ensurePremiumSerialAccess(ctx, ep.season.serial))) return;

  await ctx.replyWithVideo(ep.fileId, {
    caption:
      `${ce("tv")} <b>${e.escapeHtml(ep.season.serial.title)}</b>\n` +
      `${ep.season.number}-sezon · ${ep.number}-qism` +
      (ep.title ? `\n${e.escapeHtml(ep.title)}` : ""),
  });
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
