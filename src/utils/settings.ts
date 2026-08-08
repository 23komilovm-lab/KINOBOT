import { prisma } from "../prisma.js";

// Kesh TTL (3.4): har kalit 5 daqiqa. Admin AI orqali sozlamani o'zgartirsa
// `setSetting` keshni darhol yangilaydi — latensiya bo'lmasligi uchun.
// Boshqa tomondan, cheksiz o'sish va eskirgan qiymatlar ham yo'q (TTL).
const CACHE_TTL_MS = 5 * 60 * 1000;

type CacheEntry = { value: string; expiresAt: number };
const cache = new Map<string, CacheEntry>();

export async function getSetting(key: string, def = ""): Promise<string> {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const row = await prisma.setting.findUnique({ where: { key } });
  const val = row?.value ?? def;
  cache.set(key, { value: val, expiresAt: Date.now() + CACHE_TTL_MS });
  return val;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await prisma.setting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
  // Keshni darhol yangilaymiz — AI [SETTING:] keyingi so'rovda eski qiymatni ko'rmasin
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

export async function getBool(key: string, def = false): Promise<boolean> {
  const v = await getSetting(key, def ? "1" : "0");
  return v === "1" || v === "true";
}

export async function setBool(key: string, value: boolean): Promise<void> {
  await setSetting(key, value ? "1" : "0");
}

export function clearSettingsCache(): void {
  cache.clear();
}

export const KEYS = {
  forceSubEnabled: "force_sub_enabled",
  movieBtnText: "movie_btn_text",
  movieBtnUrl: "movie_btn_url",
  movieBtnStyle: "movie_btn_style",
  serialBtnText: "serial_btn_text",
  serialBtnUrl: "serial_btn_url",
  serialBtnStyle: "serial_btn_style",
  subCheckBtnText: "sub_check_btn_text",
  subCheckBtnStyle: "sub_check_btn_style",
  subChannelBtnLabel: "sub_channel_btn_label",
  movieBtnEnabled: "movie_btn_enabled",
  serialBtnEnabled: "serial_btn_enabled",
  autoBackupEnabled: "auto_backup_enabled",
  lastBackupAt: "last_backup_at",
  aiUserModel: "ai_user_model", // "provider:model" — foydalanuvchi AI scope'i
  aiAdminModel: "ai_admin_model", // "provider:model" — admin AI scope'i
  premiumEnabled: "premium_enabled", // premium/limit tizimi yoq/o'chir
  freeRequestLimit: "free_request_limit", // bepul kino so'rovlari soni (0 = cheksiz)
  freeDays: "free_days", // bepul kunlar (0 = cheksiz)
  freeDailyLimit: "free_daily_limit", // KUNLIK bepul kino so'rovlari (0 = o'chirilgan; Toshkent kuni)
  freeAiLimit: "free_ai_limit", // bepul kunlik AI so'rovlari (0 = cheksiz)
  paymentInfo: "payment_info", // Karta orqali to'lov ko'rsatmasi (karta raqami va h.k.)
  paymentInfoTon: "payment_info_ton", // TON orqali to'lov ko'rsatmasi (wallet manzili va h.k.)
  premiumWarnEnabled: "premium_warn_enabled", // premium tugashi haqida ogohlantirish (default: yoqilgan)
  referralRewardCount: "referral_reward_count", // necha referal uchun mukofot (0 = o'chirilgan)
  referralRewardDays: "referral_reward_days", // necha kun premium beriladi
  postDeliveryEnabled: "post_delivery_enabled", // kino yuborilgach qo'shimcha post yoq/o'chir
  postDeliveryText: "post_delivery_text", // qo'shimcha post matni (masalan APK reklama)
  postDeliveryBtnText: "post_delivery_btn_text", // qo'shimcha post knopkasi matni
  postDeliveryBtnUrl: "post_delivery_btn_url", // qo'shimcha post knopkasi havolasi
  postDeliveryBtnStyle: "post_delivery_btn_style", // qo'shimcha post knopkasi rangi
  geoDetectEnabled: "geo_detect_enabled", // viloyat so'rovnomasida GPS orqali avto-aniqlash tugmasi
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// AI ORQALI BOSHQARILADIGAN SOZLAMALAR (whitelist)
// Admin AI [SETTING:key=value] chiqarsa, FAQAT shu ro'yxatdagi kalitlar qo'llanadi.
// ─────────────────────────────────────────────────────────────────────────────
export interface ControllableSetting {
  key: string;
  label: string;
  type: "bool" | "text" | "int";
}

export const AI_CONTROLLABLE: ControllableSetting[] = [
  { key: KEYS.forceSubEnabled, label: "Majburiy obuna (yoq/o'chir)", type: "bool" },
  { key: KEYS.subCheckBtnText, label: "Tekshirish tugmasi matni", type: "text" },
  { key: KEYS.subChannelBtnLabel, label: "Kanal obuna tugmasi yorlig'i", type: "text" },
  { key: KEYS.aiUserModel, label: "Foydalanuvchi AI modeli (provider:model)", type: "text" },
  { key: KEYS.aiAdminModel, label: "Admin AI modeli (provider:model)", type: "text" },
  { key: KEYS.autoBackupEnabled, label: "Avto backup (yoq/o'chir)", type: "bool" },
];

export function findControllable(key: string): ControllableSetting | undefined {
  return AI_CONTROLLABLE.find((s) => s.key === key);
}

/** Whitelistdagi kalitni tekshirib qo'llaydi. Qo'llansa true. */
export async function applyControllable(key: string, rawValue: string): Promise<boolean> {
  const spec = findControllable(key);
  if (!spec) return false;
  const v = rawValue.trim();
  if (spec.type === "bool") {
    const on =
      /^(1|true|yoq|yoqilgan|ha|on|enable)/i.test(v) &&
      !/^(0|false|o'chir|yo'q|off|disable)/i.test(v);
    await setBool(key, on);
  } else if (spec.type === "int") {
    const n = parseInt(v, 10);
    if (Number.isNaN(n)) return false;
    await setSetting(key, String(n));
  } else {
    await setSetting(key, v.slice(0, 256));
  }
  return true;
}

export async function getGlobalButton(prefix: "movie" | "serial") {
  const textKey = prefix === "movie" ? KEYS.movieBtnText : KEYS.serialBtnText;
  const urlKey = prefix === "movie" ? KEYS.movieBtnUrl : KEYS.serialBtnUrl;
  const styleKey = prefix === "movie" ? KEYS.movieBtnStyle : KEYS.serialBtnStyle;
  const [text, url, style] = await Promise.all([
    getSetting(textKey),
    getSetting(urlKey),
    getSetting(styleKey, "primary"),
  ]);
  return {
    buttonText: text || null,
    buttonUrl: url || null,
    buttonStyle: style || "primary",
  };
}
