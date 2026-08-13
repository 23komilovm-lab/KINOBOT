import { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";

/**
 * KANAL STATISTIKASI — aniq hisoblash moduli.
 *
 * Prisma `groupBy._count` `DISTINCT(userId)` qila olmaydi (faqat _all/field),
 * shuning uchun barcha "yagona foydalanuvchi" hisoblari `$queryRaw` orqali
 * bajariladi. `::int` cast — COUNT(DISTINCT ...) bigint qaytaradi, UI uchun
 * number kerak.
 */

/** Davr: gte majburiy emas (null = butun tarix). Barcha chegaralar Toshkent vaqti UTC instant'lari. */
export type ChannelStatsRange = { gte: Date; lte?: Date } | null;

/** WHERE qismini quradi: type filtri + ixtiyoriy vaqt oralig'i */
function rangeConditions(range: ChannelStatsRange, typeFilter: string): Prisma.Sql {
  const parts: Prisma.Sql[] = [Prisma.sql`"type" = ${typeFilter}`];
  if (range) {
    if (range.gte) parts.push(Prisma.sql`"date" >= ${range.gte}`);
    if (range.lte) parts.push(Prisma.sql`"date" <= ${range.lte}`);
  }
  // DIQQAT: separator STRING bo'lishi shart. `Prisma.sql` AND `` berilsa Sql obyekti
  // matnga qo'shilib "[object Object]" bo'lib ketadi va so'rov sintaksis xatosi beradi
  // (bitta shart bo'lganda ko'rinmaydi — separator ishlatilmaydi, faqat davr filtri
  // qo'shilganda chiqadi).
  return Prisma.join(parts, " AND ");
}

/** Davr ichida bot tracking havolasi orqali qo'shilgan YAGONA foydalanuvchilar soni (asosiy metrika) */
export async function countDistinctBotJoins(
  channelId: bigint,
  range: ChannelStatsRange
): Promise<number> {
  const cond = rangeConditions(range, "join");
  const rows = await prisma.$queryRaw<{ n: number }[]>`
    SELECT COUNT(DISTINCT "userId")::int AS n
    FROM "channel_events"
    WHERE "channelId" = ${channelId} AND ${cond} AND "source" = 'bot'`;
  return rows[0]?.n ?? 0;
}

/** Davr ichida qo'shilgan yagona foydalanuvchilarning manba kesimi (source → son) */
export async function countDistinctJoinsBySource(
  channelId: bigint,
  range: ChannelStatsRange
): Promise<Map<string, number>> {
  const cond = rangeConditions(range, "join");
  const rows = await prisma.$queryRaw<{ source: string; n: number }[]>`
    SELECT COALESCE("source", 'unknown') AS source, COUNT(DISTINCT "userId")::int AS n
    FROM "channel_events"
    WHERE "channelId" = ${channelId} AND ${cond}
    GROUP BY COALESCE("source", 'unknown')`;
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.source, r.n);
  return map;
}

/**
 * "Bot orqali" sonini DALIL KUCHI bo'yicha ajratadi.
 *
 * `resolveJoinSource` "bot" yorlig'ini ikki xil yo'l bilan qo'yadi va ularning
 * ishonchliligi TENG EMAS. Uchinchi guruh — kuzatuvdan oldingi yozuvlar:
 *
 *  · `byLink` — Telegram aynan bot yaratgan havolani qaytargan. QAT'IY dalil.
 *  · `byGate` — Telegram havola bermagan (odam ommaviy kanalga @username yoki
 *               qidiruv orqali kirgan), lekin unga shu kanal oxirgi 30 daqiqada
 *               majburiy obuna sifatida ko'rsatilgan. Bu TAXMIN: odam kanalni
 *               o'zi topib qo'shilgan bo'lishi ham mumkin.
 *  · `legacy` — havola ustuni yozila boshlashidan OLDINGI yozuv. Qaysi yo'l
 *               bilan kelgani ma'lum emas — taxmin deb ham, dalil deb ham
 *               belgilash yolg'on bo'lardi.
 */
export async function countBotJoinsBySignal(
  channelId: bigint,
  range: ChannelStatsRange
): Promise<{ byLink: number; byGate: number; legacy: number }> {
  const cond = rangeConditions(range, "join");
  // Kuzatuv boshlangan lahzani o'zimiz aniqlaymiz: havolasi yozilgan eng
  // birinchi yozuv. Qattiq sanani kodga yozib qo'yish deploy vaqtiga bog'liq
  // bo'lardi va noto'g'ri chegara berardi. Hech qanday havola yo'q bo'lsa —
  // kuzatuv hali boshlanmagan, ya'ni hamma yozuv "legacy".
  const rows = await prisma.$queryRaw<{ by_link: number; by_gate: number; legacy: number }[]>`
    WITH cutoff AS (
      SELECT COALESCE(MIN("date"), now()) AS t
      FROM "channel_events" WHERE "inviteLink" IS NOT NULL
    )
    SELECT
      COUNT(DISTINCT "userId") FILTER (WHERE e."inviteLink" IS NOT NULL)::int AS by_link,
      COUNT(DISTINCT "userId") FILTER (
        WHERE e."inviteLink" IS NULL AND e."date" >= (SELECT t FROM cutoff)
      )::int AS by_gate,
      COUNT(DISTINCT "userId") FILTER (
        WHERE e."inviteLink" IS NULL AND e."date" < (SELECT t FROM cutoff)
      )::int AS legacy
    FROM "channel_events" e
    WHERE e."channelId" = ${channelId} AND ${cond} AND e."source" = 'bot'`;
  return {
    byLink: rows[0]?.by_link ?? 0,
    byGate: rows[0]?.by_gate ?? 0,
    legacy: rows[0]?.legacy ?? 0,
  };
}

/** Hozirgi vaqtda bot orqali qo'shilgan va hali kanalda turgan YAGONA a'zolar (churn-aware) */
export async function currentBotMembers(channelId: bigint): Promise<number> {
  const rows = await prisma.$queryRaw<{ n: number }[]>`
    SELECT COUNT(*)::int AS n
    FROM "channel_members"
    WHERE "channelId" = ${channelId} AND "source" = 'bot' AND "leftAt" IS NULL`;
  return rows[0]?.n ?? 0;
}
