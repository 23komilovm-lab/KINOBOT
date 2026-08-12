/**
 * TELEGRAM A'ZO SONI KESHI
 *
 * `getChatMemberCount` — har ko'rinishda jonli chaqirilganda Telegram
 * rate-limit xavfi bor (kanal panali + hamkor hisobotlari). Shuning uchun
 * qiymat 10 daqiqa keshlanadi; "Yangilash" tugmasi `bypass` bilan keshlab
 * o'tib, jonli qiymatni oladi. statsCache.ts bilan bir xil Map+TTL naqshi.
 */
const TTL_MS = 10 * 60 * 1000;

type Entry = { value: number; expiresAt: number };
const cache = new Map<string, Entry>();

// Strukturaviy tip — grammY `ctx.api` bilan mos, testda oson mock.
type ApiLike = { getChatMemberCount(chatId: number): Promise<number> };

/** Keshdagi a'zo sonini qaytaradi; yo'q bo'lsa Telegram'dan olib keshlaydi. Xato → null. */
export async function getCachedMemberCount(
  api: ApiLike,
  chatId: bigint,
  opts?: { bypass?: boolean }
): Promise<number | null> {
  const key = chatId.toString();
  if (!opts?.bypass) {
    const hit = cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value;
  }
  try {
    const value = await api.getChatMemberCount(Number(chatId));
    cache.set(key, { value, expiresAt: Date.now() + TTL_MS });
    return value;
  } catch {
    return null;
  }
}

/** Bitta kanalning a'zo-soni keshini tozalaydi (kanal o'chirilganda/refresh'da) */
export function clearMemberCount(chatId: bigint): void {
  cache.delete(chatId.toString());
}

/** Barcha a'zo-soni keshlarini tozalaydi */
export function clearAllMemberCounts(): void {
  cache.clear();
}
