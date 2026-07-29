import { Bot, session } from "grammy";
import { sequentialize } from "@grammyjs/runner";
import { conversations } from "@grammyjs/conversations";
import { config } from "./config.js";
import { prismaSessionStorage } from "./utils/sessionStorage.js";
import type { MyContext, SessionData } from "./types.js";

export const bot = new Bot<MyContext>(config.botToken);

// @grammyjs/runner update'larni parallel qayta ishlaydi. Sessiya bilan ishlaganda
// bu poyga holatiga olib keladi (bir chatdan tez ketma-ket kelgan ikki xabar bir
// xil sessiyani o'qib, biri ikkinchisining o'zgarishini yo'q qiladi).
// sequentialize — bitta chat ichidagi update'larni navbat bilan bajaradi.
bot.use(sequentialize((ctx) => ctx.chat?.id.toString() ?? ctx.from?.id.toString()));

// Sessiya (conversations uchun shart) — PostgreSQL'da saqlanadi
//
// getSessionKey MUHIM: standart kalit `ctx.chat.id` ga tayanadi, lekin
// inline_query va chosen_inline_result update'larida chat YO'Q. Natijada
// sessiyaga murojaat qilgan har qanday middleware (masalan conversations
// plugini) "session key is undefined" xatosi bilan yiqilardi va inline
// so'rov umuman javobsiz qolardi — referalni do'stlarga ulashish shu
// sababdan ishlamay turgan edi. Shaxsiy chatda chat.id === from.id, ya'ni
// bu fallback mavjud sessiyalarni buzmaydi.
bot.use(
  session({
    initial: (): SessionData => ({}),
    getSessionKey: (ctx) => ctx.chat?.id.toString() ?? ctx.from?.id.toString(),
    storage: prismaSessionStorage<SessionData>(),
  })
);

// Conversations plugin
bot.use(conversations());

// Barcha javoblar uchun standart parse_mode = HTML (custom emoji uchun kerak)
bot.api.config.use((prev, method, payload, signal) => {
  if (
    [
      "sendMessage",
      "editMessageText",
      "sendPhoto",
      "sendVideo",
      "sendDocument",
      "copyMessage",
    ].includes(method) &&
    payload &&
    !("parse_mode" in payload)
  ) {
    // @ts-expect-error — parse_mode'ni standart qo'shamiz
    payload.parse_mode = "HTML";
  }
  return prev(method, payload, signal);
});
