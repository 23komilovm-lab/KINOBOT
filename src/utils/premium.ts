import { prisma } from "../prisma.js";
import { getBool, getSetting, KEYS } from "./settings.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Foydalanuvchi hozir premiummi? */
export function isPremiumActive(premiumUntil: Date | null | undefined): boolean {
  return !!premiumUntil && premiumUntil.getTime() > Date.now();
}

/** Premium/limit tizimi umuman yoqilganmi? */
export function premiumEnabled(): Promise<boolean> {
  return getBool(KEYS.premiumEnabled, false);
}

export async function getFreeLimits(): Promise<{ requests: number; days: number }> {
  const [r, d] = await Promise.all([
    getSetting(KEYS.freeRequestLimit, "0"),
    getSetting(KEYS.freeDays, "0"),
  ]);
  return { requests: parseInt(r, 10) || 0, days: parseInt(d, 10) || 0 };
}

/** Foydalanuvchiga premium beradi (mavjud premiumga qo'shadi yoki hozirdan boshlaydi) */
export async function grantPremium(userId: bigint, days: number): Promise<Date> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  const base = isPremiumActive(user?.premiumUntil) ? user!.premiumUntil!.getTime() : Date.now();
  const until = new Date(base + days * DAY_MS);
  // premiumWarnStage 0 ga qaytadi — uzaytirilgan obuna uchun ogohlantirishlar qaytadan boshlanadi
  await prisma.user.update({
    where: { id: userId },
    data: { premiumUntil: until, premiumWarnStage: 0 },
  }).catch(() => null);
  return until;
}

/** Faol tariflar (tartiblangan) */
export function activeTariffs() {
  return prisma.tariff.findMany({ where: { isActive: true }, orderBy: { sortOrder: "asc" } });
}

/**
 * Standart 4 ta tarifni qo'shadi (agar hech qanday tarif bo'lmasa).
 * Chegirmasiz, oddiy narxlar (oldPrice yo'q). Stars narxi ~150 so'm = 1 Stars
 * nisbatida hisoblangan (avvalgi tariflardagi nisbat bilan bir xil).
 * Kunlik xarajat uzoq muddatda arzonlashadi, ya'ni 1 yil eng foydali:
 * 1 oy: 333 so'm/kun · 3 oy: 200 so'm/kun · 6 oy: 150 so'm/kun · 1 yil: 137 so'm/kun
 */
export const DEFAULT_TARIFFS = [
  { label: "1 oy",  days: 30,  price: 10000, oldPrice: null, starsPrice: 67,  sortOrder: 0 },
  { label: "3 oy",  days: 90,  price: 18000, oldPrice: null, starsPrice: 120, sortOrder: 1 },
  { label: "6 oy",  days: 180, price: 27000, oldPrice: null, starsPrice: 180, sortOrder: 2 },
  { label: "1 yil", days: 365, price: 50000, oldPrice: null, starsPrice: 333, sortOrder: 3 },
];

export async function seedDefaultTariffs(): Promise<boolean> {
  const count = await prisma.tariff.count();
  if (count > 0) return false;
  await prisma.tariff.createMany({ data: DEFAULT_TARIFFS });
  return true;
}

/** Standart tariflarni majburan qayta yozadi (narx aksiyasini yangilash uchun) */
export async function resetToDefaultTariffs(): Promise<void> {
  await prisma.tariff.deleteMany({});
  await prisma.tariff.createMany({ data: DEFAULT_TARIFFS });
}
