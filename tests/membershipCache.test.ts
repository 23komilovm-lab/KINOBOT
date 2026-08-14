import { describe, it, expect, beforeEach, vi } from "vitest";
import type { MyContext } from "../src/types.js";

/**
 * A'ZOLIK KESHI va uni bekor qilish.
 *
 * REGRESSIYA: musbat natija 10 daqiqa keshlanadi. `chat_member` yangilanishida
 * kesh tozalanmasa, kanaldan chiqib ketgan odam o'sha vaqt davomida darvozadan
 * bemalol o'tib ketardi (14.08.2026 da prodda aniqlandi).
 */

const findMany = vi.hoisted(() => vi.fn());
const findUnique = vi.hoisted(() => vi.fn());

vi.mock("../src/prisma.js", () => ({
  prisma: { channel: { findMany }, joinRequest: { findUnique } },
}));
vi.mock("../src/utils/settings.js", () => ({
  getBool: vi.fn().mockResolvedValue(false),
  getSetting: vi.fn().mockResolvedValue(""),
  KEYS: { forceSubEnabled: "force_sub_enabled" },
}));
vi.mock("../src/utils/channelEvents.js", () => ({
  ATTRIB_WINDOW_MS: 0,
  recordChannelJoin: vi.fn(),
}));

import { getUnsubscribedChannels, invalidateMembership } from "../src/utils/subscription.js";

const CHAT = -100123n;
const USER = 555;

const getChatMember = vi.fn();

function ctx(): MyContext {
  return {
    api: {
      getChatMember,
      // maybeSyncChannel ichida chaqiriladi — kanal o'zgarmagan deb qaytaramiz
      getChat: vi.fn().mockResolvedValue({ id: Number(CHAT), username: "kanal", title: "Kanal" }),
    },
  } as unknown as MyContext;
}

const channel = {
  id: 1,
  chatId: CHAT,
  title: "Kanal",
  username: "kanal",
  type: "PUBLIC",
  isActive: true,
  sortOrder: 0,
  inviteLink: null,
  botInviteLink: null,
  adminInviteLink: null,
  buttonLabel: null,
  createdAt: new Date(),
};

beforeEach(() => {
  vi.clearAllMocks();
  findMany.mockResolvedValue([channel]);
  // Har testda toza kesh — modul holati testlar orasida saqlanadi
  invalidateMembership(CHAT, USER);
});

describe("a'zolik keshi", () => {
  it("ikkinchi so'rovda Telegram QAYTA so'ralmaydi (kesh ishlaydi)", async () => {
    getChatMember.mockResolvedValue({ status: "member" });
    await getUnsubscribedChannels(ctx(), USER);
    await getUnsubscribedChannels(ctx(), USER);
    expect(getChatMember).toHaveBeenCalledTimes(1);
  });

  it("REGRESSIYA: kesh bekor qilingach chiqib ketish DARHOL seziladi", async () => {
    // 1) A'zo — keshga musbat yoziladi
    getChatMember.mockResolvedValue({ status: "member" });
    expect(await getUnsubscribedChannels(ctx(), USER)).toHaveLength(0);

    // 2) Odam kanaldan chiqdi. Kesh tozalanmasa — 10 daqiqa "a'zo" bo'lib
    //    qolardi va darvoza uni o'tkazib yuborardi.
    getChatMember.mockResolvedValue({ status: "left" });
    expect(await getUnsubscribedChannels(ctx(), USER)).toHaveLength(0); // hali kesh

    // 3) `chat_member` keshni bekor qiladi
    invalidateMembership(CHAT, USER);
    const blocked = await getUnsubscribedChannels(ctx(), USER);
    expect(blocked).toHaveLength(1);
    expect(blocked[0].chatId).toBe(CHAT);
  });

  it("bekor qilish FAQAT o'sha foydalanuvchiga tegishli", async () => {
    getChatMember.mockResolvedValue({ status: "member" });
    await getUnsubscribedChannels(ctx(), USER);
    await getUnsubscribedChannels(ctx(), 999);
    expect(getChatMember).toHaveBeenCalledTimes(2);

    invalidateMembership(CHAT, USER);
    getChatMember.mockClear();

    await getUnsubscribedChannels(ctx(), 999); // keshda — so'ralmaydi
    expect(getChatMember).not.toHaveBeenCalled();

    await getUnsubscribedChannels(ctx(), USER); // bekor qilingan — so'raladi
    expect(getChatMember).toHaveBeenCalledTimes(1);
  });

  it("number va bigint chatId bir xil kalitni beradi", async () => {
    // `chat_member` da chatId — number, kesh kaliti esa bigint'dan yasalgan.
    // Satrga aylantirilganda ikkalasi bir xil bo'lishi SHART, aks holda
    // bekor qilish ishlamaydi.
    getChatMember.mockResolvedValue({ status: "member" });
    await getUnsubscribedChannels(ctx(), USER);

    invalidateMembership(Number(CHAT), USER); // number bilan
    getChatMember.mockClear();
    getChatMember.mockResolvedValue({ status: "left" });

    expect(await getUnsubscribedChannels(ctx(), USER)).toHaveLength(1);
    expect(getChatMember).toHaveBeenCalled();
  });

  it("`bypassCache` keshni chetlab o'tadi (Tekshirish tugmasi)", async () => {
    getChatMember.mockResolvedValue({ status: "member" });
    await getUnsubscribedChannels(ctx(), USER);
    getChatMember.mockResolvedValue({ status: "left" });

    const blocked = await getUnsubscribedChannels(ctx(), USER, { bypassCache: true });
    expect(blocked).toHaveLength(1);
  });
});
