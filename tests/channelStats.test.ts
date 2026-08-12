import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";
import type { Channel } from "@prisma/client";
import type { ChannelStatsData } from "../src/handlers/admin/channels.js";

// channelStats modullari $queryRaw orqali ishlaydi — javobni testda beramiz.
const queryRaw = vi.hoisted(() => vi.fn());

vi.mock("../src/prisma.js", () => ({
  prisma: { $queryRaw: (...args: unknown[]) => queryRaw(...args) },
}));

import {
  countDistinctBotJoins,
  countDistinctJoinsBySource,
  currentBotMembers,
} from "../src/utils/channelStats.js";

// buildChannelStatsPanel channels.ts da — config.ts import'da BOT_TOKEN talab
// qiladi, shuning uchun env oldin o'rnatilib, modul dinamik import qilinadi
// (adminRouting.test.ts bilan bir xil usul).
process.env.BOT_TOKEN = "test:token";
process.env.ADMIN_IDS = "1";

let buildChannelStatsPanel: (c: Channel, s: ChannelStatsData) => string;
let mergeSourceBuckets: (m: ReadonlyMap<string, number>) => ChannelStatsData["source"];

beforeAll(async () => {
  ({ buildChannelStatsPanel, mergeSourceBuckets } = await import(
    "../src/handlers/admin/channels.js"
  ));
});

beforeEach(() => {
  vi.clearAllMocks();
});

function chan(over: Partial<Channel>): Channel {
  return {
    id: 1,
    chatId: 123n,
    title: "Test kanal",
    username: "test_kanal",
    inviteLink: null,
    botInviteLink: null,
    buttonLabel: null,
    type: "PUBLIC",
    isActive: true,
    sortOrder: 0,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...over,
  } as Channel;
}

function stats(over: Partial<ChannelStatsData> = {}): ChannelStatsData {
  return {
    botToday: 0,
    botWeek: 0,
    botMonth: 0,
    botTotal: 0,
    currentBot: 0,
    memberCount: null,
    reqPending: 0,
    source: { bot: 0, link: 0, request: 0, folder: 0, unknown: 0 },
    ...over,
  };
}

describe("countDistinctBotJoins", () => {
  /**
   * `rangeConditions` Prisma.Sql obyektini qaytaradi — u TASHQI template'da
   * `?` sifatida bog'lanadi, ichki filtlar (type/date) esa o'sha obyektning
   * `.sql`/`.values` da yashaydi. Shuning uchun ikkala qatlam tekshiriladi.
   */
  function extractCall() {
    const call = queryRaw.mock.calls[0] as [TemplateStringsArray, bigint, { sql: string; values: unknown[] }];
    const [strings, channelId, cond] = call;
    return { strings, channelId, cond };
  }

  it("COUNT(DISTINCT userId) + source='bot' so'rovini yuboradi, ::int natijani qaytaradi", async () => {
    queryRaw.mockResolvedValueOnce([{ n: 7 }]);
    await expect(countDistinctBotJoins(123n, null)).resolves.toBe(7);

    const { strings, channelId, cond } = extractCall();
    const sql = strings.join("?");
    expect(sql).toContain('FROM "channel_events"');
    expect(sql).toContain("COUNT(DISTINCT");
    // 'bot' — tashqi template'da LITERAL (bog'langan qiymat emas)
    expect(sql).toContain("'bot'");
    expect(channelId).toBe(123n);
    // type filtri ichki Prisma.Sql obyektida
    expect(cond.sql).toContain('"type" =');
    expect(cond.values).toContain("join");
  });

  it("bo'sh natija → 0", async () => {
    queryRaw.mockResolvedValueOnce([]);
    await expect(countDistinctBotJoins(123n, null)).resolves.toBe(0);
  });

  it("davr berilsa — type filtri bilan birga date chegarasi ham WHERE ga tushadi", async () => {
    queryRaw.mockResolvedValueOnce([{ n: 2 }]);
    await countDistinctBotJoins(123n, { gte: new Date("2026-08-01T00:00:00Z") });

    const { cond } = extractCall();
    expect(cond.sql).toContain('"type" =');
    expect(cond.sql).toContain('"date" >=');
    // REGRESSIYA: shartlar " AND " bilan ulanishi SHART. `Prisma.join` separatori
    // string emas, Sql obyekti berilsa matnga "[object Object]" bo'lib qo'shiladi
    // va Postgres sintaksis xatosi beradi (bitta shartda bilinmaydi).
    expect(cond.sql).not.toContain("[object Object]");
    expect(cond.sql).toMatch(/"type" = \S+ AND "date" >=/);
  });

  it("uch shart (gte + lte) ham to'g'ri ulanadi", async () => {
    queryRaw.mockResolvedValueOnce([{ n: 1 }]);
    await countDistinctBotJoins(123n, {
      gte: new Date("2026-08-01T00:00:00Z"),
      lte: new Date("2026-08-12T00:00:00Z"),
    });

    const { cond } = extractCall();
    expect(cond.sql).not.toContain("[object Object]");
    expect(cond.sql.match(/ AND /g)).toHaveLength(2);
    expect(cond.values).toHaveLength(3);
  });
});

describe("countDistinctJoinsBySource", () => {
  it("manba kesimini Map qilib qaytaradi", async () => {
    queryRaw.mockResolvedValueOnce([
      { source: "bot", n: 3 },
      { source: "unknown", n: 2 },
    ]);
    const map = await countDistinctJoinsBySource(123n, null);
    expect(map.get("bot")).toBe(3);
    expect(map.get("unknown")).toBe(2);
    expect(map.size).toBe(2);
  });
});

describe("currentBotMembers", () => {
  it("channel_members snapshot'idan joriy bot a'zolarini so'raydi", async () => {
    queryRaw.mockResolvedValueOnce([{ n: 5 }]);
    await expect(currentBotMembers(123n)).resolves.toBe(5);

    const [strings] = queryRaw.mock.calls[0] as [TemplateStringsArray];
    const sql = strings.join("?");
    expect(sql).toContain('FROM "channel_members"');
    expect(sql).toContain('"source" =');
    expect(sql).toContain('"leftAt" IS NULL');
  });
});

describe("mergeSourceBuckets", () => {
  it("`direct` + `unknown` bitta ❔ Noma'lum bucket'ga birlashadi", () => {
    const merged = mergeSourceBuckets(
      new Map([
        ["bot", 2],
        ["link", 1],
        ["direct", 4],
        ["unknown", 3],
      ])
    );
    expect(merged.bot).toBe(2);
    expect(merged.link).toBe(1);
    expect(merged.unknown).toBe(7);
  });

  it("tanilmagan manba qiymatlari hisobga olinmaydi", () => {
    const merged = mergeSourceBuckets(new Map([["weird", 99]]));
    expect(merged.unknown).toBe(0);
    expect(merged.bot).toBe(0);
  });
});

describe("buildChannelStatsPanel", () => {
  it("INSTAGRAM — ma'nosiz raqamlar emas, statistika bloki '—'", () => {
    const c = chan({ type: "INSTAGRAM", username: null, inviteLink: "https://instagram.com/x" });
    const panel = buildChannelStatsPanel(c, stats());
    expect(panel).toContain("<b>📊 Statistikalar:</b> —");
    expect(panel).not.toContain("📊 Bot orqali qo'shilgan yagona odamlar:");
  });

  it("non-INSTAGRAM — 4 ta yagona raqam + joriy holat satrlari", () => {
    const panel = buildChannelStatsPanel(
      chan({}),
      stats({ botToday: 1, botWeek: 4, botMonth: 9, botTotal: 12, currentBot: 11, memberCount: 500 })
    );
    expect(panel).toContain("Bugun: <b>1</b> · 7 kun: <b>4</b> · 30 kun: <b>9</b> · Jami: <b>12</b>");
    expect(panel).toContain("👥 Hozirgi a'zolar (Telegram): <b>500</b>");
    expect(panel).toContain("🤖 Bot orqali, hozir a'zoda: <b>11</b>");
    expect(panel).toContain("🤖 Bot: <b>0</b>");
    expect(panel).toContain("❔ Noma'lum: <b>0</b>");
  });

  it("memberCount null bo'lsa '—' ko'rsatiladi", () => {
    const panel = buildChannelStatsPanel(chan({}), stats());
    expect(panel).toContain("👥 Hozirgi a'zolar (Telegram): <b>—</b>");
  });

  it("manba kesimini (yagona) to'liq chiqaradi", () => {
    const panel = buildChannelStatsPanel(
      chan({}),
      stats({
        source: { bot: 3, link: 1, request: 2, folder: 4, unknown: 7 },
      })
    );
    expect(panel).toContain("🤖 Bot: <b>3</b>");
    expect(panel).toContain("🔗 Havola: <b>1</b>");
    expect(panel).toContain("📋 So'rov: <b>2</b>");
    expect(panel).toContain("📁 Papka: <b>4</b>");
    expect(panel).toContain("❔ Noma'lum: <b>7</b>");
    expect(panel).toContain('"Noma\'lum"');
  });

  it("REQUEST — faqat pending > 0 bo'lsa so'rov satri chiqadi", () => {
    const c = chan({ type: "REQUEST" });
    expect(buildChannelStatsPanel(c, stats({ reqPending: 0 }))).not.toContain("Kutilayotgan so'rovlar");
    expect(buildChannelStatsPanel(c, stats({ reqPending: 3 }))).toContain("⏳ Kutilayotgan so'rovlar: <b>3</b>");
    // non-REQUEST — pending qiymatiga qaramay so'rov satri yo'q
    expect(buildChannelStatsPanel(chan({}), stats({ reqPending: 3 }))).not.toContain("Kutilayotgan so'rovlar");
  });

  it("username yo'q bo'lsa havola ko'rsatiladi (umuman yo'q bo'lsa — '(havola yo'q)')", () => {
    const withLink = buildChannelStatsPanel(
      chan({ username: null, inviteLink: "https://t.me/+abc" }),
      stats()
    );
    expect(withLink).toContain("<code>https://t.me/+abc</code>");

    const noLink = buildChannelStatsPanel(chan({ username: null, inviteLink: null }), stats());
    expect(noLink).toContain("(havola yo'q)");
  });

  it("sarlavha HTML'dan xavfsiz (escape qilinadi)", () => {
    const panel = buildChannelStatsPanel(
      chan({ title: 'A & B <b>x</b> "q"' }),
      stats()
    );
    expect(panel).not.toContain('A & B <b>');
    expect(panel).toContain("A &amp; B");
  });
});