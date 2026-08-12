import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Soxta atributsiya regressioni: `pendingSubChannels` doimiy DB sessiyada yashaydi.
 * Foydalanuvchi darvozani ko'rib, keyin ORGANIK qo'shilsa ham eskirgan ro'yxat
 * 30 daqiqadan keyin soxta "bot" yozuvini yaratardi → son sun'iy o'sardi.
 *
 * `pendingSubAt` shtampi: atributsiya faqat darvoza oxirgi 30 daqiqada
 * ko'rsatilgan bo'lsa ishlaydi; ro'yxat har holda tozalanadi.
 */

const recordChannelJoin = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("../src/prisma.js", () => ({ prisma: {} }));
vi.mock("../src/utils/channelEvents.js", () => ({
  ATTRIB_WINDOW_MS: 30 * 60 * 1000,
  recordChannelJoin,
}));

import { attributePendingSubscriptions } from "../src/utils/subscription.js";
import type { MyContext } from "../src/types.js";

const T0 = new Date("2026-08-12T10:00:00.000Z");

function ctxWith(scratch: Record<string, unknown>): MyContext {
  return { from: { id: 1 }, session: { scratch } } as unknown as MyContext;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  vi.clearAllMocks();
});

describe("attributePendingSubscriptions", () => {
  it("yangi darvoza (30 daqiqa ichida) — barcha kanallarni bot deb belgilaydi, ro'yxatni tozalaydi", async () => {
    const ctx = ctxWith({ pendingSubChannels: ["123", "456"], pendingSubAt: Date.now() });

    await attributePendingSubscriptions(ctx, 999);

    expect(recordChannelJoin).toHaveBeenCalledTimes(2);
    expect(recordChannelJoin).toHaveBeenCalledWith(123n, 999, "bot");
    expect(recordChannelJoin).toHaveBeenCalledWith(456n, 999, "bot");
    expect(ctx.session.scratch?.pendingSubChannels).toBeUndefined();
    expect(ctx.session.scratch?.pendingSubAt).toBeUndefined();
  });

  it("eskirgan darvoza (30 daqiqadan keyin) — soxta atributsiya qilmaydi", async () => {
    const ctx = ctxWith({
      pendingSubChannels: ["123"],
      pendingSubAt: Date.now() - 31 * 60 * 1000,
    });

    await attributePendingSubscriptions(ctx, 999);

    expect(recordChannelJoin).not.toHaveBeenCalled();
    // Eskirgan ro'yxat keyingi chaqiruvlarda ham soxta yozuv yaratmasligi uchun tozalanadi.
    expect(ctx.session.scratch?.pendingSubChannels).toBeUndefined();
    expect(ctx.session.scratch?.pendingSubAt).toBeUndefined();
  });

  it("ro'yxat bo'lmasa — hech narsa qilmaydi", async () => {
    await attributePendingSubscriptions(ctxWith({}), 999);
    expect(recordChannelJoin).not.toHaveBeenCalled();
  });

  it("atributsiyadan keyingi takroriy chaqiruv hech narsa qilmaydi (ro'yxat tozalangan)", async () => {
    const ctx = ctxWith({ pendingSubChannels: ["123"], pendingSubAt: Date.now() });

    await attributePendingSubscriptions(ctx, 999);
    await attributePendingSubscriptions(ctx, 999);

    expect(recordChannelJoin).toHaveBeenCalledTimes(1);
  });
});