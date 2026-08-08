import { prisma } from "../prisma.js";
import { isAdmin } from "../config.js";
import { log } from "../utils/logger.js";
import type { MyContext } from "../types.js";
import type { Episode, Serial } from "@prisma/client";

/**
 * SERIAL KO'RISH PROGRESSI (2.6)
 *
 * `SerialWatch` — foydalanuvchi serialning oxirgi ko'rgan qismini saqlaydi.
 * "▶️ Davom etish" tugmasi shu asosda KEYINGI qismni ochadi.
 *
 * Adminlar uchun yozilmaydi (admin testi progressni ifloslantirmasin) va
 * hech qachon delivery oqimini buzmaydi — xato faqat loglanadi.
 */

export type NextEpisode = Episode & { season: { number: number; serial: Serial } };

/** Oxirgi ko'rilgan qismni saqlaydi (yoki yangilaydi). */
export async function saveProgress(
  ctx: MyContext,
  opts: { serialId: number; episodeId: number }
): Promise<void> {
  const uid = ctx.from?.id;
  if (!uid || isAdmin(uid)) return;

  await prisma.serialWatch
    .upsert({
      where: { userId_serialId: { userId: BigInt(uid), serialId: opts.serialId } },
      create: { userId: BigInt(uid), serialId: opts.serialId, episodeId: opts.episodeId },
      update: { episodeId: opts.episodeId },
    })
    .catch((err) => {
      log("warn", "Serial progress saqlanmadi", {
        userId: uid.toString(),
        serialId: opts.serialId,
        error: String(err),
      });
    });
}

/**
 * Keyingi ko'rilishi kerak bo'lgan qismni topadi.
 * - Progress bo'lmasa yoki hamma qismlar ko'rilgan bo'lsa → null.
 * - Keyingi qism o'sha sezonda yo'q bo'lsa — keyingi sezonning 1-qismi.
 */
export async function getNextEpisode(
  userId: bigint,
  serialId: number
): Promise<NextEpisode | null> {
  const watch = await prisma.serialWatch.findUnique({
    where: { userId_serialId: { userId, serialId } },
  });
  if (!watch) return null;

  const serial = await prisma.serial.findUnique({
    where: { id: serialId },
    include: {
      seasons: {
        orderBy: { number: "asc" },
        include: { episodes: { orderBy: { number: "asc" } } },
      },
    },
  });
  if (!serial) return null;

  // Barcha qismlarni sezon tartibida tekis ro'yxatga yoyamiz
  const flat = serial.seasons.flatMap((s) =>
    s.episodes.map((ep) => ({ ep, seasonNumber: s.number }))
  );
  const idx = flat.findIndex((f) => f.ep.id === watch.episodeId);
  // O'tgan/noto'g'ri episodeId bo'lsa idx=-1 → hammasi ko'rilgan deb hisoblanmaydi;
  // o'rniga progressni bilmaymiz, "Davom etish" ko'rsatilmaydi (idx=-1 → null).
  if (idx === -1 || idx >= flat.length - 1) return null;

  const next = flat[idx + 1];
  return {
    ...next.ep,
    season: { number: next.seasonNumber, serial },
  };
}
