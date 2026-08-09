import { prisma } from "../prisma.js";
import { isAdmin } from "../config.js";
import { ensureSubscribed } from "./subscription.js";
import { getBool, getSetting, KEYS } from "./settings.js";
import { isPremiumActive, premiumEnabled, getFreeLimits } from "./premium.js";
import { sendPremiumPrompt } from "../handlers/premiumUser.js";
import { todayUz } from "./dateRange.js";
import { log } from "./logger.js";
import type { MyContext } from "../types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
// Toshkent vaqti bo'yicha kun kaliti — UTC bo'lsa "kunlik" limit soat 05:00 (UZT) da reset bo'lardi
const today = todayUz;

/** Kontentga ruxsat natijasi — bloklash sababini delivery'ga aytadi. */
export type AccessReason = "ok" | "sub" | "quota" | "premium";
export interface AccessResult {
  ok: boolean;
  /** Bloklash sababi: sub=obuna, quota=bepul limit, premium=premium talab */
  reason: AccessReason;
}

/** Chegara tekshiruvi uchun kerak bo'ladigan minimal foydalanuvchi maydonlari */
interface QuotaUser {
  premiumUntil: Date | null;
  requestCount: number;
  firstRequestAt: Date | null;
  contentRequestDay: string | null;
  contentRequestCount: number;
}

/** Kunlik bepul kontent limiti (0 = o'chirilgan). */
async function getDailyLimit(): Promise<number> {
  return parseInt(await getSetting(KEYS.freeDailyLimit, "0"), 10) || 0;
}

/**
 * Kunlik hisobni oshiradi (yoki yangi kun boshlangan bo'lsa 1 ga o'rnatadi).
 * `user` — countContentRequest oldidan yuklangan User (day aniqlash uchun).
 */
async function bumpDailyCount(userId: bigint, user: QuotaUser | null): Promise<void> {
  const day = today();
  await prisma.user
    .update({
      where: { id: userId },
      data:
        user?.contentRequestDay === day
          ? { contentRequestCount: { increment: 1 } }
          : { contentRequestDay: day, contentRequestCount: 1 },
    })
    .catch((e) => {
      log("warn", "Kunlik kontent hisobi oshmadi", { userId: userId.toString(), error: String(e) });
    });
}

/**
 * Bepul chegara tugaganmi? Hisobni OSHIRMAYDI — faqat o'qiydi.
 * Inline so'rovlar uchun kerak: ular har bosilgan harfda keladi, shuning uchun
 * u yerda hisoblash mumkin emas, lekin chegarani hurmat qilish shart.
 */
export async function isFreeQuotaExhausted(user: QuotaUser | null): Promise<boolean> {
  if (isPremiumActive(user?.premiumUntil)) return false;
  if (!(await premiumEnabled())) return false;

  const { requests: freeReq, days: freeDays } = await getFreeLimits();

  if (freeDays > 0 && user?.firstRequestAt) {
    if (Date.now() - user.firstRequestAt.getTime() > freeDays * DAY_MS) return true;
  }
  if (freeReq > 0 && (user?.requestCount ?? 0) >= freeReq) return true;

  // Kunlik qatlam: `contentRequestDay` bugungi kun bo'lsagina hisob kuchga kiradi
  // (o'tgan kun qoldig'i yangi kunda avtomatik nolga teng).
  const daily = await getDailyLimit();
  if (
    daily > 0 &&
    user?.contentRequestDay === today() &&
    (user?.contentRequestCount ?? 0) >= daily
  ) {
    return true;
  }
  return false;
}

/**
 * Kontent HAQIQATAN yetkazilgandan keyin so'rovni hisoblaydi.
 *
 * Ilgari hisob yetkazishdan OLDIN oshirilardi — xato kod yozgan yoki premium
 * kinoga urilgan foydalanuvchi bepul so'rovini yo'qotib, hech narsa olmasdi.
 */
export async function countContentRequest(ctx: MyContext): Promise<void> {
  const uid = ctx.from?.id;
  if (!uid || isAdmin(uid)) return;
  if (!(await premiumEnabled())) return;

  const user = await prisma.user.findUnique({ where: { id: BigInt(uid) } });
  if (isPremiumActive(user?.premiumUntil)) return;

  const uidB = BigInt(uid);
  await prisma.user
    .update({
      where: { id: uidB },
      data: {
        requestCount: { increment: 1 },
        ...(user?.firstRequestAt ? {} : { firstRequestAt: new Date() }),
      },
    })
    .catch((e) => {
      log("warn", "Kontent so'rovi hisoblanmadi", { userId: uid.toString(), error: String(e) });
    });

  // Kunlik qatlam ham oshiriladi — delivery'dan keyingi haqiqiy hisob
  await bumpDailyCount(uidB, user);
}

/**
 * Kontentga ruxsatni tekshiradi — bloklash sababi bilan qaytaradi.
 * - Admin → har doim ruxsat.
 * - Premium foydalanuvchi → ruxsat, majburiy obuna va limit YO'Q.
 * - Aks holda: majburiy obuna → keyin bepul limit (so'rov soni / vaqt).
 * `count=true` bo'lsa so'rov hisoblanadi (haqiqiy kontent yetkazishda).
 * false qaytsa — bloklovchi xabar allaqachon ko'rsatilgan.
 *
 * Delivery zanjirlari sababga qarab ishlaydi: reason="sub" bo'lsa pendingCode
 * saqlanadi (obuna bo'lgach "Tekshirish" yetkazadi), "quota"/"premium" bo'lsa
 * faqat premium taklifi ko'rsatiladi.
 */
export async function checkContentAccessResult(
  ctx: MyContext,
  count = true
): Promise<AccessResult> {
  const uid = ctx.from!.id;
  if (isAdmin(uid)) return { ok: true, reason: "ok" };

  const user = await prisma.user.findUnique({ where: { id: BigInt(uid) } });

  // Premium — obunasiz va limitsiz
  if (isPremiumActive(user?.premiumUntil)) return { ok: true, reason: "ok" };

  // Majburiy obuna
  const forceSub = await getBool(KEYS.forceSubEnabled, true);
  if (forceSub) {
    const ok = await ensureSubscribed(ctx, uid);
    if (!ok) return { ok: false, reason: "sub" };
  }

  // Premium/limit tizimi o'chirilgan — cheklovsiz
  if (!(await premiumEnabled())) return { ok: true, reason: "ok" };

  const { requests: freeReq, days: freeDays } = await getFreeLimits();

  // Vaqt cheklovi
  if (freeDays > 0 && user?.firstRequestAt) {
    if (Date.now() - user.firstRequestAt.getTime() > freeDays * DAY_MS) {
      // "Limit tugadi" oilasi yagona emoji/atamada — qaysi cheklov tugagani aniq bo'ladi
      await sendPremiumPrompt(ctx, "💎 Bepul foydalanish muddati tugadi.");
      return { ok: false, reason: "quota" };
    }
  }

  // So'rov soni cheklovi
  if (freeReq > 0 && (user?.requestCount ?? 0) >= freeReq) {
    await sendPremiumPrompt(ctx, "💎 Bepul so'rovlar limiti tugadi.");
    return { ok: false, reason: "quota" };
  }

  // Kunlik qatlam: bugungi kunda allaqachon limitga yetganmi?
  const daily = await getDailyLimit();
  if (
    daily > 0 &&
    user?.contentRequestDay === today() &&
    (user?.contentRequestCount ?? 0) >= daily
  ) {
    await sendPremiumPrompt(ctx, "💎 Bugungi bepul limit tugadi. Ertaga qayta tiklanadi!");
    return { ok: false, reason: "quota" };
  }

  // So'rovni hisoblash (umrlik + kunlik)
  if (count) {
    const uidB = BigInt(uid);
    await prisma.user
      .update({
        where: { id: uidB },
        data: {
          requestCount: { increment: 1 },
          ...(user?.firstRequestAt ? {} : { firstRequestAt: new Date() }),
        },
      })
      .catch((e) => {
        log("warn", "Kontent so'rovi hisoblanmadi", { userId: uid.toString(), error: String(e) });
      });
    await bumpDailyCount(uidB, user);
  }

  return { ok: true, reason: "ok" };
}

/** Eski imzo — faqat ok/yo'q (sabab kerak bo'lmagan joylar uchun). */
export async function checkContentAccess(ctx: MyContext, count = true): Promise<boolean> {
  return (await checkContentAccessResult(ctx, count)).ok;
}

/**
 * AI so'rovi hisobini oshiradi — faqat AI muvaffaqiyatli javob qaytargandan KEYIN
 * chaqiriladi. Ilgari `checkAiAccess(count=true)` so'rovdan OLDIN hisoblab, xato/
 * rate-limit qaytgan (javobsiz) so'rovlar ham kunlik kvotani yeb ketardi. Endi
 * faqat haqiqiy javob = bitta hisob.
 */
export async function countAiRequest(ctx: MyContext): Promise<void> {
  const uid = ctx.from!.id;
  if (isAdmin(uid)) return;
  const user = await prisma.user.findUnique({ where: { id: BigInt(uid) } });
  if (isPremiumActive(user?.premiumUntil)) return;
  if (!(await premiumEnabled())) return;

  const day = today();
  await prisma.user
    .update({
      where: { id: BigInt(uid) },
      data:
        user?.aiRequestDay === day
          ? { aiRequestCount: { increment: 1 } }
          : { aiRequestDay: day, aiRequestCount: 1 },
    })
    .catch((e) => {
      log("warn", "AI so'rovi hisoblanmadi", { userId: uid.toString(), error: String(e) });
    });
}

/**
 * AI xizmatiga ruxsat (premium funksiya). FAQAT GATE — hisobni oshirmaydi.
 * - Admin/premium → cheksiz.
 * - Aks holda: premium tizimi + freeAiLimit>0 bo'lsa kunlik AI limiti (kun o'zgarsa reset).
 * false qaytsa — premium taklifi ko'rsatilgan.
 *
 * Hisoblash `countAiRequest()` bilan MUVVAFFAQIYATLI javobdan keyin qilinadi —
 * bu funksiyada count yo'q (eski `count=true` xatti-harakati xato so'rovlarni ham
 * hisoblab, kunlik kvotani yeb qo'ygan edi).
 */
export async function checkAiAccess(ctx: MyContext): Promise<boolean> {
  const uid = ctx.from!.id;
  if (isAdmin(uid)) return true;

  const user = await prisma.user.findUnique({ where: { id: BigInt(uid) } });
  if (isPremiumActive(user?.premiumUntil)) return true;

  if (!(await premiumEnabled())) return true;

  const limit = parseInt(await getSetting(KEYS.freeAiLimit, "0"), 10) || 0;
  if (limit <= 0) return true; // AI limiti o'chirilgan — cheklovsiz

  const day = today();
  const usedToday = user?.aiRequestDay === day ? (user?.aiRequestCount ?? 0) : 0;

  if (usedToday >= limit) {
    await sendPremiumPrompt(
      ctx,
      `🤖 Bugungi bepul AI so'rovlaringiz (${limit} ta) tugadi. Premium bilan cheksiz!`
    );
    return false;
  }

  return true;
}
