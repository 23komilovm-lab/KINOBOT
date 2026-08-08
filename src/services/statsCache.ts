/**
 * STATISTIKA KESHI (3.5)
 *
 * Admin statistika har ochilishda 9-17 DB so'rov bajaradi. Bu qiymatlar 60
 * soniyada o'zgarsa ham admin xabari "eskirgan" bo'lib ko'rinmaydi (sonlarni
 * hech kim real vaqtda kuzatmaydi) — shuning uchun har kalit 60s keshlanadi.
 *
 * Kesh hajmi cheklangan (kalitlar soni kichik: overview, aiAdminStats va h.k.)
 * va TTL eskirgan qiymatni keyingi so'rovda yangilaydi.
 */
const TTL_MS = 60 * 1000;

type Entry = { value: string; expiresAt: number };
const cache = new Map<string, Entry>();

/** Qiymatni keshlab qaytaradi; TTL o'tgan bo'lsa `fetch` orqali qayta hisoblaydi. */
export async function getCachedStat(key: string, fetch: () => Promise<string>): Promise<string> {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const value = await fetch();
  cache.set(key, { value, expiresAt: Date.now() + TTL_MS });
  return value;
}

/** Bitta (yoki barcha) statistika keshini tozalaydi. */
export function clearStatsCache(key?: string): void {
  if (key) cache.delete(key);
  else cache.clear();
}
