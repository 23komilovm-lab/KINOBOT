import { describe, it, expect } from "vitest";
import { resolveJoinSource } from "../src/utils/joinSource.js";

const BOT_ID = 777;
const WINDOW = 30 * 60 * 1000;
const NOW = new Date("2026-08-12T10:00:00Z").getTime();

function input(over: Partial<Parameters<typeof resolveJoinSource>[0]> = {}) {
  return {
    botId: BOT_ID,
    storedBotLink: "https://t.me/+botlink",
    chatId: "-1001",
    windowMs: WINDOW,
    now: NOW,
    ...over,
  };
}

describe("resolveJoinSource — havola orqali", () => {
  it("bot yaratgan havola (creator = bot) → bot", () => {
    const src = resolveJoinSource(
      input({ inviteLink: { invite_link: "https://t.me/+botlink", creator: { id: BOT_ID } } })
    );
    expect(src).toBe("bot");
  });

  it("botning ESKI havolasi — DB'da boshqasi saqlangan bo'lsa ham → bot", () => {
    // Kanal o'chirilib qayta qo'shilganda yangi havola yaratiladi, eskisi tirik
    // qoladi. Satr mos kelmaydi, lekin creator bot — demak sanaladi.
    const src = resolveJoinSource(
      input({
        inviteLink: { invite_link: "https://t.me/+eskihavola", creator: { id: BOT_ID } },
        storedBotLink: "https://t.me/+yangihavola",
      })
    );
    expect(src).toBe("bot");
  });

  it("boshqa admin yaratgan (niqoblangan) havola → link", () => {
    // Telegram boshqa admin havolasining ikkinchi qismini "…" bilan almashtiradi,
    // shuning uchun satr solishtiruvi hech qachon mos kelmaydi.
    const src = resolveJoinSource(
      input({ inviteLink: { invite_link: "https://t.me/+abc…", creator: { id: 12345 } } })
    );
    expect(src).toBe("link");
  });

  it("creator yo'q, lekin satr DB'dagi havola bilan bir xil → bot (zaxira yo'l)", () => {
    const src = resolveJoinSource(
      input({ inviteLink: { invite_link: "https://t.me/+botlink" } })
    );
    expect(src).toBe("bot");
  });

  it("havola bor bo'lsa darvoza sessiyasi TEKSHIRILMAYDI (havola aniqroq)", () => {
    const src = resolveJoinSource(
      input({
        inviteLink: { invite_link: "https://t.me/+notours", creator: { id: 12345 } },
        gate: { channels: ["-1001"], at: NOW - 1000 },
      })
    );
    expect(src).toBe("link");
  });
});

describe("resolveJoinSource — havolasiz yo'llar", () => {
  it("so'rov orqali → request", () => {
    expect(resolveJoinSource(input({ viaJoinRequest: true }))).toBe("request");
  });

  it("papka havolasi → folder", () => {
    expect(resolveJoinSource(input({ viaChatFolderInviteLink: true }))).toBe("folder");
  });

  it("hech qanday belgi yo'q → direct", () => {
    expect(resolveJoinSource(input())).toBe("direct");
  });
});

describe("resolveJoinSource — darvoza sessiyasi (ochiq kanal, @username orqali)", () => {
  it("yangi darvoza + shu kanal ro'yxatda → bot", () => {
    const src = resolveJoinSource(input({ gate: { channels: ["-1001"], at: NOW - 60_000 } }));
    expect(src).toBe("bot");
  });

  it("eskirgan darvoza (30 daqiqadan oshgan) → direct", () => {
    const src = resolveJoinSource(input({ gate: { channels: ["-1001"], at: NOW - WINDOW - 1 } }));
    expect(src).toBe("direct");
  });

  it("oyna chegarasida (aynan 30 daqiqa) → bot", () => {
    const src = resolveJoinSource(input({ gate: { channels: ["-1001"], at: NOW - WINDOW } }));
    expect(src).toBe("bot");
  });

  it("vaqt shtampi yo'q (deploy'dan oldingi sessiya) → direct", () => {
    const src = resolveJoinSource(input({ gate: { channels: ["-1001"] } }));
    expect(src).toBe("direct");
  });

  it("darvozada boshqa kanal → direct", () => {
    const src = resolveJoinSource(input({ gate: { channels: ["-1009"], at: NOW - 1000 } }));
    expect(src).toBe("direct");
  });
});
