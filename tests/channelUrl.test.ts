import { describe, it, expect, beforeAll, vi } from "vitest";
import type { Channel } from "@prisma/client";

/**
 * DARVOZA TUGMASI QAYSI HAVOLANI BERADI.
 *
 * Tartib mahsulot qarori: egasi o'z havolasini ulasa u ENG USTUN bo'ladi —
 * bot yaratgan tracking havolalari tashqaridan bekor qilinib turgani uchun
 * (14.08.2026 da beshtala kanalda) egaga to'liq nazorat kerak bo'ldi.
 */

// `subscription.ts` prisma va bot'ni import qiladi — sof funksiyani sinash
// uchun ularni mock qilamiz.
vi.mock("../src/prisma.js", () => ({ prisma: {} }));
vi.mock("../src/bot.js", () => ({ bot: { api: {} } }));

process.env.BOT_TOKEN = "test:token";
process.env.ADMIN_IDS = "1";

let channelUrl: (ch: Channel) => string | null;

beforeAll(async () => {
  ({ channelUrl } = await import("../src/utils/subscription.js"));
});

function chan(over: Partial<Channel> = {}): Channel {
  return {
    id: 1,
    chatId: -100n,
    title: "Kanal",
    username: null,
    inviteLink: null,
    botInviteLink: null,
    adminInviteLink: null,
    buttonLabel: null,
    type: "PUBLIC",
    isActive: true,
    sortOrder: 0,
    createdAt: new Date(),
    ...over,
  } as Channel;
}

describe("channelUrl — ustunlik tartibi", () => {
  it("admin havolasi HAMMASIDAN ustun", () => {
    const url = channelUrl(
      chan({
        adminInviteLink: "https://t.me/+admin",
        botInviteLink: "https://t.me/+bot",
        username: "kanal",
        inviteLink: "https://t.me/+zaxira",
      })
    );
    expect(url).toBe("https://t.me/+admin");
  });

  it("admin havolasi yo'q — bot tracking havolasi", () => {
    const url = channelUrl(chan({ botInviteLink: "https://t.me/+bot", username: "kanal" }));
    expect(url).toBe("https://t.me/+bot");
  });

  it("havolalar yo'q — @username", () => {
    expect(channelUrl(chan({ username: "kanal" }))).toBe("https://t.me/kanal");
  });

  it("username oldidagi @ tushiriladi", () => {
    expect(channelUrl(chan({ username: "@kanal" }))).toBe("https://t.me/kanal");
  });

  it("faqat zaxira havola qolsa — o'sha", () => {
    expect(channelUrl(chan({ inviteLink: "https://t.me/+zaxira" }))).toBe("https://t.me/+zaxira");
  });

  it("hech narsa yo'q — null", () => {
    expect(channelUrl(chan())).toBeNull();
  });

  it("INSTAGRAM — admin havolasi bo'lsa ham profil URL'i qaytadi", () => {
    // Instagram uchun `inviteLink` profil manzili; boshqa maydonlar ma'nosiz.
    const url = channelUrl(
      chan({
        type: "INSTAGRAM",
        inviteLink: "https://instagram.com/user",
        adminInviteLink: "https://t.me/+admin",
      })
    );
    expect(url).toBe("https://instagram.com/user");
  });
});
