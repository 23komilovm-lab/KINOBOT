import { prisma } from "../prisma.js";
import { isAdmin } from "../config.js";
import { contentButtonRow, contentButtonMarkup } from "../utils/contentButton.js";
import { getGlobalButton, getBool, getSetting, KEYS } from "../utils/settings.js";
import { isPremiumActive } from "../utils/premium.js";
import { sendPremiumPrompt } from "../handlers/premiumUser.js";
import { movieChannelCaption } from "./movieChannel.js";
import type { MyContext } from "../types.js";
import type { Movie } from "@prisma/client";

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
    `🔒 <b>"${movie.title}"</b> — <b>Premium kino</b>.\nUni ko'rish uchun premium obuna kerak.`
  );
  return false;
}

/** Kinoni yuboradi. Premium kino bo'lib, foydalanuvchi premium bo'lmasa — yubormaydi (false). */
export async function sendMovie(ctx: MyContext, movie: Movie): Promise<boolean> {
  if (!(await ensurePremiumMovieAccess(ctx, movie))) return false;

  const enabled = await getBool(KEYS.movieBtnEnabled, true);
  const globalBtn = enabled ? await getGlobalButton("movie") : null;
  await ctx.replyWithVideo(movie.fileId, {
    caption: movieCaption(movie),
    reply_markup: globalBtn ? contentButtonMarkup(globalBtn) : undefined,
  });
  await prisma.movie.update({
    where: { id: movie.id },
    data: { views: { increment: 1 } },
  });
  await sendPostDeliveryMessage(ctx);
  return true;
}

/** Kino yuborilgandan keyin qo'shimcha reklama/post xabari (admin sozlaydi, o'chirib/yoqib qo'yiladi) */
async function sendPostDeliveryMessage(ctx: MyContext): Promise<void> {
  const on = await getBool(KEYS.postDeliveryEnabled, false);
  if (!on) return;
  const text = await getSetting(KEYS.postDeliveryText, "");
  if (!text.trim()) return;

  const btnText  = await getSetting(KEYS.postDeliveryBtnText, "");
  const btnUrl   = await getSetting(KEYS.postDeliveryBtnUrl, "");
  const btnStyle = await getSetting(KEYS.postDeliveryBtnStyle, "primary");
  const row = contentButtonRow({ buttonText: btnText, buttonUrl: btnUrl, buttonStyle: btnStyle });

  await ctx.reply(text, {
    reply_markup: row ? { inline_keyboard: [row] } : undefined,
  }).catch(() => {});
}
