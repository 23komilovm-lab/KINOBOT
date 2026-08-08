import { Composer } from "grammy";
import { isAdmin } from "../config.js";
import { adminMenuKeyboard, kb } from "../utils/keyboard.js";
import { getUnsubscribedChannels } from "../utils/subscription.js";
import { attachReferrer } from "../utils/referral.js";
import { sendReferralInfo } from "./referral.js";
import { weightedRandomMovie } from "../services/recommend.js";
import { deliverByCode, deliverMovie } from "../services/delivery.js";
import { sendPremiumPrompt } from "./premiumUser.js";
import type { MyContext } from "../types.js";

export const startHandler = new Composer<MyContext>();

const CHANNEL_URL = "https://t.me/kinovaqti_00";

const WELCOME =
  `<tg-emoji emoji-id="5258077307985207053">🎬</tg-emoji> <b>Kino vaqti botiga xush kelibsiz!</b>\n\n` +
  `<b>Kodini</b> yuboring yoki <b>nomini</b> yozib qidiring — darhol topib beraman. 🍿`;

function welcomeKeyboard() {
  return kb(
    [
      {
        text: "AI yordamchi",
        callback_data: "ai:enter",
        icon_custom_emoji_id: "5258093637450866522",
      },
    ],
    [
      {
        text: "Referal",
        callback_data: "start:referal",
        icon_custom_emoji_id: "5258513401784573443",
      },
      {
        text: "Mashhur",
        callback_data: "popular:page:0",
        icon_custom_emoji_id: "5258391252914676042",
      },
    ],
    [
      {
        text: "Random",
        callback_data: "start:random",
        icon_custom_emoji_id: "5210771709258394044",
      },
      { text: "Kino kanali", url: CHANNEL_URL, icon_custom_emoji_id: "5260268501515377807" },
    ]
  );
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
    if (!isAdmin(uid)) {
      await sendPremiumPrompt(ctx);
      return;
    }
  }

  // Admin — qisqa xabar + knopkalar
  if (isAdmin(uid)) {
    await ctx.reply("<b>Admin panel</b>", {
      reply_markup: adminMenuKeyboard(uid),
    });
    return;
  }

  // Deep-link kino — to'liq gate (obuna → bepul limit → premium) delivery.ts ichida.
  // Gate o'tmasa bloklovchi xabar ko'rsatiladi; obuna bo'lsa pendingCode saqlanadi
  // (sub:check qayta yetkazadi). Kod topilmasa — welcome ko'rsatiladi.
  if (pendingCode !== null) {
    const res = await deliverByCode(ctx, pendingCode);
    if (res.delivered) return;
    if (!res.ok) return;
  }

  // Oddiy /start — chiroyli welcome (obuna kod yozilganda tekshiriladi)
  await sendWelcome(ctx);
});

// Obuna tekshirish — yangi xabar YUBORILMAYDI, faqat popup
// Kesh bypass qilinadi — foydalanuvchi aynan hozir qo'shilganini tekshirmoqchi
startHandler.callbackQuery("sub:check", async (ctx) => {
  const uid = ctx.from.id;
  const notJoined = await getUnsubscribedChannels(ctx, uid, { bypassCache: true });
  const blocking = notJoined.filter((c) => c.type !== "INSTAGRAM");

  if (blocking.length === 0) {
    await ctx.answerCallbackQuery({ text: "✅ Rahmat! Endi foydalanishingiz mumkin." });
    await ctx.deleteMessage().catch(() => {});

    // Obuna oldidan so'ralgan kino/serial bo'lsa — to'liq gate QAYTA ishlaydi
    // (obuna o'rtasida bepul limit tugagan bo'lishi mumkin). Kvota bloklasa
    // pendingCode qayta saqlanadi va premium taklifi ko'rsatiladi.
    const pending = ctx.session.scratch?.pendingCode as number | undefined;
    if (typeof pending === "number") {
      if (ctx.session.scratch) delete ctx.session.scratch.pendingCode;
      const res = await deliverByCode(ctx, pending);
      if (res.delivered) return;
      if (!res.ok) return;
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
  const movie = await weightedRandomMovie(ctx);
  if (!movie) {
    await ctx.reply("📭 Hozircha kino yo'q.");
    return;
  }
  await deliverMovie(ctx, movie);
});
