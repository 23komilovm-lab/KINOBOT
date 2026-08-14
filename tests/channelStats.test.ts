import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";
import type { Channel } from "@prisma/client";
import type { ChannelStatsData } from "../src/handlers/admin/channels.js";

// channelStats modullari $queryRaw orqali ishlaydi — javobni testda beramiz.
const queryRaw = vi.hoisted(() => vi.fn());

vi.mock("../src/prisma.js", () => ({
  prisma: { $queryRaw: (...args: unknown[]) => queryRaw(...args) },
}));

import {
  countBotJoinsBySignal,
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
  ({ buildChannelStatsPanel, mergeSourceBuckets } =
    await import("../src/handlers/admin/channels.js"));
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
    const call = queryRaw.mock.calls[0] as [
      TemplateStringsArray,
      bigint,
      { sql: string; values: unknown[] },
    ];
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

describe("countBotJoinsBySignal", () => {
  it("dalil / taxmin / kuzatuvdan oldingi — uchga ajratadi", async () => {
    queryRaw.mockResolvedValueOnce([{ by_link: 12, by_gate: 40, legacy: 810 }]);
    await expect(countBotJoinsBySignal(123n, null)).resolves.toEqual({
      byLink: 12,
      byGate: 40,
      legacy: 810,
    });

    const [strings] = queryRaw.mock.calls[0] as [TemplateStringsArray];
    const sql = strings.join("?");
    expect(sql).toContain(`FILTER (WHERE e."inviteLink" IS NOT NULL)`);
    expect(sql).toContain("COUNT(DISTINCT");
    expect(sql).toContain("'bot'");
  });

  it("chegara — havolasi bor ENG BIRINCHI yozuv vaqti (kodda qattiq sana yo'q)", async () => {
    // Qattiq sana deploy vaqtiga bog'liq bo'lardi va noto'g'ri chegara berardi.
    queryRaw.mockResolvedValueOnce([{ by_link: 0, by_gate: 0, legacy: 0 }]);
    await countBotJoinsBySignal(123n, null);
    const [strings] = queryRaw.mock.calls[0] as [TemplateStringsArray];
    const sql = strings.join("?").replace(/\s+/g, " ");
    expect(sql).toContain("WITH cutoff AS");
    expect(sql).toContain(`COALESCE(MIN("date"), now())`);
    // Kuzatuv boshlanmagan bo'lsa hamma yozuv "legacy" tomonga tushishi kerak
    expect(sql).toMatch(/e\."date" < \(SELECT t FROM cutoff\)/);
    expect(sql).toMatch(/e\."date" >= \(SELECT t FROM cutoff\)/);
  });

  it("bo'sh natija → uchalasi 0", async () => {
    queryRaw.mockResolvedValueOnce([]);
    await expect(countBotJoinsBySignal(123n, null)).resolves.toEqual({
      byLink: 0,
      byGate: 0,
      legacy: 0,
    });
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
      stats({
        botToday: 1,
        botWeek: 4,
        botMonth: 9,
        botTotal: 12,
        currentBot: 11,
        memberCount: 500,
      })
    );
    expect(panel).toContain(
      "Bugun: <b>1</b> · 7 kun: <b>4</b> · 30 kun: <b>9</b> · Jami: <b>12</b>"
    );
    expect(panel).toContain("👥 A'zolar (Telegram): <b>500</b>");
    expect(panel).toContain("🤖 Bot orqali hozir a'zoda: <b>11</b>");
    expect(panel).toContain("🧭 Manba: —");
  });

  it("memberCount null bo'lsa '—' ko'rsatiladi", () => {
    const panel = buildChannelStatsPanel(chan({}), stats());
    expect(panel).toContain("👥 A'zolar (Telegram): <b>—</b>");
  });

  it("manba kesimini (yagona) to'liq chiqaradi", () => {
    const panel = buildChannelStatsPanel(
      chan({}),
      stats({
        source: { bot: 3, link: 1, request: 2, folder: 4, unknown: 7 },
      })
    );
    // BITTA qatorda — ilgari har turi alohida qator edi va panelning yarmi
    // nollardan iborat bo'lardi.
    expect(panel).toContain(
      "🧭 Manba: 🤖 Bot <b>3</b> · 🔗 Havola <b>1</b> · 📋 So'rov <b>2</b> · " +
        "📁 Papka <b>4</b> · ❔ Noma'lum <b>7</b>"
    );
    // Izoh yig'iladigan sitatada — panel qisqa ko'rinadi
    expect(panel).toContain("<blockquote expandable>");
    expect(panel).toContain("Noma'lum manba.");
  });

  it("NOL manbalar tushirib qoldiriladi", () => {
    const panel = buildChannelStatsPanel(
      chan({}),
      stats({ source: { bot: 5, link: 0, request: 0, folder: 0, unknown: 2 } })
    );
    expect(panel).toContain("🧭 Manba: 🤖 Bot <b>5</b> · ❔ Noma'lum <b>2</b>");
    expect(panel).not.toContain("Papka");
    expect(panel).not.toContain("So'rov");
  });

  it("hamma manba nol bo'lsa — '—'", () => {
    const panel = buildChannelStatsPanel(chan({}), stats());
    expect(panel).toContain("🧭 Manba: —");
  });

  it("REQUEST — asosiy metrika ZAYIFKA soni, 'qo'shilgan' emas", () => {
    // Darvoza pending zayifkani "obuna" deb hisoblaydi va odamni o'tkazadi, lekin
    // u guruhga KIRMAGAN. Shuning uchun bu kanalda "qo'shilgan odamlar" emas,
    // zayifka soni ko'rsatilishi kerak.
    const c = chan({ type: "REQUEST" });
    const panel = buildChannelStatsPanel(
      c,
      stats({
        reqPending: 10471,
        botTotal: 1868,
        req: { today: 777, week: 3177, month: 10471, total: 10471, approved: 0 },
      })
    );
    expect(panel).toContain("📨 Zayifkalar");
    expect(panel).toContain("Bugun: <b>777</b>");
    expect(panel).toContain("⏳ Navbatda: <b>10471</b>");
    expect(panel).toContain("✅ Tasdiqlangan: <b>0</b>");
    expect(panel).toContain("🤖 Kuzatuv tasdiqlagan: <b>1868</b>");
    // Adashtiradigan "qo'shilgan odamlar" sarlavhasi bu yerda BO'LMASLIGI kerak
    expect(panel).not.toContain("Bot orqali qo'shilgan yagona odamlar");
  });

  it("REQUEST — req ma'lumoti bo'lmasa oddiy panelga qaytadi", () => {
    const panel = buildChannelStatsPanel(chan({ type: "REQUEST" }), stats({ reqPending: 3 }));
    expect(panel).toContain("Bot orqali qo'shilgan yagona odamlar");
  });

  it("non-REQUEST kanalda zayifka bloki chiqmaydi", () => {
    const panel = buildChannelStatsPanel(
      chan({}),
      stats({ reqPending: 3, req: { today: 1, week: 2, month: 3, total: 3, approved: 0 } })
    );
    expect(panel).not.toContain("Zayifkalar");
    expect(panel).toContain("Bot orqali qo'shilgan yagona odamlar");
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

  // ---- HAVOLA KESIMI (qisqacha satr) ----
  it("havolalar soni va joriy havola natijasi ko'rsatiladi", () => {
    const panel = buildChannelStatsPanel(
      chan({ botInviteLink: "https://t.me/+yangi" }),
      stats({ links: { count: 3, currentJoined: 12, currentRequests: 0 } })
    );
    expect(panel).toContain("🧷 Havolalar: <b>3</b> ta · joriy havola orqali: <b>12</b>");
    // Bittadan ko'p havola bor — eski havolalar qayerdan ko'rilishi aytiladi
    expect(panel).toContain("«🔗 Havolalar»");
  });

  it("bitta havola bo'lsa — 'eski havolalar' izohi keraksiz", () => {
    const panel = buildChannelStatsPanel(
      chan({}),
      stats({ links: { count: 1, currentJoined: 5, currentRequests: 0 } })
    );
    expect(panel).toContain("🧷 Havolalar: <b>1</b> ta");
    expect(panel).not.toContain("Eski havolalar kesimi");
  });

  it("so'rovli kanalda joriy havola ZAYIFKA soni bilan ko'rsatiladi", () => {
    const panel = buildChannelStatsPanel(
      chan({ type: "REQUEST" }),
      stats({
        req: { today: 1, week: 2, month: 3, total: 3, approved: 0 },
        links: { count: 2, currentJoined: 4, currentRequests: 300 },
      })
    );
    expect(panel).toContain("joriy havola orqali: <b>300</b>");
  });

  it("havola ma'lumoti bo'lmasa satr umuman chiqmaydi (eski chaqiruvlar buzilmaydi)", () => {
    const panel = buildChannelStatsPanel(chan({}), stats());
    expect(panel).not.toContain("🧷 Havolalar");
  });

  // ---- "Bot orqali" dalil kesimi ----
  it("qat'iy dalil va taxmin ALOHIDA ko'rsatiladi", () => {
    // 862 tadan 850 tasi darvoza taxmini bo'lsa, adminni "hammasi bot xizmati"
    // deb chalg'itmasligi kerak.
    const panel = buildChannelStatsPanel(
      chan({}),
      stats({ botTotal: 862, botSignal: { byLink: 12, byGate: 40, legacy: 810 } })
    );
    // Bitta qatorda, izoh esa yig'iladigan sitatada
    expect(panel).toContain(
      "🔬 Dalil: ✅ <b>12</b> havola · 🤔 <b>40</b> taxmin · ❔ <b>810</b> eski"
    );
    expect(panel).toContain("<blockquote expandable>");
    expect(panel).toContain("o'zi topib");
  });

  it("botSignal bo'lmasa dalil qatori chiqmaydi", () => {
    const panel = buildChannelStatsPanel(chan({}), stats({ botTotal: 5 }));
    expect(panel).not.toContain("🔬 Dalil");
  });

  it("dalil raqamlari UCHALASI NOL bo'lsa qator umuman chiqmaydi", () => {
    // Yangi kanalda aynan shunday bo'ladi — "✅ 0 · 🤔 0 · ❔ 0" hech narsa
    // aytmaydi, faqat panelni cho'zadi.
    const panel = buildChannelStatsPanel(
      chan({}),
      stats({ botSignal: { byLink: 0, byGate: 0, legacy: 0 } })
    );
    expect(panel).not.toContain("🔬 Dalil");
    expect(panel).not.toContain("Dalil kesimi.");
  });

  it("izohlar YIG'ILADIGAN sitatada — panel qisqa ko'rinadi", () => {
    // Telegram <blockquote expandable> uzun matnni "ko'proq ko'rish" ostiga
    // yashiradi: telegra.ph kabi tashqi xizmat kerak emas.
    const panel = buildChannelStatsPanel(
      chan({}),
      stats({
        source: { bot: 5, link: 0, request: 0, folder: 0, unknown: 900 },
        botSignal: { byLink: 4, byGate: 1, legacy: 900 },
      })
    );
    const visible = panel.split("<blockquote")[0];
    // Ko'rinadigan qism qisqa; uzun prozaning hammasi sitata ichida
    expect(visible.split("\n").length).toBeLessThanOrEqual(14);
    expect(visible).not.toContain("Telegram havolani aytmagan");
    expect(panel).toContain("Telegram havolani aytmagan");
  });

  it("izoh yo'q bo'lsa sitata umuman qo'shilmaydi", () => {
    const panel = buildChannelStatsPanel(chan({}), stats());
    expect(panel).not.toContain("<blockquote");
  });

  it("so'rovli kanalda ham dalil kesimi ko'rinadi", () => {
    const panel = buildChannelStatsPanel(
      chan({ type: "REQUEST" }),
      stats({
        req: { today: 1, week: 2, month: 3, total: 3, approved: 0 },
        botSignal: { byLink: 4, byGate: 9, legacy: 2 },
      })
    );
    expect(panel).toContain("🔬 Dalil: ✅ <b>4</b> havola");
  });

  // ---- Sog'liq bloki ----
  it("nosozlik ENG TEPADA — raqamlardan oldin ko'rinadi", () => {
    // Bot admin bo'lmasa raqamlar ahamiyatsiz: avval shuni ko'rish kerak.
    const panel = buildChannelStatsPanel(
      chan({}),
      stats({ botTotal: 500, health: { problems: ["bot admin emas"], disabled: false } })
    );
    expect(panel).toContain("🚨 <b>NOSOZLIK:</b>");
    expect(panel).toContain("• bot admin emas");
    expect(panel.indexOf("NOSOZLIK")).toBeLessThan(panel.indexOf("Bot orqali qo'shilgan"));
  });

  it("majburiy obuna o'chirilgan bo'lsa shu ham aytiladi", () => {
    const panel = buildChannelStatsPanel(
      chan({}),
      stats({ health: { problems: ["havola o'lik"], disabled: true } })
    );
    expect(panel).toContain("Majburiy obuna vaqtincha o'chirildi");
    expect(panel).toContain("o'zi qayta yoqiladi");
  });

  it("muammo yo'q bo'lsa blok umuman chiqmaydi", () => {
    const panel = buildChannelStatsPanel(
      chan({}),
      stats({ health: { problems: [], disabled: false } })
    );
    expect(panel).not.toContain("NOSOZLIK");
  });

  it("sog'liq ma'lumoti umuman bo'lmasa ham panel buzilmaydi", () => {
    const panel = buildChannelStatsPanel(chan({}), stats());
    expect(panel).not.toContain("NOSOZLIK");
    expect(panel).toContain("Bot orqali qo'shilgan");
  });

  it("nosozlik so'rovli kanalda ham ko'rinadi", () => {
    const panel = buildChannelStatsPanel(
      chan({ type: "REQUEST" }),
      stats({
        req: { today: 0, week: 0, month: 0, total: 0, approved: 0 },
        health: { problems: ["kanalga kirib bo'lmayapti"], disabled: false },
      })
    );
    expect(panel).toContain("🚨 <b>NOSOZLIK:</b>");
    expect(panel).toContain("Zayifkalar");
  });

  // ---- Sarlavha: "Tur · @username" bir qatorda ----
  it("username bor kanalda tur va username BIR QATORDA, username bosiladigan", () => {
    const panel = buildChannelStatsPanel(chan({ username: "kino_kanal" }), stats());
    expect(panel).toContain(
      'Tur: <b>Ommaviy</b> · <a href="https://t.me/kino_kanal">@kino_kanal</a>'
    );
  });

  it("username havolasi AYNAN t.me/<username> — tracking havolasi EMAS", () => {
    // Tracking havolasi bekor qilinishi mumkin, username havolasi esa hech
    // qachon eskirmaydi. Shuning uchun bu yerda botInviteLink ISHLATILMAYDI.
    const panel = buildChannelStatsPanel(
      chan({ username: "kino_kanal", botInviteLink: "https://t.me/+tracking" }),
      stats()
    );
    expect(panel).toContain('href="https://t.me/kino_kanal"');
    expect(panel).not.toContain('href="https://t.me/+tracking"');
  });

  it("username oldidagi @ ikki marta chiqmaydi", () => {
    const panel = buildChannelStatsPanel(chan({ username: "@kino_kanal" }), stats());
    expect(panel).toContain(">@kino_kanal</a>");
    expect(panel).not.toContain("@@");
  });

  it("username yo'q bo'lsa havola alohida qatorda qoladi", () => {
    const panel = buildChannelStatsPanel(
      chan({ username: null, inviteLink: "https://t.me/+XyZ", type: "PRIVATE" }),
      stats()
    );
    expect(panel).toContain("Tur: <b>Maxfiy</b>\n<code>https://t.me/+XyZ</code>");
    expect(panel).not.toContain("<a href=");
  });

  it("username ham, havola ham yo'q bo'lsa panel buzilmaydi", () => {
    const panel = buildChannelStatsPanel(chan({ username: null, inviteLink: null }), stats());
    expect(panel).toContain("(havola yo'q)");
    expect(panel).not.toContain("<a href=");
  });

  it("admin ulagan havola panelda alohida ko'rsatiladi", () => {
    const panel = buildChannelStatsPanel(
      chan({ adminInviteLink: "https://t.me/+admin", botInviteLink: "https://t.me/+bot" }),
      stats()
    );
    expect(panel).toContain("📎 Darvoza havolasi (sizniki): <code>https://t.me/+admin</code>");
    // Tracking havolasi ham qoladi — u statistika uchun ishlaydi
    expect(panel).toContain("🔗 Tracking havolasi: <code>https://t.me/+bot</code>");
  });

  it("admin havolasi yo'q bo'lsa o'sha qator chiqmaydi", () => {
    const panel = buildChannelStatsPanel(chan({ botInviteLink: "https://t.me/+bot" }), stats());
    expect(panel).not.toContain("Darvoza havolasi");
  });

  it("sarlavha HTML'dan xavfsiz (escape qilinadi)", () => {
    const panel = buildChannelStatsPanel(chan({ title: 'A & B <b>x</b> "q"' }), stats());
    expect(panel).not.toContain("A & B <b>");
    expect(panel).toContain("A &amp; B");
  });
});
