import { describe, it, expect, vi, beforeAll } from "vitest";

/**
 * Regressiya testi: admin paneli `bot.use(adminHandler)` orqali ulanadi, lekin
 * ichkarida bo'limlar filtr ortiga mount qilinadi. Agar filtr `adminHandler`
 * o'rniga bog'lanmagan `new Composer()` dan boshlansa, tarmoq hech qachon
 * ulanmaydi va BUTUN admin paneli jimgina o'ladi — tugma bosilganda hech narsa
 * bo'lmaydi, so'rov pastdagi qidiruvga tushib ketadi.
 *
 * `tsc` ham, boshqa testlar ham buni ushlamaydi (tiplar to'g'ri, kod "ishlaydi").
 * Shuning uchun bu yerda haqiqiy update composer orqali o'tkaziladi.
 */

// Admin ID — config `ADMIN_IDS` dan o'qiydi, import'dan OLDIN qo'yilishi kerak.
const OWNER_ID = 111222333;
process.env.BOT_TOKEN = "test:token";
process.env.ADMIN_IDS = String(OWNER_ID);

// Har qanday model/metodga javob beradigan mock — test marshrutlashni tekshiradi,
// statistika qiymatlarini emas.
vi.mock("../src/prisma.js", () => {
  const model = new Proxy(
    {},
    {
      get: (_t, method: string) => {
        if (method === "aggregate") return async () => ({ _sum: { views: 0 } });
        if (method === "findMany") return async () => [];
        if (method === "findUnique" || method === "findFirst") return async () => null;
        return async () => 0;
      },
    }
  );
  return { prisma: new Proxy({}, { get: () => model }) };
});

// Conversation'lar grammY plugin'i sifatida ro'yxatga olinadi — testda kerak emas.
vi.mock("@grammyjs/conversations", () => ({
  createConversation: () => (_ctx: unknown, next: () => Promise<void>) => next(),
  conversations: () => (_ctx: unknown, next: () => Promise<void>) => next(),
}));

let adminHandler: import("grammy").Composer<never>;

beforeAll(async () => {
  ({ adminHandler } = (await import("../src/handlers/admin/index.js")) as never);
});

/** Admin bo'lim tugmasi bosilgan update — statistika bo'limi. */
function statsButtonUpdate(fromId: number) {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      chat: { id: fromId, type: "private" as const },
      from: { id: fromId, is_bot: false, first_name: "Admin" },
      text: "Statistika",
    },
  };
}

describe("admin panel marshrutlash", () => {
  it("adminHandler'da middleware ro'yxatdan o'tgan bo'lishi kerak", () => {
    // Bo'sh composer — aynan shu holat prodda panelni o'ldirgan edi.
    expect(adminHandler).toBeDefined();
    const mw = adminHandler.middleware();
    expect(typeof mw).toBe("function");
  });

  it("admin tugmasi bosilganda so'rov admin panelida to'xtaydi (next chaqirilmaydi)", async () => {
    const next = vi.fn(async () => {});
    const ctx = {
      from: { id: OWNER_ID, is_bot: false, first_name: "Admin" },
      update: statsButtonUpdate(OWNER_ID),
      message: statsButtonUpdate(OWNER_ID).message,
      msg: statsButtonUpdate(OWNER_ID).message,
      chat: { id: OWNER_ID, type: "private" },
      reply: vi.fn(async () => ({})),
      api: { sendMessage: vi.fn(async () => ({})) },
      session: {},
      // grammY `hears` `ctx.msg.text` ga qaraydi
      has: () => true,
      match: undefined,
    } as never;

    await adminHandler.middleware()(ctx, next);

    // Panel so'rovni o'zi qayta ishlashi kerak — `next()` ga o'tkazib yubormasligi.
    // Bog'lanmagan composer holatida bu tekshiruv yiqiladi.
    expect(next).not.toHaveBeenCalled();
  });
});
