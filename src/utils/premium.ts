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
  await prisma.user.update({ where: { id: userId }, data: { premiumUntil: until } }).catch(() => null);
  return until;
}

/** Faol tariflar (tartiblangan) */
export function activeTariffs() {
  return prisma.tariff.findMany({ where: { isActive: true }, orderBy: { sortOrder: "asc" } });
}

/**
 * Standart 3 ta tarifni qo'shadi (agar hech qanday tarif bo'lmasa).
 * Aksiya narxlari — eski narxdan 80% chegirma (oldPrice ustidan chizilgan holda ko'rsatiladi).
 * Kunlik xarajat uzoq muddatda yana arzonlashadi (1 yil eng foydali):
 * 1 oy: 167 so'm/kun · 3 oy: 133 so'm/kun (~20% arzon) · 1 yil: 99 so'm/kun (~41% arzon)
 */
export const DEFAULT_TARIFFS = [
  { label: "1 oy",  days: 30,  price: 5000,  oldPrice: 25000,  sortOrder: 0 },
  { label: "3 oy",  days: 90,  price: 12000, oldPrice: 60000,  sortOrder: 1 },
  { label: "1 yil", days: 365, price: 36000, oldPrice: 180000, sortOrder: 2 },
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
