import { config } from "../config.js";
import { e } from "../utils/emoji.js";
import { log } from "../utils/logger.js";
import type { MyContext } from "../types.js";
import type { Movie } from "@prisma/client";

// Premium emoji IDlar (shaxsiy chatda ko'rinadi, kanalda fallback ishlaydi)
const EM = {
  name: "5258077307985207053", // 📹
  genre: "5258318251355545562", // 🎭
  time: "5258419835922030550", // 🕔
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
  ["melodrama", "❤️"],
  ["romantik", "❤️"],
  ["jangari", "💥"],
  ["triller", "🌀"],
  ["qo'rqinchli", "👻"],
  ["qorqinchli", "👻"],
  ["dahshat", "👻"],
  ["ujas", "👻"],
  ["komediya", "😂"],
  ["fantastika", "🚀"],
  ["fantastik", "🚀"],
  ["fentezi", "🐉"],
  ["fantaziya", "🐉"],
  ["detektiv", "🕵️"],
  ["kriminal", "🕵️"],
  ["multfilm", "🎨"],
  ["anime", "🎨"],
  ["tarixiy", "🏛"],
  ["urush", "⚔️"],
  ["harbiy", "⚔️"],
  ["sarguzasht", "🧭"],
  ["sport", "🏆"],
  ["hujjatli", "📽"],
  ["drama", "🎭"],
];

/**
 * Janr matniga mos ikonka. AI "Jangari, Drama" kabi vergulli ro'yxat qaytaradi —
 * ro'yxatdagi BIRINCHI mos kelgan janr ikonkasi olinadi, topilmasa 🎭.
 */
export function genreEmoji(genre: string | null): string {
  if (!genre) return "🎭";
  const parts = genre
    .toLowerCase()
    .split(/[,/|]/)
    .map((s) => s.trim());
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
 * Xatoni iloji boricha o'qish mumkin bo'lgan matnga aylantiradi.
 * grammY'ning GrammyError'i `.description` da Telegramning o'z xabarini
 * beradi (masalan "Bad Request: VIDEO_FILE_ID_INVALID") — bu `.message`ga
 * qaraganda aniqroq. Hech qanday tanish maydon topilmasa ham (masalan
 * xato Error obyekti bo'lmasa), oxirgi chora sifatida String(err) qaytariladi —
 * "noma'lum xato" degan ma'lumotsiz xabar boshqa hech qachon chiqmasin.
 */
export function describeError(err: unknown): string {
  if (err && typeof err === "object") {
    const anyErr = err as { description?: unknown; message?: unknown };
    if (typeof anyErr.description === "string" && anyErr.description) return anyErr.description;
    if (typeof anyErr.message === "string" && anyErr.message) return anyErr.message;
  }
  return String(err);
}

/**
 * Xatoni klassifikatsiya qiladi: qayta urinish mantiqlimi yoki darhol taslim bo'lishmi.
 * - 429 (too many requests) va 5xx — Telegram serverida vaqtinchalik → retry.
 * - 400/403 kabi doimiy xatolar (yaroqsiz file_id, kanal huquqi yo'q) → fatal,
 *   takrorlash faqat vaqtni behuda sarflaydi.
 * - Network xatolari (fetch/ECONNRESET/timeout) → retry.
 */
export function classifyError(err: unknown): "retry" | "fatal" {
  if (err && typeof err === "object") {
    const anyErr = err as { error_code?: unknown; message?: unknown };
    if (typeof anyErr.error_code === "number") {
      if (anyErr.error_code === 429 || anyErr.error_code >= 500) return "retry";
      return "fatal";
    }
    const msg = typeof anyErr.message === "string" ? anyErr.message : String(anyErr);
    if (/fetch|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket|network|timeout|EPIPE/i.test(msg))
      return "retry";
  }
  return "fatal";
}

/**
 * Qisqa videoni kino kanalga tashlaydi — 3 urinish, 1s/3s backoff bilan.
 * Vaqtinchalik (network/429/5xx) xatolarda qayta urinadi; doimiy xatoda darhol
 * taslim bo'ladi. { msgId } yoki { error } qaytaradi.
 */
export async function postToMovieChannel(
  ctx: MyContext,
  movie: Movie,
  shortFileId: string
): Promise<{ msgId: number | null; error: string | null }> {
  if (!config.movieChannelId) {
    return { msgId: null, error: "MOVIE_CHANNEL_ID sozlanmagan (.env)" };
  }

  const ATTEMPTS = 3;
  const BACKOFF_MS = [0, 1000, 3000];
  let lastError: string | null = null;

  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      const btn = movieWatchButton(ctx.me.username, movie.code);
      const sent = await ctx.api.sendVideo(config.movieChannelId, shortFileId, {
        caption: movieChannelCaption(movie, true), // kanal — janrga mos ikonka
        parse_mode: "HTML",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        reply_markup: { inline_keyboard: [[btn]] } as any,
      });
      return { msgId: sent.message_id, error: null };
    } catch (err) {
      lastError = describeError(err);
      // Railway logida urinish va aniq sabab ko'rinishi kerak
      log("warn", "Qisqa video kino kanalga tashlanmadi", {
        movieCode: movie.code,
        attempt: attempt + 1,
        attempts: ATTEMPTS,
        error: describeError(err),
      });
      if (classifyError(err) === "fatal") break; // qayta urinish foydasiz
      if (attempt < ATTEMPTS - 1) await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt + 1]));
    }
  }

  return { msgId: null, error: lastError ?? "noma'lum xato" };
}
