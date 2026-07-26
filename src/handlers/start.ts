import { Composer } from "grammy";
import { prisma } from "../prisma.js";
import { isAdmin } from "../config.js";
import { adminMenuKeyboard, kb } from "../utils/keyboard.js";
import { getUnsubscribedChannels } from "../utils/subscription.js";
import { checkContentAccess, countContentRequest } from "../utils/access.js";
import { attachReferrer, confirmReferral } from "../utils/referral.js";
import { sendReferralInfo } from "./referral.js";
import { sendMovie } from "../services/media.js";
import { sendPremiumPrompt } from "./premiumUser.js";
import { sendSerialSeasons } from "./serialView.js";
import type { MyContext } from "../types.js";

export const startHandler = new Composer<MyContext>();

const CHANNEL_URL = "https://t.me/kinovaqti_00";

const WELCOME =
  `<tg-emoji emoji-id="5258077307985207053">🎬</tg-emoji> <b>Kino vaqti botiga xush kelibsiz!</b>\n\n` +
  `<b>Kodini</b> yuboring yoki <b>nomini</b> yozib qidiring — darhol topib beraman. 🍿`;

function welcomeKeyboard() {
  return kb(
    [
      { text: "AI yordamchi", callback_data: "ai:enter", icon_custom_emoji_id: "5258093637450866522" },
    ],
    [
      { text: "Referal", callback_data: "start:referal", icon_custom_emoji_id: "5258513401784573443" },
      { text: "Mashhur", callback_data: "popular:page:0", icon_custom_emoji_id: "5258391252914676042" },
    ],
    [
      { text: "Random", callback_data: "start:random", icon_custom_emoji_id: "5210771709258394044" },
      { text: "Kino kanali", url: CHANNEL_URL, icon_custom_emoji_id: "5260268501515377807" },
    ],
  );
}

/** Kod bo'yicha kino YOKI serialni yuboradi (obuna/premium tekshiruvidan keyin) */
export async function deliverByCode(ctx: MyContext, code: number): Promise<boolean> {
  const movie = await prisma.movie.findUnique({ where: { code } });
  if (movie) { await sendMovie(ctx, movie); return true; }
  const serial = await prisma.serial.findUnique({ where: { code } });
  if (serial) { await sendSerialSeasons(ctx, serial.id); return true; }
  return false;
}

// Welcome — buyruq tugmalari (AI, Referal, Mashhur, Random, Kanal) inline
// ko'rinishda. Doimiy "AI yordamchi" reply-klaviaturasi bu yerda o'rnatilmaydi —
// u faqat AI suhbatidan "Chiqish" bosilgandan keyin paydo bo'ladi (aiUser.ts).
async function sendWelcome(ctx: MyContext) {
  await ctx.reply(WELCOME, { reply_markup: welcomeKeyboard() });
}

startHandler.command("start", async (ctx) => {
  const uid = ctx.from!.id;
  const payload = (ctx.match ?? "").toString().trim();

  // Deep-link parsing
  let pendingCode: number | null = null;
  if (payload.startsWith("movie_")) {
    const c = Number(payload.slice(6));
    if (Number.isInteger(c)) pendingCode = c;
  } else if (payload.startsWith("ref_")) {
    const refId = Number(payload.slice(4));
    if (Number.isInteger(refId)) await attachReferrer(uid, refId);
  } else if (payload === "premium") {
    // Inline rejimdagi "Bepul chegara tugadi — Premium olish" tugmasidan
    if (!isAdmin(uid)) { await sendPremiumPrompt(ctx); return; }
  }

  // Admin — qisqa xabar + knopkalar
  if (isAdmin(uid)) {
    await ctx.reply("<b>Admin panel</b>", {
      reply_markup: adminMenuKeyboard(uid),
    });
    return;
  }

  // Deep-link kino — premium/majburiy obuna/limit tekshiruvi
  // (so'rov faqat kino haqiqatan yetkazilgandan keyin hisoblanadi)
  if (pendingCode !== null) {
    const ok = await checkContentAccess(ctx, false);
    if (!ok) {
      ctx.session.scratch = { ...(ctx.session.scratch ?? {}), pendingCode };
      return;
    }
    await confirmReferral(ctx, uid);
    const delivered = await deliverByCode(ctx, pendingCode);
    if (delivered) { await countContentRequest(ctx); return; }
  }

  // Oddiy /start — chiroyli welcome (obuna kod yozilganda tekshiriladi)
  await sendWelcome(ctx);
});

// Obuna tekshirish — yangi xabar YUBORILMAYDI, faqat popup
startHandler.callbackQuery("sub:check", async (ctx) => {
  const uid = ctx.from.id;
  const notJoined = await getUnsubscribedChannels(ctx, uid);
  const blocking  = notJoined.filter((c) => c.type !== "INSTAGRAM");

  if (blocking.length === 0) {
    await ctx.answerCallbackQuery({ text: "✅ Rahmat! Endi foydalanishingiz mumkin." });
    await ctx.deleteMessage().catch(() => {});
    await confirmReferral(ctx, uid);

    // Obuna oldidan so'ralgan kino/serial bo'lsa — yetkazamiz
    const pending = ctx.session.scratch?.pendingCode as number | undefined;
    if (typeof pending === "number") {
      if (ctx.session.scratch) delete ctx.session.scratch.pendingCode;
      const ok = await deliverByCode(ctx, pending);
      if (ok) { await countContentRequest(ctx); return; }
    }

    await sendWelcome(ctx);
  } else {
    await ctx.answerCallbackQuery({
      text: `❌ ${blocking.length} ta kanalga hali a'zo bo'lmadingiz!`,
      show_alert: true,
    });
  }
});

startHandler.callbackQuery("start:referal", async (ctx) => {
  await ctx.answerCallbackQuery();
  await sendReferralInfo(ctx);
});

startHandler.callbackQuery("start:random", async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await checkContentAccess(ctx, false))) return;
  const total = await prisma.movie.count();
  if (total === 0) { await ctx.reply("📭 Hozircha kino yo'q."); return; }
  const skip = Math.floor(Math.random() * total);
  const [movie] = await prisma.movie.findMany({ skip, take: 1 });
  if (movie && (await sendMovie(ctx, movie))) await countContentRequest(ctx);
});
