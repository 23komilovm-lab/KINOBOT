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
 * Baza xatosi hech qachon botni to'xtatmaydi — eng yomoni sessiya xotirada qoladi.
 */
export function prismaSessionStorage<T>(): StorageAdapter<T> {
  const cache = new Map<string, string>(); // "" = bazada yozuv yo'q

  return {
    async read(key: string): Promise<T | undefined> {
      let raw = cache.get(key);
      if (raw === undefined) {
        const row = await prisma.session.findUnique({ where: { key } }).catch(() => null);
        raw = row?.value ?? "";
        cache.set(key, raw);
      }
      if (!raw) return undefined;
      try {
        return JSON.parse(raw) as T;
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

      const prev = cache.get(key);
      if (prev === json) return;
      cache.set(key, json);

      // Bo'sh sessiyani saqlamaymiz; avval ham bo'sh bo'lgan bo'lsa bazaga tegmaymiz
      if (json === "{}") {
        if (prev && prev !== "{}") {
          await prisma.session.deleteMany({ where: { key } }).catch(() => null);
        }
        return;
      }

      await prisma.session.upsert({
        where: { key },
        create: { key, value: json },
        update: { value: json },
      }).catch(() => null);
    },

    async delete(key: string): Promise<void> {
      cache.set(key, "");
      await prisma.session.deleteMany({ where: { key } }).catch(() => null);
    },
  };
}