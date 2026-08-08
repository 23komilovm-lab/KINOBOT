import { Composer } from "grammy";
import { prisma } from "../../prisma.js";
import { adminCan } from "../../config.js";
import { ce, e } from "../../utils/emoji.js";
import { getCachedStat } from "../../services/statsCache.js";
import { ADMIN_MENU_BUTTONS } from "../../utils/keyboard.js";
import type { MyContext } from "../../types.js";

export const statisticsHandler = new Composer<MyContext>();

// Statistika xabari 60 soniyaga keshlanadi (3.5) — har ochilishda 9 ta DB
// so'rov bajarilmasin. Qiymatlar shuncha tez o'zgarmaydi, admin buni sezmaydi.
const OVERVIEW_KEY = "overview";

async function buildOverview(): Promise<string> {
  const [users, blocked, movies, serials, episodes, channels, movieViews, serialViews, topMovies] =
    await Promise.all([
      prisma.user.count(),
      prisma.user.count({ where: { isBlocked: true } }),
      prisma.movie.count(),
      prisma.serial.count(),
      prisma.episode.count(),
      prisma.channel.count({ where: { isActive: true } }),
      prisma.movie.aggregate({ _sum: { views: true } }),
      prisma.serial.aggregate({ _sum: { views: true } }),
      prisma.movie.findMany({
        orderBy: { views: "desc" },
        take: 5,
        select: { title: true, code: true, views: true },
      }),
    ]);

  const totalViews = (movieViews._sum.views ?? 0) + (serialViews._sum.views ?? 0);

  let top = "";
  if (topMovies.length) {
    top =
      `\n${ce("trendUp")} <b>Top kinolar:</b>\n` +
      topMovies
        .map(
          (m, i) =>
            `${i + 1}. ${e.escapeHtml(m.title)} (<code>${m.code}</code>) — ${m.views} ${ce("views")}`
        )
        .join("\n");
  }

  return (
    `${ce("chart")} <b>Bot statistikasi</b>\n` +
    `━━━━━━━━━━━━━━━\n` +
    `${ce("stats")} Foydalanuvchilar: <b>${users}</b>\n` +
    `${ce("blocked")} Bloklangan: <b>${blocked}</b>\n` +
    `${ce("film")} Kinolar: <b>${movies}</b>\n` +
    `${ce("tv")} Seriallar: <b>${serials}</b> (${episodes} qism)\n` +
    `${ce("channel")} Faol kanallar: <b>${channels}</b>\n` +
    `${ce("views")} Jami ko'rishlar: <b>${totalViews}</b>\n` +
    top
  );
}

statisticsHandler.hears(ADMIN_MENU_BUTTONS.stats, async (ctx) => {
  if (!adminCan(ctx.from?.id ?? 0, "stats")) return;
  await ctx.reply(await getCachedStat(OVERVIEW_KEY, buildOverview));
});
