import { InputFile } from "grammy";
import { gzipSync, gunzipSync } from "node:zlib";
import { prisma } from "../prisma.js";
import { config } from "../config.js";
import { getBool, getSetting, setSetting, KEYS } from "../utils/settings.js";
import type { Bot } from "grammy";
import type { MyContext } from "../types.js";

const bigintReplacer = (_key: string, value: unknown) =>
  typeof value === "bigint" ? value.toString() : value;

/**
 * Backup faylini tayyorlaydi — gzip bilan siqilgan (.json.gz).
 * Telegram Bot API hujjat yuborish limiti 50MB; JSON matn odatda 5-10x
 * siqiladi, shuning uchun bu limitga yetish ehtimolini sezilarli kamaytiradi.
 */
export async function buildBackupFile(): Promise<{
  file: InputFile;
  fileName: string;
  counts: Record<string, number>;
}> {
  const [movies, serials, seasons, episodes, channels, users, settings] = await Promise.all([
    prisma.movie.findMany(),
    prisma.serial.findMany(),
    prisma.season.findMany(),
    prisma.episode.findMany(),
    prisma.channel.findMany(),
    prisma.user.findMany(),
    prisma.setting.findMany(),
  ]);

  const counts = {
    movies: movies.length,
    serials: serials.length,
    seasons: seasons.length,
    episodes: episodes.length,
    channels: channels.length,
    users: users.length,
  };

  const data = {
    exportedAt: new Date().toISOString(),
    version: 2,
    counts,
    data: { movies, serials, seasons, episodes, channels, users, settings },
  };

  const json = JSON.stringify(data, bigintReplacer); // pretty-print yo'q — joy tejash uchun
  const gz = gzipSync(Buffer.from(json, "utf-8"));
  const fileName = `kinobot-backup-${new Date().toISOString().slice(0, 10)}.json.gz`;
  return { file: new InputFile(gz, fileName), fileName, counts };
}

/**
 * Backup faylini (gzip yoki oddiy JSON) yuklab, parse qiladi.
 * Gzip magic byteslari (0x1f 0x8b) orqali aniqlanadi — kengaytmaga bog'liq emas,
 * eski (siqilmagan) backuplar bilan ham moslashuvchan ishlaydi.
 */
export async function fetchAndParseBackup(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url);
  const buf = Buffer.from(await res.arrayBuffer());
  const isGzip = buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
  const text = isGzip ? gunzipSync(buf).toString("utf-8") : buf.toString("utf-8");
  return JSON.parse(text);
}

const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // har soatda tekshirish

/** Avtomatik backup rejalashtiruvchi — har soatda 3 kunlik muddatni tekshiradi */
export function startAutoBackup(bot: Bot<MyContext>): void {
  const tick = async () => {
    try {
      const enabled = await getBool(KEYS.autoBackupEnabled, false);
      if (!enabled) return;

      const lastStr = await getSetting(KEYS.lastBackupAt, "");
      const last = lastStr ? Number(lastStr) : 0;
      if (Date.now() - last < THREE_DAYS_MS) return;

      const { file, counts } = await buildBackupFile();
      const owner = config.ownerIds[0];
      if (!owner) return;

      await bot.api.sendDocument(Number(owner), file, {
        caption:
          `<b>Avtomatik backup</b> (3 kunlik)\n\n` +
          `Kinolar: <b>${counts.movies}</b>\n` +
          `Seriallar: <b>${counts.serials}</b>\n` +
          `Kanallar: <b>${counts.channels}</b>\n` +
          `Foydalanuvchilar: <b>${counts.users}</b>`,
        parse_mode: "HTML",
      });

      await setSetting(KEYS.lastBackupAt, String(Date.now()));
    } catch {
      // xatolik botni to'xtatmasin
    }
  };

  // Ishga tushgach 1 daqiqadan keyin, so'ng har soatda
  setTimeout(tick, 60_000);
  setInterval(tick, CHECK_INTERVAL_MS);
}
