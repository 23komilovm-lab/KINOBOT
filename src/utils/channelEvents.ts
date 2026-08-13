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
 *
 * `inviteLink` — Telegram bergan aynan o'sha taklif havolasi (bo'lsa). Havola
 * kesimidagi statistika ("eski havola orqali qancha, yangisi orqali qancha")
 * shu ustunga tayanadi. `null` ustidan YOZILMAYDI: `sub:check` yo'li havolani
 * bilmaydi, lekin `chat_member` allaqachon yozgan bo'lishi mumkin.
 */
export async function recordChannelJoin(
  channelId: bigint,
  userId: number,
  source: string,
  inviteLink: string | null = null
): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        INSERT INTO "channel_members" ("channelId", "userId", "joinedAt", "source", "inviteLink", "leftAt")
        VALUES (${channelId}, ${BigInt(userId)}, now(), ${source}, ${inviteLink}, NULL)
        ON CONFLICT ("channelId", "userId") DO UPDATE SET
          "joinedAt" = EXCLUDED."joinedAt",
          "source" = CASE
            WHEN "channel_members"."source" = 'bot' THEN 'bot'
            ELSE EXCLUDED."source"
          END,
          "inviteLink" = COALESCE(EXCLUDED."inviteLink", "channel_members"."inviteLink"),
          "leftAt" = NULL`;

      const since = new Date(Date.now() - ATTRIB_WINDOW_MS);
      const existing = await tx.channelEvent.findFirst({
        where: { channelId, userId: BigInt(userId), type: "join", date: { gte: since } },
        orderBy: { date: "desc" },
      });

      if (existing) {
        const data: { source?: string; inviteLink?: string } = {};
        if (source === "bot" && existing.source !== "bot") data.source = "bot";
        if (inviteLink && !existing.inviteLink) data.inviteLink = inviteLink;
        if (Object.keys(data).length > 0) {
          await tx.channelEvent.update({ where: { id: existing.id }, data });
        }
        return;
      }

      // chat_member kelmagan holat (bot kanalda admin emas, yoki qayta qo'shilish)
      // — o'zimiz yozamiz.
      await tx.channelEvent.create({
        data: { channelId, userId: BigInt(userId), type: "join", source, inviteLink },
      });
    });
  } catch {
    // Xatolik yuz berganda statistika buzilmasin, bot ishlayveradi (eskicha xatti-harakat).
  }
}

/**
 * A'zolik snapshotini hodisalar jurnalidan TIKLAYDI (bitta kanal uchun).
 *
 * Kanal paneldan o'chirilib qayta qo'shilganda ishlatiladi: `channel_events`
 * append-only va kanaldan omon qoladi, `channel_members` esa ilgari cascade
 * bilan o'chib ketardi. Cascade olib tashlandi, lekin undan OLDIN o'chirilgan
 * kanallarning snapshoti hamon yo'q — qayta qo'shilganda shu funksiya uni
 * jurnaldan qayta quradi.
 *
 * Idempotent: mavjud (kanal, foydalanuvchi) qatorlari tegilmaydi, ya'ni jonli
 * yozuvlar ustidan yozilmaydi. Qaytaradi: qo'shilgan qatorlar soni.
 */
export async function rebuildMemberSnapshot(channelId: bigint): Promise<number> {
  try {
    return await prisma.$executeRaw`
      INSERT INTO "channel_members" ("channelId", "userId", "joinedAt", "source", "inviteLink", "leftAt")
      SELECT
        je."channelId", je."userId", je."date",
        CASE WHEN EXISTS (SELECT 1 FROM "channel_events" jb
              WHERE jb."channelId" = je."channelId" AND jb."userId" = je."userId"
                AND jb."type" = 'join' AND jb."source" = 'bot')
             THEN 'bot' ELSE COALESCE(je."source", 'unknown') END,
        je."inviteLink",
        (SELECT MIN(le."date") FROM "channel_events" le
           WHERE le."channelId" = je."channelId" AND le."userId" = je."userId"
             AND le."type" = 'leave' AND le."date" > je."date")
      FROM "channel_events" je
      WHERE je."channelId" = ${channelId}
        AND je."type" = 'join'
        AND NOT EXISTS (SELECT 1 FROM "channel_events" je2
            WHERE je2."channelId" = je."channelId" AND je2."userId" = je."userId"
              AND je2."type" = 'join'
              AND (je2."date" > je."date" OR (je2."date" = je."date" AND je2."id" > je."id")))
      ON CONFLICT ("channelId", "userId") DO NOTHING`;
  } catch (err) {
    // Tiklash statistika uchun — yiqilsa kanal qo'shish oqimi to'xtamasin.
    console.warn(
      `[channelEvents] snapshot tiklanmadi chatId=${channelId}:`,
      (err as Error).message
    );
    return 0;
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
