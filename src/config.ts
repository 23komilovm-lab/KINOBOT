import "dotenv/config";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`❌ .env da ${name} topilmadi`);
  return v;
}

export const config = {
  botToken: required("BOT_TOKEN"),
  ownerIds: (process.env.ADMIN_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => BigInt(s)),
  baseChannelId: process.env.BASE_CHANNEL_ID ? Number(process.env.BASE_CHANNEL_ID) : null,
  movieChannelId: process.env.MOVIE_CHANNEL_ID ? Number(process.env.MOVIE_CHANNEL_ID) : null,
  // To'lov cheklari kanali — har bir chek (screenshot + to'liq ma'lumot) shu
  // yerga ham yuboriladi, adminga DM kelmasa ham doimiy yozuv sifatida qoladi
  // (firibgarlik holatida foydalanuvchini topish uchun).
  paymentChannelId: process.env.PAYMENT_CHANNEL_ID ? Number(process.env.PAYMENT_CHANNEL_ID) : null,
  usePremiumEmoji: (process.env.USE_PREMIUM_EMOJI ?? "true") === "true",
  // AI provayder kalitlari (ixtiyoriy — qaysi biri bo'lsa o'sha ishlaydi)
  // GEMINI_API_KEY olib tashlandi (2026-08-21) — Google loyihasi bloklangan (403)
  groqApiKey: process.env.GROQ_API_KEY ?? "",
  openrouterApiKey: process.env.OPENROUTER_API_KEY ?? "",
  mistralApiKey: process.env.MISTRAL_API_KEY ?? "",
  adminContactUrl: process.env.ADMIN_CONTACT_URL ?? "https://t.me/akajon_00",
};

// Webhook rejimi uchun secret MAJBURIY — bashorat qilib bo'ladigan default
// (ilgari "kinobot-secret") jamoatchilikka ochiq webhook endpointni soxta
// update'lardan himoya qila olmaydi. USE_WEBHOOK=true bo'lsa xato tashlanadi.
{
  const useWebhook = process.env.USE_WEBHOOK === "true" || !!process.env.WEBHOOK_URL;
  if (useWebhook && !process.env.WEBHOOK_SECRET) {
    throw new Error("❌ WEBHOOK_SECRET .env da ko'rsatilishi shart (webhook rejimida)!");
  }
}

// Dinamik admin Set — ownerlar + DB'dan yuklangan qo'shimcha adminlar
export const adminIds = new Set<bigint>(config.ownerIds);

// Admin huquqlari (in-memory). null = barcha bo'limlar ruxsat
export const adminPerms = new Map<string, string[] | null>();
// Kanal qo'shish limiti. null/undefined = cheksiz
export const adminChannelLimit = new Map<string, number | null>();

export function isOwner(userId?: number | bigint): boolean {
  if (!userId) return false;
  const id = BigInt(userId);
  return config.ownerIds.some((o) => o === id);
}

export function isAdmin(userId?: number | bigint): boolean {
  if (!userId) return false;
  return adminIds.has(BigInt(userId));
}

export function addAdminId(id: bigint): void {
  adminIds.add(id);
}

export function removeAdminId(id: bigint): void {
  if (!config.ownerIds.includes(id)) adminIds.delete(id);
}

/** Admin biror bo'limga ruxsati bormi? Owner — har doim ha. */
export function adminCan(userId: number | bigint, section: string): boolean {
  if (isOwner(userId)) return true;
  const perms = adminPerms.get(BigInt(userId).toString());
  if (perms === null) return true; // null = DB'da permissions cheklanmagan — barcha bo'limlar
  return perms?.includes(section) ?? false; // undefined (noma'lum yozuv) → RAD ETILADI
}

/** Admin qo'sha oladigan kanal limiti (null = cheksiz) */
export function getChannelLimit(userId: number | bigint): number | null {
  if (isOwner(userId)) return null;
  const lim = adminChannelLimit.get(BigInt(userId).toString());
  return lim ?? null;
}

export function setAdminPerms(id: bigint, perms: string[] | null): void {
  adminPerms.set(id.toString(), perms);
}

export function setAdminChannelLimit(id: bigint, limit: number | null): void {
  adminChannelLimit.set(id.toString(), limit);
}

/**
 * Admin holatini DB'dan qayta yuklaydi. Backuplardan tiklash (restore) DB'dagi
 * admin qatorlarini o'zgartirishi mumkin — shundan keyin in-memory
 * adminIds/adminPerms/adminChannelLimit eskirib qoladi. Shu funksiya ularni
 * qayta sinxronlaydi (owner'lar har doim saqlanadi).
 *
 * prisma'ni dinamik import qilamiz — config.ts barcha modullar tomonidan juda
 * erta yuklanadi, import vaqtida PrismaClient yaratishni majburlamaymiz.
 */
export async function syncAdminStateFromDb(): Promise<void> {
  const { prisma } = await import("./prisma.js");
  const { parsePerms } = await import("./utils/permissions.js");

  adminIds.clear();
  for (const o of config.ownerIds) adminIds.add(o);
  adminPerms.clear();
  adminChannelLimit.clear();

  const dbAdmins = await prisma.user.findMany({
    where: { isAdmin: true },
    select: { id: true, permissions: true, channelLimit: true },
  });
  for (const admin of dbAdmins) {
    adminIds.add(admin.id);
    setAdminPerms(admin.id, parsePerms(admin.permissions));
    setAdminChannelLimit(admin.id, admin.channelLimit ?? null);
  }
}
