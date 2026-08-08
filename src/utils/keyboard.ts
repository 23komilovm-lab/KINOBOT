import { InlineKeyboard, Keyboard } from "grammy";
import { isOwner, adminCan, config } from "../config.js";

// ===================== BOT API 9.4 — PREMIUM EMOJI TUGMALAR =====================
// style: "primary" | "success" | "danger" faqat kerak joylarda ishlatiladi.
// icon_custom_emoji_id: premium emoji tugma ichida ko'rinadi

export type BtnStyle = "primary" | "success" | "danger";

// Premium emoji IDlar — tugmalar uchun
export const BE = {
  stats: "5258391025281408576",
  channel: "5260268501515377807",
  movie: "5258077307985207053",
  serial: "5258391252914676042",
  admin: "5258011929993026890",
  broadcast: "5258020476977946656",
  backup: "5258514780469075716",
  subOn: "5861665979968262792",
  subOff: "5859494848230334025",
  chList: "5257965174979042426",
  chAdd: "5274008024585871702",
  chDelete: "5258130763148172425",
  backMenu: "5193202823411546657",
  editName: "5258331647358540449",
  editUrl: "5260730055880876557",
  list: "5210860842714688276",
  film: "5258077307985207053",
  tv: "4918438965029110683",
  folder: "5260416304224936047",
  check: "5260342697075416641",
  fire: "5193202823411546657",
  settings: "5258509201306557640",
  home: "5258501105293205250",
  star: "5210771709258394044",
  menu: "5260399854500191689",
  users: "5258391025281408576",
  trend: "5258513401784573443",
  botSettings: "5258096772776991776",
  views: "5253959125838090076",
  referral: "5258362837411045098",
} as const;

export const ADMIN_MENU_BUTTONS = {
  stats: "Statistika",
  channels: "Kanal boshqaruvi",
  movies: "Kino boshqaruvi",
  serials: "Serial boshqaruvi",
  broadcast: "Xabar yuborish",
  funnel: "Funnel",
  referrals: "Referal",
  premium: "Premium",
  admins: "Admin boshqaruvi",
  backup: "Backup",
  botSettings: "Bot sozlamalari",
} as const;

export const ADMIN_MENU_TEXT = ADMIN_MENU_BUTTONS.admins;

/** Bot API 9.4: rangli + premium emoji'li inline tugma */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function ibtn(text: string, data: string, style?: BtnStyle, emojiId?: string): any {
  return {
    text,
    callback_data: data,
    ...(style && { style }),
    ...(emojiId && { icon_custom_emoji_id: emojiId }),
  };
}

/** Raw inline keyboard — style qo'llab-quvvatlaydi */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function kb(...rows: any[][]): any {
  return { inline_keyboard: rows };
}

// ===================== ADMIN BILAN BOG'LANISH =====================
// Env'dan sozlanadi (ADMIN_CONTACT_URL) — qattiq kodlangan default'ga tayanmaslik uchun
export const ADMIN_CONTACT_URL = config.adminContactUrl;

/** Foydalanuvchiga yuboriladigan premium xabarlari ostidagi bog'lanish tugmasi */
export function contactAdminBtn() {
  return { text: "📞 Admin bilan bog'lanish", url: ADMIN_CONTACT_URL };
}

/** Faqat "Admin bilan bog'lanish" tugmasidan iborat klaviatura */
export function contactAdminKb() {
  return kb([contactAdminBtn()]);
}

export function rbtn(text: string, style?: BtnStyle, emojiId?: string) {
  return {
    text,
    ...(style && { style }),
    ...(emojiId && { icon_custom_emoji_id: emojiId }),
  };
}

// ===================== ADMIN REPLY KEYBOARD =====================
// premium/backup/funnel/admins asosiy menyudan "Bot sozlamalari" ichiga ko'chirildi.
const SECTION_META: { key: string; text: string; emoji: string }[] = [
  { key: "stats", text: ADMIN_MENU_BUTTONS.stats, emoji: BE.stats },
  { key: "channels", text: ADMIN_MENU_BUTTONS.channels, emoji: BE.channel },
  { key: "movies", text: ADMIN_MENU_BUTTONS.movies, emoji: BE.movie },
  { key: "serials", text: ADMIN_MENU_BUTTONS.serials, emoji: BE.serial },
  { key: "broadcast", text: ADMIN_MENU_BUTTONS.broadcast, emoji: BE.broadcast },
  { key: "referrals", text: ADMIN_MENU_BUTTONS.referrals, emoji: BE.referral },
];

/** "Bot sozlamalari" ichidagi bo'limlar — reply tugma ko'rinishini aniqlash uchun ham */
export const BOT_SETTINGS_SECTIONS = ["backup", "premium", "ai", "funnel"] as const;

export function adminMenuKeyboard(userId?: number | bigint): Keyboard {
  const owner = isOwner(userId);
  const kb = new Keyboard();

  const allowed = SECTION_META.filter((s) => adminCan(userId ?? 0, s.key));

  let col = 0;
  for (const s of allowed) {
    kb.text(s.text, { icon_custom_emoji_id: s.emoji });
    if (++col % 2 === 0) kb.row();
  }
  if (col % 2 !== 0) kb.row();

  // "Bot sozlamalari" — owner yoki ichidagi bo'limlardan biriga huquqi bo'lganlar
  const canBotSettings = owner || BOT_SETTINGS_SECTIONS.some((k) => adminCan(userId ?? 0, k));
  if (canBotSettings) {
    kb.text(ADMIN_MENU_BUTTONS.botSettings, { icon_custom_emoji_id: BE.botSettings }).row();
  }

  // AI yordamchi reply tugmasi olib tashlandi — /ai komandasi orqali kiriladi.

  return kb.resized();
}

export const BOT_SETTINGS_TEXT = {
  admins: "Admin boshqaruvi",
  premium: "Premium",
  ai: "AI sozlamalari",
  backup: "Backup",
  funnel: "Funnel",
  back: "Menyuga qaytish",
} as const;

/** "Bot sozlamalari" bosilganda chiqadigan doimiy (reply) sub-menyu — oddiy, rangsiz tugmalar */
export function botSettingsKeyboard(userId?: number | bigint): Keyboard {
  const owner = isOwner(userId);
  const kb = new Keyboard();

  let col = 0;
  const add = (text: string, emojiId: string) => {
    kb.text(text, { icon_custom_emoji_id: emojiId });
    if (++col % 2 === 0) kb.row();
  };

  if (owner) add(BOT_SETTINGS_TEXT.admins, BE.admin);
  if (adminCan(userId ?? 0, "premium")) add(BOT_SETTINGS_TEXT.premium, "5211179692496808774");
  if (adminCan(userId ?? 0, "ai")) add(BOT_SETTINGS_TEXT.ai, "5258093637450866522");
  if (adminCan(userId ?? 0, "backup")) add(BOT_SETTINGS_TEXT.backup, BE.backup);
  if (adminCan(userId ?? 0, "funnel")) add(BOT_SETTINGS_TEXT.funnel, BE.trend);
  if (col % 2 !== 0) kb.row();

  kb.text(BOT_SETTINGS_TEXT.back, { icon_custom_emoji_id: BE.backMenu }).row();

  return kb.resized();
}

// ===================== FOYDALANUVCHI REPLY KEYBOARD =====================
// Reply (doimiy) klaviaturada FAQAT "AI yordamchi" qoladi — qidiruv (matn
// yozib), referal, mashhur va random kinolar endi / komandalar orqali.
export function userMenuKeyboard(): Keyboard {
  return (
    new Keyboard()
      .text("AI yordamchi", {
        icon_custom_emoji_id: "5258093637450866522",
        style: "primary",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any)
      .resized()
  );
}

/** AI suhbati davomida ko'rinadigan doimiy klaviatura — faqat chiqish tugmasi */
export function aiActiveKeyboard(): Keyboard {
  return new Keyboard().text("❌ Chiqish").resized();
}

export function cancelKeyboard(): Keyboard {
  return new Keyboard().text("❌ Bekor qilish").resized().oneTime();
}

export { InlineKeyboard, Keyboard };
