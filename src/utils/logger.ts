import { bot } from "../bot.js";
import { config } from "../config.js";

type Level = "info" | "warn" | "error";

// Owner bildirishnomalarini throttling — xato klassiga qarab har 5 daqiqada
// ko'pi bilan 1 ta. Shovqinli takroriy xatolar DM ni yopib yubormasligi uchun.
const THROTTLE_MS = 5 * 60 * 1000;
const lastNotified = new Map<string, number>();

function ts(): string {
  return new Date().toISOString();
}

/** Tuzilgan, timestamp'li log. Meta ixtiyoriy — JSON ko'rinishida qo'shiladi. */
export function log(level: Level, msg: string, meta?: Record<string, unknown>): void {
  const line = meta
    ? `[${ts()}] [${level.toUpperCase()}] ${msg} ${JSON.stringify(meta)}`
    : `[${ts()}] [${level.toUpperCase()}] ${msg}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

/** Xatodan tushunarli matn chiqaradi (GrammyError.description afzal). */
export function formatError(err: unknown): string {
  if (!err) return "noma'lum xato";
  if (typeof err === "object") {
    const anyErr = err as { description?: string; message?: string; error_code?: number };
    if (typeof anyErr.description === "string") {
      return anyErr.error_code
        ? `[${anyErr.error_code}] ${anyErr.description}`
        : anyErr.description;
    }
    if (typeof anyErr.message === "string") return anyErr.message;
  }
  return String(err);
}

/**
 * Owner'larga Telegram orqali xabar yuboradi (throttled, key bo'yicha).
 * Telegram xatosini yutadi — logger hech qachon yiqilmaydi.
 */
export async function notifyOwner(text: string, throttleKey = "general"): Promise<void> {
  const now = Date.now();
  const last = lastNotified.get(throttleKey) ?? 0;
  if (now - last < THROTTLE_MS) return;
  lastNotified.set(throttleKey, now);

  for (const id of config.ownerIds) {
    await bot.api.sendMessage(Number(id), text).catch(() => {});
  }
}
