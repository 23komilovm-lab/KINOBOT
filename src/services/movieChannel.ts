import { config } from "../config.js";
import { e } from "../utils/emoji.js";
import type { MyContext } from "../types.js";
import type { Movie } from "@prisma/client";

// Premium emoji IDlar (shaxsiy chatda ko'rinadi, kanalda fallback ishlaydi)
const EM = {
  name:  "5258077307985207053", // 📹
  genre: "5258318251355545562", // 🎭
  time:  "5258419835922030550", // 🕔
};

function tg(id: string, fallback: string): string {
  return `<tg-emoji emoji-id="${id}">${fallback}</tg-emoji>`;
}

/** Davomiylikni "1 soat 25 daqiqa" ko'rinishida qaytaradi */
export function formatDuration(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (h > 0 && m > 0) return `${h} soat ${m} daqiqa`;
  if (h > 0) return `${h} soat`;
  return `${m} daqiqa`;
}

/**
 * Janr → ikonka jadvali. Kalitlar kichik harfda, qisman moslik bo'yicha
 * tekshiriladi ("ilmiy fantastika" ham "fantastika" ga tushadi).
 * Tartib MUHIM: aniqrog'i yuqorida turishi kerak (masalan "melodrama" —
 * "drama" dan oldin, aks holda "drama" birinchi bo'lib ushlab qoladi).
 */
const GENRE_EMOJI: [string, string][] = [
  ["melodrama",   "❤️"],
  ["romantik",    "❤️"],
  ["jangari",     "💥"],
  ["triller",     "🌀"],
  ["qo'rqinchli", "👻"],
  ["qorqinchli",  "👻"],
  ["dahshat",     "👻"],
  ["ujas",        "👻"],
  ["komediya",    "😂"],
  ["fantastika",  "🚀"],
  ["fantastik",   "🚀"],
  ["fentezi",     "🐉"],
  ["fantaziya",   "🐉"],
  ["detektiv",    "🕵️"],
  ["kriminal",    "🕵️"],
  ["multfilm",    "🎨"],
  ["anime",       "🎨"],
  ["tarixiy",     "🏛"],
  ["urush",       "⚔️"],
  ["harbiy",      "⚔️"],
  ["sarguzasht",  "🧭"],
  ["sport",       "🏆"],
  ["hujjatli",    "📽"],
  ["drama",       "🎭"],
];

/**
 * Janr matniga mos ikonka. AI "Jangari, Drama" kabi vergulli ro'yxat qaytaradi —
 * ro'yxatdagi BIRINCHI mos kelgan janr ikonkasi olinadi, topilmasa 🎭.
 */
export function genreEmoji(genre: string | null): string {
  if (!genre) return "🎭";
  const parts = genre.toLowerCase().split(/[,/|]/).map((s) => s.trim());
  for (const part of parts) {
    for (const [key, emoji] of GENRE_EMOJI) {
      if (part.includes(key)) return emoji;
    }
  }
  return "🎭";
}

/**
 * Kino caption.
 *
 * `forChannel = false` (bot ichida, shaxsiy chat) — barcha qatorlarda premium
 * emoji ishlatiladi, janr ikonkasi doimiy 🎭.
 *
 * `forChannel = true` (kino kanal posti) — janr qatorida janrga mos oddiy
 * ikonka chiqadi. Premium emoji kanalda Telegram tomonidan olib tashlanadi,
 * shuning uchun janr qatorini <tg-emoji> ichiga o'rash ma'nosiz bo'lardi.
 */
export function movieChannelCaption(m: Movie, forChannel = false): string {
  const genreIcon = forChannel ? genreEmoji(m.genre) : tg(EM.genre, "🎭");
  const lines = [
    `${tg(EM.name, "📹")} nomi : <b>${e.escapeHtml(m.title)}</b>`,
    `${genreIcon} janri : <b>${m.genre ? e.escapeHtml(m.genre) : "—"}</b>`,
    `${tg(EM.time, "🕔")} davomiyligi : <b>${m.duration ? formatDuration(m.duration) : "—"}</b>`,
  ];
  return lines.join("\n\n");
}

/**
 * Kanal postidagi CTA tugmasi (deep-link).
 * Ikonka barcha postlarda BIR XIL — muntazam obunachi uni ko'z bilan ilg'ab
 * oladi; janrga qarab o'zgarsa bu tanilish yo'qolardi.
 */
export function movieWatchButton(botUsername: string, code: number) {
  return {
    text: "🎥 To'liq kinoni ko'rish",
    url: `https://t.me/${botUsername}?start=movie_${code}`,
  };
}

/**
 * Qisqa videoni kino kanalga tashlaydi.
 * { msgId } yoki { error } qaytaradi.
 */
export async function postToMovieChannel(
  ctx: MyContext,
  movie: Movie,
  shortFileId: string
): Promise<{ msgId: number | null; error: string | null }> {
  if (!config.movieChannelId) {
    return { msgId: null, error: "MOVIE_CHANNEL_ID sozlanmagan (.env)" };
  }
  const btn = movieWatchButton(ctx.me.username, movie.code);
  try {
    const sent = await ctx.api.sendVideo(config.movieChannelId, shortFileId, {
      caption: movieChannelCaption(movie, true), // kanal — janrga mos ikonka
      parse_mode: "HTML",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      reply_markup: { inline_keyboard: [[btn]] } as any,
    });
    return { msgId: sent.message_id, error: null };
  } catch (err) {
    return { msgId: null, error: (err as Error).message };
  }
}
