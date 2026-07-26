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
bot.use(
  session({
    initial: (): SessionData => ({}),
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
