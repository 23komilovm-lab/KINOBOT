import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Channel } from "@prisma/client";

/**
 * KANAL SOG'LIGI — jim nosozliklarni aniqlash.
 *
 * Tekshiruvning o'zi Telegram API'ga yozadi (`editChatInviteLink` tiriklik
 * probasi), shuning uchun api mock qilinadi. Eng muhim regressiya —
 * `creates_join_request` ni uzatish: uni tushirib qoldirish so'rovli kanal
 * havolasini "tasdiqlashsiz" ga aylantiradi.
 */

const channelUpdate = vi.hoisted(() => vi.fn());
const getSetting = vi.hoisted(() => vi.fn());
const setSetting = vi.hoisted(() => vi.fn());
const notifyOwner = vi.hoisted(() => vi.fn());
const findMany = vi.hoisted(() => vi.fn());

vi.mock("../src/prisma.js", () => ({
  prisma: { channel: { update: channelUpdate, findMany } },
}));
vi.mock("../src/utils/settings.js", () => ({ getSetting, setSetting }));
vi.mock("../src/utils/logger.js", () => ({
  log: vi.fn(),
  formatError: (e: unknown) => String(e),
  notifyOwner,
}));

import {
  checkChannelHealth,
  runHealthSweep,
  getCachedHealth,
  PROBLEM_LABEL,
} from "../src/services/channelHealth.js";

const BOT_ID = 777;

function chan(over: Partial<Channel> = {}): Channel {
  return {
    id: 1,
    chatId: -100123n,
    title: "Test kanal",
    username: "test",
    inviteLink: null,
    botInviteLink: "https://t.me/+tracking",
    buttonLabel: null,
    type: "PUBLIC",
    isActive: true,
    sortOrder: 0,
    createdAt: new Date(),
    ...over,
  } as Channel;
}

/** Sog'lom kanal uchun standart api javoblari */
function api(over: Record<string, unknown> = {}) {
  return {
    getChat: vi.fn().mockResolvedValue({ id: -100123 }),
    getChatMember: vi.fn().mockResolvedValue({ status: "administrator", can_invite_users: true }),
    editChatInviteLink: vi.fn().mockResolvedValue({ invite_link: "https://t.me/+tracking" }),
    createChatInviteLink: vi.fn().mockResolvedValue({ invite_link: "https://t.me/+yangi" }),
    ...over,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  getSetting.mockResolvedValue("");
});

describe("checkChannelHealth", () => {
  it("hammasi joyida — muammo yo'q", async () => {
    const h = await checkChannelHealth(api(), chan(), BOT_ID, { retryDelayMs: 0 });
    expect(h.problems).toEqual([]);
    expect(h.disabled).toBe(false);
  });

  it("REGRESSIYA: tiriklik probasi `creates_join_request` ni uzatadi", async () => {
    // Telegram ko'rsatilmagan ixtiyoriy maydonlarni standart qiymatga qaytaradi.
    // So'rovli kanalda buni tushirib qoldirish havolani tasdiqlashsiz qilib
    // qo'yadi va odamlar navbatsiz kirib ketadi.
    const a = api();
    await checkChannelHealth(a, chan({ type: "REQUEST" }), BOT_ID, { retryDelayMs: 0 });
    expect(a.editChatInviteLink).toHaveBeenCalledWith(-100123, "https://t.me/+tracking", {
      name: "bot_tracking",
      creates_join_request: true,
    });

    const a2 = api();
    await checkChannelHealth(a2, chan({ type: "PUBLIC" }), BOT_ID, { retryDelayMs: 0 });
    expect(a2.editChatInviteLink.mock.calls[0][2]).toMatchObject({ creates_join_request: false });
  });

  it("kanalga kirib bo'lmasa — no_access, keyingi tekshiruvlar bajarilmaydi", async () => {
    const a = api({ getChat: vi.fn().mockRejectedValue(new Error("chat not found")) });
    const h = await checkChannelHealth(a, chan(), BOT_ID, { retryDelayMs: 0 });
    expect(h.problems).toEqual(["no_access"]);
    expect(a.getChatMember).not.toHaveBeenCalled();
    expect(a.editChatInviteLink).not.toHaveBeenCalled();
  });

  it("bot admin bo'lmasa — not_admin, havola tekshirilmaydi", async () => {
    // Muhim: admin bo'lmagan bot havolani tahrirlay ham olmaydi, ya'ni
    // tekshirsak "havola o'lik" degan YOLG'ON xulosa chiqardi.
    const a = api({ getChatMember: vi.fn().mockResolvedValue({ status: "member" }) });
    const h = await checkChannelHealth(a, chan(), BOT_ID, { retryDelayMs: 0 });
    expect(h.problems).toEqual(["not_admin"]);
    expect(a.editChatInviteLink).not.toHaveBeenCalled();
  });

  it("getChatMember yiqilsa ham not_admin", async () => {
    const a = api({ getChatMember: vi.fn().mockRejectedValue(new Error("forbidden")) });
    const h = await checkChannelHealth(a, chan(), BOT_ID, { retryDelayMs: 0 });
    expect(h.problems).toEqual(["not_admin"]);
  });

  it("taklif huquqi yo'q bo'lsa — no_invite_right", async () => {
    const a = api({
      getChatMember: vi
        .fn()
        .mockResolvedValue({ status: "administrator", can_invite_users: false }),
    });
    const h = await checkChannelHealth(a, chan(), BOT_ID, { retryDelayMs: 0 });
    expect(h.problems).toEqual(["no_invite_right"]);
    expect(a.editChatInviteLink).not.toHaveBeenCalled();
  });

  it("creator statusi — huquq maydonisiz ham to'liq ruxsat", async () => {
    const a = api({ getChatMember: vi.fn().mockResolvedValue({ status: "creator" }) });
    const h = await checkChannelHealth(a, chan(), BOT_ID, { retryDelayMs: 0 });
    expect(h.problems).toEqual([]);
  });

  it("o'lik havola aniqlanadi, lekin `act` siz hech narsa o'zgartirilmaydi", async () => {
    const a = api({ editChatInviteLink: vi.fn().mockRejectedValue(new Error("revoked")) });
    const h = await checkChannelHealth(a, chan(), BOT_ID, { retryDelayMs: 0 });
    expect(h.problems).toEqual(["link_dead"]);
    expect(h.disabled).toBe(false);
    // Bot kanalga HECH NARSA YOZMAYDI — yangi havola yaratmaydi
    expect(a.createChatInviteLink).not.toHaveBeenCalled();
    expect(channelUpdate).not.toHaveBeenCalled();
  });

  it("darvozani buzadigan muammo — majburiy obuna o'chiriladi, kanalga yozilmaydi", async () => {
    const a = api({ editChatInviteLink: vi.fn().mockRejectedValue(new Error("revoked")) });
    const h = await checkChannelHealth(a, chan(), BOT_ID, { act: true, retryDelayMs: 0 });

    expect(h.problems).toEqual(["link_dead"]);
    expect(h.disabled).toBe(true);
    expect(channelUpdate).toHaveBeenCalledWith({ where: { id: 1 }, data: { isActive: false } });
    // "Biz o'chirdik" belgisi — keyin faqat shuni qayta yoqamiz
    expect(setSetting).toHaveBeenCalledWith("chhealth:off:-100123", "1");
    // Telegram'da hech narsa o'zgartirilmadi
    expect(a.createChatInviteLink).not.toHaveBeenCalled();
  });

  it("bot admin emas — bu ham darvozani buzadi, o'chiriladi", async () => {
    const a = api({ getChatMember: vi.fn().mockResolvedValue({ status: "member" }) });
    const h = await checkChannelHealth(a, chan(), BOT_ID, { act: true, retryDelayMs: 0 });
    expect(h.disabled).toBe(true);
  });

  it("taklif huquqi yo'qligi darvozani BUZMAYDI — o'chirilmaydi", async () => {
    // Bot havola yarata olmasa ham a'zolikni tekshira oladi; mavjud havola
    // bilan darvoza ishlayveradi. Bunday kanalni o'chirish zarar keltirardi.
    const a = api({
      getChatMember: vi
        .fn()
        .mockResolvedValue({ status: "administrator", can_invite_users: false }),
    });
    const h = await checkChannelHealth(a, chan(), BOT_ID, { act: true, retryDelayMs: 0 });
    expect(h.problems).toEqual(["no_invite_right"]);
    expect(h.disabled).toBe(false);
    expect(channelUpdate).not.toHaveBeenCalled();
  });

  it("allaqachon o'chirilgan kanal qayta o'chirilmaydi", async () => {
    const a = api({ getChatMember: vi.fn().mockResolvedValue({ status: "member" }) });
    const h = await checkChannelHealth(a, chan({ isActive: false }), BOT_ID, {
      act: true,
      retryDelayMs: 0,
    });
    expect(h.disabled).toBe(false);
    expect(channelUpdate).not.toHaveBeenCalled();
  });

  it("muammo tuzalsa — BIZ o'chirgan bo'lsak qayta yoqiladi", async () => {
    getSetting.mockResolvedValue("1"); // chhealth:off = biz o'chirganmiz
    const h = await checkChannelHealth(api(), chan({ isActive: false }), BOT_ID, {
      act: true,
      retryDelayMs: 0,
    });
    expect(h.reEnabled).toBe(true);
    expect(channelUpdate).toHaveBeenCalledWith({ where: { id: 1 }, data: { isActive: true } });
    expect(setSetting).toHaveBeenCalledWith("chhealth:off:-100123", "");
  });

  it("EGASI qo'lda o'chirgan kanal qayta YOQILMAYDI", async () => {
    // Belgi yo'q = o'chirish bizning ishimiz emas. Uni tiklash egasining
    // qaroriga zid bo'lardi.
    getSetting.mockResolvedValue("");
    const h = await checkChannelHealth(api(), chan({ isActive: false }), BOT_ID, {
      act: true,
      retryDelayMs: 0,
    });
    expect(h.reEnabled).toBe(false);
    expect(channelUpdate).not.toHaveBeenCalled();
  });

  it("O'TKINCHI tarmoq xatosi kanalni o'chirmaydi — qayta urinish qutqaradi", async () => {
    // Prodda getUpdates da 502/ECONNRESET uchraydi. Bir martalik xato tufayli
    // kanalni darvozadan chiqarish mijozlarni bekorga yo'qotish demakdir.
    const getChat = vi
      .fn()
      .mockRejectedValueOnce(new Error("502 Bad Gateway"))
      .mockResolvedValue({ id: -100123 });
    const h = await checkChannelHealth(api({ getChat }), chan(), BOT_ID, {
      act: true,
      retryDelayMs: 0,
    });
    expect(getChat).toHaveBeenCalledTimes(2);
    expect(h.problems).toEqual([]);
    expect(h.disabled).toBe(false);
  });

  it("tracking havolasi yo'q kanal — havola tekshiruvi o'tkazib yuboriladi", async () => {
    const a = api();
    const h = await checkChannelHealth(a, chan({ botInviteLink: null }), BOT_ID, {
      retryDelayMs: 0,
    });
    expect(h.problems).toEqual([]);
    expect(a.editChatInviteLink).not.toHaveBeenCalled();
  });

  it("INSTAGRAM — Telegram API umuman chaqirilmaydi (sintetik chatId)", async () => {
    const a = api();
    const h = await checkChannelHealth(a, chan({ type: "INSTAGRAM" }), BOT_ID, { retryDelayMs: 0 });
    expect(h.problems).toEqual([]);
    expect(a.getChat).not.toHaveBeenCalled();
  });

  it("natija keshga yoziladi — panel qayta tekshirmasdan ko'rsatadi", async () => {
    const a = api({ getChatMember: vi.fn().mockResolvedValue({ status: "left" }) });
    await checkChannelHealth(a, chan({ chatId: -100999n }), BOT_ID, { retryDelayMs: 0 });
    expect(getCachedHealth(-100999n)?.problems).toEqual(["not_admin"]);
  });
});

describe("runHealthSweep", () => {
  it("holat o'zgarganda egaga xabar beradi va yangi holatni saqlaydi", async () => {
    findMany.mockResolvedValue([chan({ title: "Guruh" })]);
    getSetting.mockResolvedValue(""); // ilgari muammo yo'q edi
    const a = api({ getChatMember: vi.fn().mockResolvedValue({ status: "member" }) });

    await runHealthSweep(a, BOT_ID, { retryDelayMs: 0 });

    expect(setSetting).toHaveBeenCalledWith("chhealth:-100123", "not_admin");
    const msg = notifyOwner.mock.calls[0][0] as string;
    expect(msg).toContain("Guruh");
    expect(msg).toContain(PROBLEM_LABEL.not_admin);
  });

  it("holat O'ZGARMASA takroriy xabar yubormaydi", async () => {
    // Redeploy tez-tez bo'ladi — holat DB'da saqlanadi, xotirada emas.
    findMany.mockResolvedValue([chan()]);
    getSetting.mockResolvedValue("not_admin");
    const a = api({ getChatMember: vi.fn().mockResolvedValue({ status: "member" }) });

    await runHealthSweep(a, BOT_ID, { retryDelayMs: 0 });

    expect(notifyOwner).not.toHaveBeenCalled();
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("muammo yo'qolsa — tiklandi deb xabar beradi", async () => {
    findMany.mockResolvedValue([chan({ title: "Kino" })]);
    getSetting.mockResolvedValue("not_admin");

    await runHealthSweep(api(), BOT_ID, { retryDelayMs: 0 });

    expect(setSetting).toHaveBeenCalledWith("chhealth:-100123", "");
    expect(notifyOwner.mock.calls[0][0]).toContain("tiklandi");
  });

  it("bir nechta muammo bitta xabarga yig'iladi", async () => {
    findMany.mockResolvedValue([
      chan({ id: 1, chatId: -1n, title: "A" }),
      chan({ id: 2, chatId: -2n, title: "B" }),
    ]);
    const a = api({ getChat: vi.fn().mockRejectedValue(new Error("gone")) });

    await runHealthSweep(a, BOT_ID, { retryDelayMs: 0 });

    expect(notifyOwner).toHaveBeenCalledTimes(1);
    const msg = notifyOwner.mock.calls[0][0] as string;
    expect(msg).toContain("A");
    expect(msg).toContain("B");
  });
});
