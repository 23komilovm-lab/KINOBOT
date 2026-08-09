import { Composer } from "grammy";
import type { InlineQueryResult } from "grammy/types";
import { prisma } from "../prisma.js";
import { isAdmin } from "../config.js";
import { movieCaption } from "../services/media.js";
import { getGlobalButton, getBool, KEYS } from "../utils/settings.js";
import { contentButtonRow } from "../utils/contentButton.js";
import { getUnsubscribedChannels } from "../utils/subscription.js";
import { countContentRequest, isFreeQuotaExhausted } from "../utils/access.js";
import { isPremiumActive } from "../utils/premium.js";
import { searchContent } from "../services/search.js";
import { e } from "../utils/emoji.js";
import type { MyContext } from "../types.js";
import type { Movie } from "@prisma/client";

export const inlineHandler = new Composer<MyContext>();

inlineHandler.on("inline_query", async (ctx) => {
  const uid = ctx.from.id;
  const q = ctx.inlineQuery.query.trim();

  // Referal taklifi — do'stga chiroyli, tugmali xabar sifatida yuboriladi.
  // MUHIM: bu majburiy obuna tekshiruvidan OLDIN — havolani ulashish hech qachon
  // bloklanmasligi kerak (obuna bo'lmagan foydalanuvchi ham do'stini taklif qila oladi).
  const refMatch = q.match(/^ref_(\d+)$/);
  if (refMatch) {
    const refId = refMatch[1];
    const link = `https://t.me/${ctx.me.username}?start=ref_${refId}`;
    const inviter = await prisma.user.findUnique({ where: { id: BigInt(refId) } });
    const inviterName = inviter?.firstName?.trim() || "Do'stingiz";
    const caption =
      `🎬 <b>${e.escapeHtml(inviterName)}</b> sizni <b>Kino vaqti</b> botiga taklif qilmoqda!\n\n` +
      `Minglab kino va serial — bepul va tez. 🍿`;

    // Matn yonidagi kichik rasm — BOTNING O'Z avatari. Telegram t.me havolasi
    // uchun preview yasaganda bot rasmi, nomi va tavsifini ko'rsatadi.
    // Shuning uchun hech qanday kanalga rasm post qilish shart emas; ustiga
    // preview bosilsa to'g'ridan-to'g'ri bot referal kodi bilan ochiladi.
    // Rasmni almashtirish: @BotFather → /setuserpic.
    await ctx.answerInlineQuery(
      [
        {
          type: "article" as const,
          id: `ref${refId}`,
          title: "🎬 Kino vaqti botiga taklif",
          description: `${inviterName} sizni taklif qilmoqda — minglab kino va serial, bepul!`,
          input_message_content: {
            message_text: caption,
            parse_mode: "HTML" as const,
            link_preview_options: { url: link, prefer_small_media: true, show_above_text: false },
          },
          reply_markup: { inline_keyboard: [[{ text: "🎬 Botni ochish", url: link }]] },
        },
      ],
      { cache_time: 0, is_personal: true }
    );
    return;
  }

  const admin = isAdmin(uid);
  const user = admin ? null : await prisma.user.findUnique({ where: { id: BigInt(uid) } });
  const premium = admin || isPremiumActive(user?.premiumUntil);

  // Majburiy obuna — boshqa chatlarda ham tekshiriladi (video "sizib chiqmasin").
  // Admin va premium foydalanuvchilar obunasiz o'tadi.
  if (!premium) {
    const forceSub = await getBool(KEYS.forceSubEnabled, true);
    if (forceSub) {
      const notJoined = await getUnsubscribedChannels(ctx, uid);
      const blocking = notJoined.filter((c) => c.type !== "INSTAGRAM");
      if (blocking.length > 0) {
        await ctx.answerInlineQuery([], {
          cache_time: 0,
          is_personal: true,
          button: {
            text: "🔒 Avval botga obuna bo'ling",
            start_parameter: "start",
          },
        });
        return;
      }
    }

    // Bepul limit tugagan bo'lsa inline orqali ham kino berilmaydi.
    // MUHIM: inline so'rov har bosilgan harfda keladi, shuning uchun bu yerda
    // hisob OSHIRILMAYDI — faqat mavjud hisob tekshiriladi. Haqiqiy hisoblash
    // foydalanuvchi natijani tanlaganda (chosen_inline_result) bo'ladi.
    if (await isFreeQuotaExhausted(user)) {
      await ctx.answerInlineQuery([], {
        cache_time: 0,
        is_personal: true,
        button: { text: "💎 Bepul limit tugadi — Premium olish", start_parameter: "premium" },
      });
      return;
    }
  }

  // TESHIK YOPILDI: ilgari bu yerda isPremium filtri yo'q edi va oddiy
  // foydalanuvchi inline orqali istalgan premium kinoni bepul olardi.
  const premiumFilter = premium ? {} : { isPremium: false as const };

  // Aqlli qidiruv (titleNorm + pg_trgm): kirill/lotin bir xil natija beradi.
  let movies: Movie[];
  if (/^\d+$/.test(q)) {
    movies = await prisma.movie.findMany({
      where: { ...premiumFilter, code: Number(q) },
      take: 25,
      orderBy: { views: "desc" },
    });
  } else if (q) {
    const hits = (await searchContent(q, 25)).filter((h) => h.kind === "movie");
    const ids = hits.map((h) => h.id);
    const found = ids.length
      ? await prisma.movie.findMany({ where: { ...premiumFilter, id: { in: ids } } })
      : [];
    const byId = new Map(found.map((m) => [m.id, m]));
    movies = hits.map((h) => byId.get(h.id)).filter((m): m is Movie => !!m);
  } else {
    movies = await prisma.movie.findMany({
      where: premiumFilter,
      take: 25,
      orderBy: { views: "desc" },
    });
  }

  const enabled = await getBool(KEYS.movieBtnEnabled, true);
  const globalBtn = enabled ? await getGlobalButton("movie") : null;
  const btnRow = globalBtn ? contentButtonRow(globalBtn) : null;

  const results: InlineQueryResult[] = movies.map((m) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reply_markup: any = { inline_keyboard: btnRow ? [btnRow] : [] };
    return {
      type: "video",
      id: `m${m.id}`,
      video_file_id: m.fileId,
      title: `${m.title} (${m.code})`,
      description: [m.year ? `${m.year}` : null, m.genre, m.quality, `Ko'rishlar: ${m.views}`]
        .filter(Boolean)
        .join(" · "),
      caption: movieCaption(m),
      parse_mode: "HTML",
      reply_markup: reply_markup.inline_keyboard.length ? reply_markup : undefined,
    };
  });

  // Hech narsa topilmasa — bo'sh ro'yxat o'rniga tushunarli karta ko'rsatiladi.
  // (Bo'sh natija chatda "Hech narsa topilmadi" deb umuman ko'rinmas edi.)
  if (results.length === 0) {
    results.push({
      type: "article" as const,
      id: "empty",
      title: "😕 Hech narsa topilmadi",
      description: "Boshqa nom bilan izlab ko'ring yoki botda AI yordamchidan so'rang.",
      input_message_content: {
        message_text:
          `🔎 <b>${e.escapeHtml(q)}</b> bo'yicha inline natija topilmadi.\n\n` +
          `Botda AI yordamchi orqali qidirib ko'ring.`,
        parse_mode: "HTML" as const,
      },
    });
  }

  await ctx.answerInlineQuery(results, {
    cache_time: 10,
    is_personal: true,
    button: {
      text: "🔎 Ko'proq qidirish...",
      start_parameter: "search",
    },
  });
});

/**
 * Foydalanuvchi inline natijani TANLAGANDA — bepul so'rovni hisoblaymiz.
 * Inline so'rovning o'zida hisoblab bo'lmaydi (har bosilgan harfda keladi).
 *
 * ESLATMA: bu update faqat BotFather'da inline feedback yoqilgan bo'lsa keladi
 * (@BotFather → /setinlinefeedback → Enabled). Yoqilmagan bo'lsa handler
 * ishlamaydi — qolgan himoya (premium filtri, chegara tekshiruvi) baribir kuchda.
 */
inlineHandler.on("chosen_inline_result", async (ctx) => {
  const id = ctx.chosenInlineResult.result_id;
  if (!id.startsWith("m")) return; // faqat kino natijalari (ref taklifi emas)
  await countContentRequest(ctx);
});
