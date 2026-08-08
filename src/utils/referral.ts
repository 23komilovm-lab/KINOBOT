import { prisma } from "../prisma.js";
import { getSetting, KEYS } from "./settings.js";
import { grantPremium } from "./premium.js";
import type { MyContext } from "../types.js";

/** Mukofot sozlamalari: har `count` ta referal uchun `days` kun premium. 0 = o'chirilgan. */
export async function getReferralReward(): Promise<{ count: number; days: number }> {
  const [c, d] = await Promise.all([
    getSetting(KEYS.referralRewardCount, "0"),
    getSetting(KEYS.referralRewardDays, "0"),
  ]);
  return { count: parseInt(c, 10) || 0, days: parseInt(d, 10) || 0 };
}

/**
 * Yangi foydalanuvchiga referrerni biriktiradi (faqat yangi bo'lsa).
 * referralConfirmed=false — obunadan keyin tasdiqlanadi.
 */
export async function attachReferrer(userId: number, referrerId: number): Promise<void> {
  if (userId === referrerId) return;

  const user = await prisma.user.findUnique({ where: { id: BigInt(userId) } });
  if (!user) return;
  if (user.referredById !== null) return; // allaqachon biriktirilgan

  // Faqat yangi foydalanuvchi (60 soniya ichida yaratilgan) uchun
  const ageMs = Date.now() - user.createdAt.getTime();
  if (ageMs > 60_000) return;

  const referrer = await prisma.user.findUnique({ where: { id: BigInt(referrerId) } });
  if (!referrer) return;

  await prisma.user
    .update({
      where: { id: BigInt(userId) },
      data: { referredById: BigInt(referrerId) },
    })
    .catch(() => null);
}

/**
 * Obunadan keyin referalni tasdiqlaydi va referrerga xabar beradi.
 * Faqat bir marta ishlaydi.
 */
export async function confirmReferral(ctx: MyContext, userId: number): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: BigInt(userId) } });
  if (!user || !user.referredById || user.referralConfirmed) return;

  await prisma.user
    .update({
      where: { id: BigInt(userId) },
      data: { referralConfirmed: true },
    })
    .catch(() => null);

  // Referrerga xabar
  const count = await prisma.user.count({
    where: { referredById: user.referredById, referralConfirmed: true },
  });

  // ── Mukofot ──
  // Har `reward.count` ta referalda `reward.days` kun premium beriladi.
  // Tasdiqlash har bir taklif qilingan foydalanuvchi uchun FAQAT BIR MARTA
  // sodir bo'ladi, shuning uchun chegaradan o'tish ham aniq bir marta ushlanadi
  // — takroriy mukofot berilmaydi.
  const reward = await getReferralReward();
  let rewardText = "";
  if (reward.count > 0 && reward.days > 0 && count % reward.count === 0) {
    const until = await grantPremium(user.referredById, reward.days);
    rewardText =
      `\n\n<tg-emoji emoji-id="5258093637450866522">💎</tg-emoji> <b>Mukofot: ${reward.days} kun Premium!</b>\n` +
      `${reward.count} ta do'stingiz qo'shilgani uchun. Premium <b>${until.toLocaleDateString("ru-RU")}</b> gacha amal qiladi.`;
  } else if (reward.count > 0 && reward.days > 0) {
    const left = reward.count - (count % reward.count);
    rewardText = `\n\n🎁 Yana <b>${left}</b> ta do'st — va <b>${reward.days} kun Premium</b> sovg'a!`;
  }

  await ctx.api
    .sendMessage(
      Number(user.referredById),
      `🎉 <b>Yangi referal!</b>\n\nSizning havolangiz orqali yangi foydalanuvchi qo'shildi.\n` +
        `Jami referallaringiz: <b>${count}</b> ta` +
        rewardText,
      { parse_mode: "HTML" }
    )
    .catch(() => null);
}

/** Foydalanuvchining tasdiqlangan referallar soni */
export async function getReferralCount(userId: number): Promise<number> {
  return prisma.user.count({
    where: { referredById: BigInt(userId), referralConfirmed: true },
  });
}
