import { describe, it, expect, beforeEach, vi } from "vitest";

// Kvota mantiqini DB/middleware'dan ajratib test qilamiz — barcha tashqi
// bog'liqlik mock'lanadi. Asl maqsad: kunlik+umrlik limit qoidalarini tekshirish.
vi.mock("../src/prisma.js", () => ({
  prisma: { user: { findUnique: vi.fn(), update: vi.fn() } },
}));
vi.mock("../src/config.js", () => ({ isAdmin: vi.fn(() => false) }));
vi.mock("../src/utils/subscription.js", () => ({ ensureSubscribed: vi.fn(async () => true) }));
vi.mock("../src/utils/settings.js", () => ({
  getBool: vi.fn(async () => true),
  getSetting: vi.fn(async () => "0"),
  KEYS: { forceSubEnabled: "force_sub", freeDailyLimit: "free_daily_limit" },
}));
vi.mock("../src/utils/premium.js", () => ({
  isPremiumActive: vi.fn(() => false),
  premiumEnabled: vi.fn(async () => true),
  getFreeLimits: vi.fn(async () => ({ requests: 3, days: 0 })),
}));
vi.mock("../src/handlers/premiumUser.js", () => ({ sendPremiumPrompt: vi.fn(async () => {}) }));
vi.mock("../src/utils/dateRange.js", () => ({ todayUz: vi.fn(() => "2026-08-07") }));
vi.mock("../src/utils/logger.js", () => ({ log: vi.fn() }));

import { getSetting } from "../src/utils/settings.js";
import { isPremiumActive, premiumEnabled, getFreeLimits } from "../src/utils/premium.js";
import { isFreeQuotaExhausted, checkContentAccessResult } from "../src/utils/access.js";
import { prisma } from "../src/prisma.js";
import type { MyContext } from "../src/types.js";

type QuotaUser = {
  premiumUntil: Date | null;
  requestCount: number;
  firstRequestAt: Date | null;
  contentRequestDay: string | null;
  contentRequestCount: number;
};

function user(over: Partial<QuotaUser>): QuotaUser {
  return {
    premiumUntil: null,
    requestCount: 0,
    firstRequestAt: new Date("2026-08-01T00:00:00Z"),
    contentRequestDay: null,
    contentRequestCount: 0,
    ...over,
  };
}

function ctxFor(id = 42): MyContext {
  return { from: { id } } as unknown as MyContext;
}

const TODAY = "2026-08-07";
const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isPremiumActive).mockReturnValue(false);
  vi.mocked(premiumEnabled).mockResolvedValue(true);
  vi.mocked(getFreeLimits).mockResolvedValue({ requests: 3, days: 0 });
  vi.mocked(getSetting).mockResolvedValue("0"); // kunlik limit o'chiq — har test o'zi sozlaydi
  // hisob oshirish ichida `.catch()` zanjirlanadi — promise qaytishi shart
  vi.mocked(prisma.user.update).mockResolvedValue({} as never);
});

describe("isFreeQuotaExhausted — kunlik qatlam (Toshkent kuni)", () => {
  it("bugungi kun limitiga yetgan → tugagan", async () => {
    vi.mocked(getSetting).mockResolvedValue("5");
    const u = user({ contentRequestDay: TODAY, contentRequestCount: 5 });
    await expect(isFreeQuotaExhausted(u)).resolves.toBe(true);
  });

  it("bugungi kun limitiga yetmagan → tugamagan", async () => {
    vi.mocked(getSetting).mockResolvedValue("5");
    const u = user({ contentRequestDay: TODAY, contentRequestCount: 4 });
    await expect(isFreeQuotaExhausted(u)).resolves.toBe(false);
  });

  it("o'tgan kungi hisob yangi kunda avtomatik reset (eski day → limit hisoblanmaydi)", async () => {
    vi.mocked(getSetting).mockResolvedValue("5");
    const u = user({ contentRequestDay: "2026-08-06", contentRequestCount: 999 });
    await expect(isFreeQuotaExhausted(u)).resolves.toBe(false);
  });

  it("limit o'chirilgan bo'lsa kunlik qatlam ishlamaydi", async () => {
    vi.mocked(getSetting).mockResolvedValue("0");
    const u = user({ contentRequestDay: TODAY, contentRequestCount: 999 });
    await expect(isFreeQuotaExhausted(u)).resolves.toBe(false);
  });
});

describe("isFreeQuotaExhausted — umrlik qatlam", () => {
  it("premium faol → tugamagan (hatto limit oshib ketgan bo'lsa ham)", async () => {
    vi.mocked(isPremiumActive).mockReturnValue(true);
    const u = user({ requestCount: 999, contentRequestDay: TODAY, contentRequestCount: 999 });
    await expect(isFreeQuotaExhausted(u)).resolves.toBe(false);
  });

  it("bepul so'rovlar soni limitga yetgan → tugagan", async () => {
    const u = user({ requestCount: 3 }); // freeReq = 3
    await expect(isFreeQuotaExhausted(u)).resolves.toBe(true);
  });

  it("freeDays oynasi o'tgan → tugagan", async () => {
    vi.mocked(getFreeLimits).mockResolvedValue({ requests: 0, days: 1 });
    const u = user({ firstRequestAt: daysAgo(10) });
    await expect(isFreeQuotaExhausted(u)).resolves.toBe(true);
  });

  it("premium tizimi o'chirilgan → cheklov yo'q", async () => {
    vi.mocked(premiumEnabled).mockResolvedValue(false);
    const u = user({ requestCount: 999 });
    await expect(isFreeQuotaExhausted(u)).resolves.toBe(false);
  });
});

describe("checkContentAccessResult — bloklash sababi", () => {
  it("kunlik limit tugaganda reason='quota' qaytadi", async () => {
    vi.mocked(getSetting).mockResolvedValue("5");
    // user.findUnique — DB'dan yuklanadigan user
    vi.mocked(prisma.user.findUnique).mockResolvedValue(
      user({ contentRequestDay: TODAY, contentRequestCount: 5 }) as never
    );
    const res = await checkContentAccessResult(ctxFor(), true);
    expect(res).toEqual({ ok: false, reason: "quota" });
  });

  it("limit ichida → reason='ok' va hisob oshiriladi", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(user({ requestCount: 0 }) as never);
    const res = await checkContentAccessResult(ctxFor(), true);
    expect(res).toEqual({ ok: true, reason: "ok" });
    expect(prisma.user.update).toHaveBeenCalled();
  });

  it("count=false bo'lsa hisob oshirilmaydi", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(user({}) as never);
    await checkContentAccessResult(ctxFor(), false);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});
