import { prisma } from "../prisma.js";

/**
 * Qo'shilish atributsiya oynasi. 30 daqiqa ichida qo'shilgan bo'lsa — o'sha
 * yozuv manbasi yangilanadi (yangi yozuv yaratilmaydi), aks holda yangi yozuv.
 * `chat_member` (kanal chati) va `sub:check` (shaxsiy chat) parallel kelganda
 * dublikat yozuv yaratilmasligining vaqt-bazasi.
 */
export const ATTRIB_WINDOW_MS = 30 * 60 * 1000;

/**
 * Qo'shilishni ATOMIK yozadi — bitta tranzaksiya ichida:
 *  1. Snapshot `ON CONFLICT` upsert — serializatsiya nuqtasi. Postgres ikki
 *     parallel yozuvchini satr-lockda navbatga qo'yadi: ikkinchisi birinchisining
 *     commit qilgan holatini ko'radi va faqat ko'taradi (dublikat yo'q).
 *  2. Event log'da so'nggi 30 daqiqada join bormi: borsa faqat `source`'ni
 *     `'bot'` ga oshiradi, yo'q bo'lsa yangi join event yozadi.
 *
 * `source` "bot" dan pastga TUSHIRILMAYDI: bir marta bot-tracking orqali
 * kelgan foydalanuvchi keyin organik kirsa ham "bot" bo'lib qolaveradi.
 */
export async function recordChannelJoin(
  channelId: bigint,
  userId: number,
  source: string
): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO "channel_members" ("channelId", "userId", "joinedAt", "source", "leftAt")
        VALUES (${channelId}, ${BigInt(userId)}, now(), ${source}, NULL)
        ON CONFLICT ("channelId", "userId") DO UPDATE SET
          "joinedAt" = EXCLUDED."joinedAt",
          "source" = CASE
            WHEN "channel_members"."source" = 'bot' THEN 'bot'
            ELSE EXCLUDED."source"
          END,
          "leftAt" = NULL`;

      const since = new Date(Date.now() - ATTRIB_WINDOW_MS);
      const existing = await tx.channelEvent.findFirst({
        where: { channelId, userId: BigInt(userId), type: "join", date: { gte: since } },
        orderBy: { date: "desc" },
      });

      if (existing) {
        if (source === "bot" && existing.source !== "bot") {
          await tx.channelEvent.update({ where: { id: existing.id }, data: { source: "bot" } });
        }
        return;
      }

      // chat_member kelmagan holat (bot kanalda admin emas, yoki qayta qo'shilish)
      // — o'zimiz yozamiz.
      await tx.channelEvent.create({
        data: { channelId, userId: BigInt(userId), type: "join", source },
      });
    });
  } catch {
    // Xatolik yuz berganda statistika buzilmasin, bot ishlayveradi (eskicha xatti-harakat).
  }
}

/**
 * Chiqishni ATOMIK yozadi: leave event + snapshot `leftAt` (agar hozir a'zo bo'lsa).
 * Snapshot qatori o'chirilmaydi — joriy a'zolik faktida "chiqib ketgan" belgisi
 * saqlanadi, shunda joriy a'zolar soni vaqti bilan kamayadi (churn).
 */
export async function recordChannelLeave(channelId: bigint, userId: number): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.channelEvent.create({
        data: { channelId, userId: BigInt(userId), type: "leave" },
      });
      await tx.channelMember.updateMany({
        where: { channelId, userId: BigInt(userId), leftAt: null },
        data: { leftAt: new Date() },
      });
    });
  } catch {
    // Xatolikni yutamiz — statistika chiqishni ko'rmasligi botni buzmaydi.
  }
}
