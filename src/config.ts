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
  baseChannelId: process.env.BASE_CHANNEL_ID
    ? Number(process.env.BASE_CHANNEL_ID)
    : null,
  movieChannelId: process.env.MOVIE_CHANNEL_ID
    ? Number(process.env.MOVIE_CHANNEL_ID)
    : null,
  // To'lov cheklari kanali — har bir chek (screenshot + to'liq ma'lumot) shu
  // yerga ham yuboriladi, adminga DM kelmasa ham doimiy yozuv sifatida qoladi
  // (firibgarlik holatida foydalanuvchini topish uchun).
  paymentChannelId: process.env.PAYMENT_CHANNEL_ID
    ? Number(process.env.PAYMENT_CHANNEL_ID)
    : null,
  usePremiumEmoji: (process.env.USE_PREMIUM_EMOJI ?? "true") === "true",
  // AI provayder kalitlari (ixtiyoriy — qaysi biri bo'lsa o'sha ishlaydi)
  geminiApiKey:     process.env.GEMINI_API_KEY ?? "",
  groqApiKey:       process.env.GROQ_API_KEY ?? "",
  openrouterApiKey: process.env.OPENROUTER_API_KEY ?? "",
  cerebrasApiKey:   process.env.CEREBRAS_API_KEY ?? "",
  githubModelsToken: process.env.GITHUB_MODELS_TOKEN ?? "",
  mistralApiKey:    process.env.MISTRAL_API_KEY ?? "",
};

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
  if (perms === null || perms === undefined) return true; // cheklovsiz admin
  return perms.includes(section);
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
