import { prisma } from "../prisma.js";
import { isAdmin } from "../config.js";
import { contentButtonRow, contentButtonMarkup } from "../utils/contentButton.js";
import { getGlobalButton, getBool, getSetting, KEYS } from "../utils/settings.js";
import { isPremiumActive } from "../utils/premium.js";
import { sendPremiumPrompt } from "../handlers/premiumUser.js";
import { movieChannelCaption } from "./movieChannel.js";
import { formatError, log, notifyOwner } from "../utils/logger.js";
import { RECOMMEND_CALLBACK } from "./recommend.js";
import { ce, e } from "../utils/emoji.js";
import type { MyContext } from "../types.js";
import type { Movie, Serial, Episode } from "@prisma/client";

/** Kino caption (bot ichida) — premium emojili format, janr ikonkasi doimiy 🎭 */
export function movieCaption(m: Movie): string {
  return movieChannelCaption(m, false);
}

/**
 * Premium kino uchun ruxsatni tekshiradi.
 * Admin va premium obunachilar o'tadi; boshqalarga premium taklifi ko'rsatiladi.
 * false qaytsa — kino YUBORILMAYDI.
 */
async function ensurePremiumMovieAccess(ctx: MyContext, movie: Movie): Promise<boolean> {
  if (!movie.isPremium) return true;
  const uid = ctx.from?.id;
  if (uid && isAdmin(uid)) return true;

  const user = uid ? await prisma.user.findUnique({ where: { id: BigInt(uid) } }) : null;
  if (isPremiumActive(user?.premiumUntil)) return true;

  await sendPremiumPrompt(
    ctx,
    `🔒 <b>"${e.escapeHtml(movie.title)}"</b> — <b>Premium kino</b>.\nUni ko'rish uchun premium obuna kerak.`
  );
  return false;
}

/**
 * Premium serial uchun ruxsatni tekshiradi (ensurePremiumMovieAccess bilan bir xil
 * mantiq). Sezon/qism ro'yxati gate qilinmaydi — faqat haqiqiy video yetkazish.
 */
export async function ensurePremiumSerialAccess(ctx: MyContext, serial: Serial): Promise<boolean> {
  if (!serial.isPremium) return true;
  const uid = ctx.from?.id;
  if (uid && isAdmin(uid)) return true;

  const user = uid ? await prisma.user.findUnique({ where: { id: BigInt(uid) } }) : null;
  if (isPremiumActive(user?.premiumUntil)) return true;

  await sendPremiumPrompt(
    ctx,
    `🔒 <b>"${e.escapeHtml(serial.title)}"</b> — <b>Premium serial</b>.\nUni ko'rish uchun premium obuna kerak.`
  );
  return false;
}

/**
 * Kinoni yuboradi. Premium kino bo'lib, foydalanuvchi premium bo'lmasa —
 * yubormaydi (false). Video yuborish muvaffaqiyatsiz bo'lsa (bloklangan user,
 * eskirgan file_id) views OSHIRILMAYDI — jimgina muvaffaqiyatsizlik o'rniga
 * log + owner bildirishnomasi chiqadi.
 */
export async function sendMovie(ctx: MyContext, movie: Movie): Promise<boolean> {
  if (!(await ensurePremiumMovieAccess(ctx, movie))) return false;

  const enabled = await getBool(KEYS.movieBtnEnabled, true);
  const globalBtn = enabled ? await getGlobalButton("movie") : null;
  // Video ostida global knopka + tavsiya tugmasi. Tavsiya doim ko'rsatiladi —
  // sovuq foydalanuvchi uchun top-views ro'yxatini ochadi (foydasiz emas).
  // Emoji panel sarlavhasi bilan bir xil (⭐) — foydalanuvchi ularni bog'lasin.
  const recommendRow = [{ text: "⭐ Sizga yoqishi mumkin", callback_data: RECOMMEND_CALLBACK }];
  try {
    await ctx.replyWithVideo(movie.fileId, {
      caption: movieCaption(movie),
      reply_markup: contentButtonMarkup(globalBtn ?? {}, [recommendRow]),
    });
  } catch (err) {
    log("warn", "Kino yuborilmadi", {
      userId: ctx.from?.id?.toString(),
      movieId: movie.id,
      error: formatError(err),
    });
    await notifyOwner(
      `⚠️ Kino yuborilmadi: "${movie.title}" (id:${movie.id})\n${formatError(err)}`,
      "movie-send"
    );
    // Jim muvaffaqiyatsizlik emas — foydalanuvchiga ham xabar ko'rsatamiz
    await ctx
      .reply("❌ Videoni yuborishda xato yuz berdi. Qaytadan urinib ko'ring yoki admin bilan bog'laning.")
      .catch(() => {});
    return false;
  }

  await prisma.movie
    .update({
      where: { id: movie.id },
      data: { views: { increment: 1 } },
    })
    .catch((err) => {
      log("warn", "Kino views oshmadi", { movieId: movie.id, error: formatError(err) });
    });
  await sendPostDeliveryMessage(ctx);
  return true;
}

/** Serial episodini yuboradi (premium gate bilan). Muvaffaqiyatga bog'liq. */
export async function sendEpisode(
  ctx: MyContext,
  episode: Episode,
  serial: Serial,
  seasonNumber: number
): Promise<boolean> {
  if (!(await ensurePremiumSerialAccess(ctx, serial))) return false;

  const enabled = await getBool(KEYS.serialBtnEnabled, true);
  const globalBtn = enabled ? await getGlobalButton("serial") : null;
  const caption =
    `${ce("tv")} <b>${e.escapeHtml(serial.title)}</b>\n` +
    `${seasonNumber}-sezon · ${episode.number}-qism` +
    (episode.title ? `\n${e.escapeHtml(episode.title)}` : "");
  // Kino kabi episod ostida ham tavsiya tugmasi — ikki kontent turida UX bir xil.
  const recommendRow = [{ text: "⭐ Sizga yoqishi mumkin", callback_data: RECOMMEND_CALLBACK }];

  try {
    await ctx.replyWithVideo(episode.fileId, {
      caption,
      reply_markup: contentButtonMarkup(globalBtn ?? {}, [recommendRow]),
    });
  } catch (err) {
    log("warn", "Serial episodi yuborilmadi", {
      userId: ctx.from?.id?.toString(),
      episodeId: episode.id,
      error: formatError(err),
    });
    await notifyOwner(
      `⚠️ Serial episodi yuborilmadi (ep:${episode.id})\n${formatError(err)}`,
      "episode-send"
    );
    await ctx
      .reply("❌ Qismni yuborishda xato yuz berdi. Qaytadan urinib ko'ring yoki admin bilan bog'laning.")
      .catch(() => {});
    return false;
  }
  return true;
}

/** Kino yuborilgandan keyin qo'shimcha reklama/post xabari (admin sozlaydi, o'chirib/yoqib qo'yiladi) */
async function sendPostDeliveryMessage(ctx: MyContext): Promise<void> {
  const on = await getBool(KEYS.postDeliveryEnabled, false);
  if (!on) return;
  const text = await getSetting(KEYS.postDeliveryText, "");
  if (!text.trim()) return;

  const btnText = await getSetting(KEYS.postDeliveryBtnText, "");
  const btnUrl = await getSetting(KEYS.postDeliveryBtnUrl, "");
  const btnStyle = await getSetting(KEYS.postDeliveryBtnStyle, "primary");
  const row = contentButtonRow({ buttonText: btnText, buttonUrl: btnUrl, buttonStyle: btnStyle });

  await ctx
    .reply(text, {
      reply_markup: row ? { inline_keyboard: [row] } : undefined,
    })
    .catch(() => {});
}
