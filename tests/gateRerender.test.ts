import { describe, it, expect, beforeEach, vi } from "vitest";
import type { MyContext } from "../src/types.js";
import type { Channel } from "@prisma/client";

/**
 * DARVOZANI QAYTA CHIZISH va ATRIBUTSIYA RO'YXATI.
 *
 * "Tekshirish" bosilganda darvoza qayta chiziladi va unga faqat QOLGAN
 * kanallar tushadi. Shu paytda atributsiya ro'yxati QISQARMASLIGI kerak —
 * aks holda allaqachon qo'shilgan kanallar "bot orqali" deb belgilanmasdi.
 */

vi.mock("../src/prisma.js", () => ({ prisma: {} }));
vi.mock("../src/utils/settings.js", () => ({
  getBool: vi.fn().mockResolvedValue(false),
  getSetting: vi.fn().mockResolvedValue(""),
  KEYS: {},
}));
vi.mock("../src/utils/channelEvents.js", () => ({
  ATTRIB_WINDOW_MS: 30 * 60 * 1000,
  recordChannelJoin: vi.fn(),
}));

import { rememberBlockingChannels } from "../src/utils/subscription.js";

function chan(chatId: bigint, type: Channel["type"] = "PUBLIC"): Channel {
  return { chatId, type, id: Number(chatId), title: "K" } as Channel;
}

function ctxWith(scratch: Record<string, unknown> = {}): MyContext {
  return { session: { scratch } } as unknown as MyContext;
}

const A = -1n;
const B = -2n;
const C = -3n;

beforeEach(() => vi.clearAllMocks());

describe("rememberBlockingChannels", () => {
  it("birinchi marta — ro'yxat va vaqt shtampi yoziladi", () => {
    const ctx = ctxWith();
    rememberBlockingChannels(ctx, [chan(A), chan(B)]);
    expect(ctx.session.scratch?.pendingSubChannels).toEqual(["-1", "-2"]);
    expect(typeof ctx.session.scratch?.pendingSubAt).toBe("number");
  });

  it("REGRESSIYA: qayta chizishda ro'yxat QISQARMAYDI — birlashtiriladi", () => {
    // Darvoza [A,B,C] ni ko'rsatdi, foydalanuvchi A va B ga qo'shildi.
    // "Tekshirish" da darvoza faqat [C] bilan qayta chiziladi — lekin A va B
    // atributsiya ro'yxatida QOLISHI kerak, aks holda ular "bot orqali" deb
    // belgilanmasdi.
    const ctx = ctxWith();
    rememberBlockingChannels(ctx, [chan(A), chan(B), chan(C)]);
    rememberBlockingChannels(ctx, [chan(C)]);
    expect(ctx.session.scratch?.pendingSubChannels).toEqual(["-1", "-2", "-3"]);
  });

  it("dublikat qo'shilmaydi", () => {
    const ctx = ctxWith();
    rememberBlockingChannels(ctx, [chan(A), chan(B)]);
    rememberBlockingChannels(ctx, [chan(B), chan(C)]);
    expect(ctx.session.scratch?.pendingSubChannels).toEqual(["-1", "-2", "-3"]);
  });

  it("ESKIRGAN ro'yxat birlashtirilmaydi — almashtiriladi", () => {
    // 30 daqiqadan oshgan darvoza allaqachon atributsiya oynasidan chiqqan.
    // Uni tiriltirish organik qo'shilishni "bot" deb belgilardi.
    const ctx = ctxWith({
      pendingSubChannels: ["-1", "-2"],
      pendingSubAt: Date.now() - 31 * 60 * 1000,
    });
    rememberBlockingChannels(ctx, [chan(C)]);
    expect(ctx.session.scratch?.pendingSubChannels).toEqual(["-3"]);
  });

  it("vaqt shtampi yo'q bo'lsa ham almashtiriladi", () => {
    const ctx = ctxWith({ pendingSubChannels: ["-1"] });
    rememberBlockingChannels(ctx, [chan(C)]);
    expect(ctx.session.scratch?.pendingSubChannels).toEqual(["-3"]);
  });

  it("INSTAGRAM va REQUEST atributsiya ro'yxatiga TUSHMAYDI", () => {
    // Instagram tekshirilmaydi; so'rovli kanalda esa odam hali KIRMAGAN —
    // ikkalasini ham "bot orqali qo'shildi" deb belgilash yolg'on bo'lardi.
    const ctx = ctxWith();
    rememberBlockingChannels(ctx, [chan(A), chan(B, "INSTAGRAM"), chan(C, "REQUEST")]);
    expect(ctx.session.scratch?.pendingSubChannels).toEqual(["-1"]);
  });

  it("faqat Instagram qolsa — mavjud ro'yxat buzilmaydi", () => {
    const ctx = ctxWith();
    rememberBlockingChannels(ctx, [chan(A)]);
    rememberBlockingChannels(ctx, [chan(B, "INSTAGRAM")]);
    expect(ctx.session.scratch?.pendingSubChannels).toEqual(["-1"]);
  });
});
