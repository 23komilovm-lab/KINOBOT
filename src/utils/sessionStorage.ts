import { prisma } from "../prisma.js";
import type { StorageAdapter } from "grammy";

/**
 * Sessiyani PostgreSQL'da saqlaydigan adapter (write-through kesh bilan).
 *
 * Nima uchun: standart `session()` sessiyani faqat xotirada saqlaydi va
 * redeploy/restart'da admin yarim tayyorlagan broadcast, kino qo'shish
 * oqimi va h.k. yo'qolardi.
 *
 * Yuklamani kamaytirish uchun:
 *  · o'qish keshdan (bir foydalanuvchi uchun restartdan keyin bir marta SELECT)
 *  · yozish faqat qiymat o'zgargan bo'lsa
 *  · bo'sh sessiya (`{}`) umuman saqlanmaydi
 *
 * Cheklovlar (3.4): kesh o'lchami LRU eviction bilan ~5000 bilan cheklanadi
 * (aktiv bo'lmagan sessiyalar DB'dan qayta o'qiladi), 30 daqiqadan ortiq
 * ishlatilmagan yozuvlar davriy supuriladi. Baza xatosi hech qachon botni
 * to'xtatmaydi — eng yomoni sessiya xotirada qoladi.
 */
const MAX_CACHE_ENTRIES = 5000;
const STALE_MS = 30 * 60 * 1000; // keshda shuncha ishlatilmasa — o'lik deb hisobla

type CacheEntry = { value: string; touchedAt: number }; // "" = bazada yozuv yo'q

export function prismaSessionStorage<T>(): StorageAdapter<T> {
  const cache = new Map<string, CacheEntry>();
  let lastSweepAt = 0;

  // LRU eviction: eng uzoq ishlatilmagan bitta yozuvni chiqarib tashlaydi.
  // Faqat o'lcham chegarasidan oshganda ishlaydi (chastotasi past).
  function evictIfNeeded(): void {
    while (cache.size > MAX_CACHE_ENTRIES) {
      let oldestKey: string | null = null;
      let oldestAt = Infinity;
      for (const [k, e] of cache) {
        if (e.touchedAt < oldestAt) {
          oldestAt = e.touchedAt;
          oldestKey = k;
        }
      }
      if (oldestKey === null) break;
      cache.delete(oldestKey);
    }
  }

  // 30 daqiqadan beri ishlatilmagan yozuvlarni chiqaradi (DB'dan qayta olinadi).
  // Har 30 daqiqada bir marta — har o'qishda O(n) skan qilmaymiz.
  function sweepStale(now: number): void {
    if (now - lastSweepAt < STALE_MS) return;
    lastSweepAt = now;
    for (const [k, e] of cache) {
      if (now - e.touchedAt > STALE_MS) cache.delete(k);
    }
  }

  return {
    async read(key: string): Promise<T | undefined> {
      const now = Date.now();
      sweepStale(now);
      let entry = cache.get(key);
      if (!entry) {
        const row = await prisma.session.findUnique({ where: { key } }).catch(() => null);
        entry = { value: row?.value ?? "", touchedAt: now };
        cache.set(key, entry);
        evictIfNeeded();
      }
      entry.touchedAt = now;
      if (!entry.value) return undefined;
      try {
        return JSON.parse(entry.value) as T;
      } catch {
        return undefined;
      }
    },

    async write(key: string, value: T): Promise<void> {
      let json: string;
      try {
        json = JSON.stringify(value);
      } catch {
        return; // seriyalab bo'lmadi — xotiradagi holat baribir ishlaydi
      }

      const now = Date.now();
      const prev = cache.get(key)?.value;
      if (prev === json) {
        cache.get(key)!.touchedAt = now;
        return;
      }
      cache.set(key, { value: json, touchedAt: now });
      evictIfNeeded();

      // Bo'sh sessiyani saqlamaymiz; avval ham bo'sh bo'lgan bo'lsa bazaga tegmaymiz
      if (json === "{}") {
        if (prev && prev !== "{}") {
          await prisma.session.deleteMany({ where: { key } }).catch(() => null);
        }
        return;
      }

      await prisma.session
        .upsert({
          where: { key },
          create: { key, value: json },
          update: { value: json },
        })
        .catch(() => null);
    },

    async delete(key: string): Promise<void> {
      cache.set(key, { value: "", touchedAt: Date.now() });
      await prisma.session.deleteMany({ where: { key } }).catch(() => null);
    },
  };
}
