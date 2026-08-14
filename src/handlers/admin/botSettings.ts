import { Composer } from "grammy";
import { isOwner, adminCan } from "../../config.js";
import {
  ADMIN_MENU_BUTTONS,
  BOT_SETTINGS_TEXT,
  adminMenuKeyboard,
  botSettingsKeyboard,
  BE,
} from "../../utils/keyboard.js";
import type { MyContext } from "../../types.js";

export const botSettingsHandler = new Composer<MyContext>();

const HEAD = `<tg-emoji emoji-id="${BE.botSettings}">⚙️</tg-emoji> <b>Bot sozlamalari</b>\n\nKerakli bo'limni tanlang:`;

function canAny(uid: number): boolean {
  return (
    isOwner(uid) ||
    adminCan(uid, "premium") ||
    adminCan(uid, "ai") ||
    adminCan(uid, "backup") ||
    adminCan(uid, "funnel")
  );
}

botSettingsHandler.hears(ADMIN_MENU_BUTTONS.botSettings, async (ctx) => {
  const uid = ctx.from!.id;
  if (!canAny(uid)) return;
  await ctx.reply(HEAD, { reply_markup: botSettingsKeyboard(uid) });
});

// Eski yozuv ham qabul qilinadi: deploy paytida ekranda turgan klaviatura
// hamon "Menyuga qaytish" bo'lishi mumkin va u bosilganda hech narsa
// bo'lmasligi kerak emas. Yangi klaviatura keyingi ochilishda keladi.
botSettingsHandler.hears([BOT_SETTINGS_TEXT.back, "Menyuga qaytish"], async (ctx) => {
  const uid = ctx.from!.id;
  if (!canAny(uid)) return;
  await ctx.reply("Admin panel:", { reply_markup: adminMenuKeyboard(uid) });
});

// Sub-panellardagi "Orqaga" — inline xabarni yopadi, "Bot sozlamalari" reply
// klaviaturasi allaqachon ko'rinib turadi (qayta yubormaymiz).
botSettingsHandler.callbackQuery("botset:back", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.deleteMessage().catch(() => {});
});
