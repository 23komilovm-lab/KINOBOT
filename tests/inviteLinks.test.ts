import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * HAVOLA KESIMI — "eski havola orqali qancha, yangisi orqali qancha".
 *
 * Panel quruvchisi sof funksiya (DB'siz sinaladi), `collectInviteLinkStats`
 * esa $queryRaw + registr o'qishlarini birlashtiradi — mock DB bilan.
 */

const queryRaw = vi.hoisted(() => vi.fn());
const findMany = vi.hoisted(() => vi.fn());

vi.mock("../src/prisma.js", () => ({
  prisma: {
    $queryRaw: (...args: unknown[]) => queryRaw(...args),
    channelInviteLink: { findMany: (...args: unknown[]) => findMany(...args) },
  },
}));

import {
  buildInviteLinkPanel,
  collectInviteLinkStats,
  sortInviteLinkRows,
  MAX_LINK_ROWS,
  LINK_TRACKING_START,
  type InviteLinkStatRow,
  type InviteLinkStats,
} from "../src/utils/inviteLinks.js";

beforeEach(() => {
  vi.clearAllMocks();
});

function row(over: Partial<InviteLinkStatRow> = {}): InviteLinkStatRow {
  return {
    seq: 1,
    link: "https://t.me/+aaa",
    name: "bot_tracking",
    createdAt: new Date("2026-08-01T00:00:00Z"),
    revokedAt: null,
    isCurrent: false,
    joined: 0,
    members: 0,
    requests: 0,
    reqApproved: 0,
    reqPending: 0,
    ...over,
  };
}

function stats(over: Partial<InviteLinkStats> = {}): InviteLinkStats {
  return { rows: [], unattributedJoins: 0, unattributedRequests: 0, ...over };
}

describe("sortInviteLinkRows", () => {
  it("joriy havola birinchi, keyin yangi → eski", () => {
    const sorted = sortInviteLinkRows([
      row({ seq: 1, link: "a" }),
      row({ seq: 3, link: "c", isCurrent: true }),
      row({ seq: 2, link: "b" }),
    ]);
    expect(sorted.map((r) => r.link)).toEqual(["c", "b", "a"]);
  });

  it("registrda yo'q havolalar oxirida, qo'shilganlar soni bo'yicha", () => {
    const sorted = sortInviteLinkRows([
      row({ seq: null, link: "x", joined: 2 }),
      row({ seq: null, link: "y", joined: 9 }),
      row({ seq: 1, link: "a" }),
    ]);
    expect(sorted.map((r) => r.link)).toEqual(["a", "y", "x"]);
  });

  it("kirish massivini o'zgartirmaydi (sof funksiya)", () => {
    const input = [row({ seq: 1, link: "a" }), row({ seq: 2, link: "b", isCurrent: true })];
    sortInviteLinkRows(input);
    expect(input.map((r) => r.link)).toEqual(["a", "b"]);
  });
});

describe("buildInviteLinkPanel", () => {
  it("eski va yangi havola ALOHIDA qatorda, raqamlari bilan ko'rinadi", () => {
    const panel = buildInviteLinkPanel(
      "Kino kanal",
      false,
      stats({
        rows: [
          row({ seq: 2, link: "https://t.me/+yangi", isCurrent: true, joined: 12, members: 11 }),
          row({
            seq: 1,
            link: "https://t.me/+eski",
            revokedAt: new Date("2026-08-13T05:00:00Z"),
            joined: 45,
            members: 40,
          }),
        ],
      })
    );

    expect(panel).toContain("#2");
    expect(panel).toContain("🟢 JORIY");
    expect(panel).toContain("Qo'shilgan: <b>12</b> · Hozir a'zo: <b>11</b>");

    expect(panel).toContain("#1");
    expect(panel).toContain("🔴 Bekor qilingan");
    expect(panel).toContain("Qo'shilgan: <b>45</b> · Hozir a'zo: <b>40</b>");

    // Havolaning o'zi ham ko'rinadi — admin qaysi qator qaysi havola ekanini bilsin
    expect(panel).toContain("<code>https://t.me/+yangi</code>");
    expect(panel).toContain("<code>https://t.me/+eski</code>");

    // Yig'indi
    expect(panel).toContain("qo'shilgan <b>57</b>");
    expect(panel).toContain("hozir a'zo <b>51</b>");
  });

  it("bekor qilingan havola sanasi ko'rsatiladi (Toshkent vaqti)", () => {
    const panel = buildInviteLinkPanel(
      "K",
      false,
      stats({ rows: [row({ seq: 1, revokedAt: new Date("2026-08-13T05:00:00Z") })] })
    );
    // UTC 05:00 → Toshkent 10:00
    expect(panel).toContain("13.08.2026 10:00");
  });

  it("so'rovli kanalda har havola uchun zayifka kesimi chiqadi", () => {
    const panel = buildInviteLinkPanel(
      "Guruh",
      true,
      stats({
        rows: [
          row({
            seq: 1,
            isCurrent: true,
            requests: 300,
            reqPending: 250,
            reqApproved: 50,
            joined: 50,
          }),
        ],
      })
    );
    expect(panel).toContain("📨 Zayifka: <b>300</b> (⏳ 250 · ✅ 50)");
    expect(panel).toContain("zayifka <b>300</b>");
  });

  it("oddiy kanalda zayifka satri chiqmaydi", () => {
    const panel = buildInviteLinkPanel("K", false, stats({ rows: [row({ requests: 5 })] }));
    expect(panel).not.toContain("Zayifka");
  });

  it("havolasi aniqlanmagan qo'shilishlar alohida, izohi bilan ko'rsatiladi", () => {
    const panel = buildInviteLinkPanel(
      "K",
      false,
      stats({ rows: [row({ isCurrent: true, joined: 3 })], unattributedJoins: 1868 })
    );
    expect(panel).toContain("❔ <b>Havola aniqlanmagan:</b> qo'shilgan <b>1868</b>");
    // Izoh yig'iladigan sitatada — panel qisqa ko'rinadi
    expect(panel).toContain("<blockquote expandable>");
    expect(panel).toContain(LINK_TRACKING_START);
    expect(panel.split("<blockquote")[0]).not.toContain(LINK_TRACKING_START);
    // Aniqlanmaganlar havolalar yig'indisiga QO'SHILMAYDI — aks holda raqam yolg'on bo'lardi
    expect(panel).toContain("qo'shilgan <b>3</b>");
  });

  it("aniqlanmagan yozuv bo'lmasa — o'sha blok umuman chiqmaydi", () => {
    const panel = buildInviteLinkPanel("K", false, stats({ rows: [row({ joined: 1 })] }));
    expect(panel).not.toContain("Havola aniqlanmagan");
  });

  it("havola umuman bo'lmasa — yo'riqnoma ko'rsatiladi", () => {
    const panel = buildInviteLinkPanel("K", false, stats());
    expect(panel).toContain("Hali birorta havola yozilmagan");
    expect(panel).toContain("♻️ Yangi havola");
  });

  it("registrda yo'q havola '•' bilan va 'registrdan tashqari' izohi bilan chiqadi", () => {
    const panel = buildInviteLinkPanel(
      "K",
      false,
      stats({ rows: [row({ seq: null, name: null, createdAt: null, joined: 4 })] })
    );
    expect(panel).toContain("registrdan tashqari");
    expect(panel).toContain("Qo'shilgan: <b>4</b>");
  });

  it("juda ko'p havola bo'lsa ro'yxat kesiladi va qolgani sanaladi (xabar limiti)", () => {
    // Panel tartiblamaydi — `collectInviteLinkStats` allaqachon tartiblab beradi.
    // Shuning uchun oxirgi 3 tasi kesiladi.
    const rows = Array.from({ length: MAX_LINK_ROWS + 3 }, (_, i) =>
      row({ seq: i + 1, link: `https://t.me/+l${i}` })
    );
    const panel = buildInviteLinkPanel("K", false, stats({ rows }));
    expect(panel).toContain("va yana 3 ta havola");
    expect(panel).toContain("https://t.me/+l0<");
    expect(panel).not.toContain("https://t.me/+l14<");
  });

  it("kanal nomi HTML'dan xavfsiz", () => {
    const panel = buildInviteLinkPanel("A & B <b>x</b>", false, stats({ rows: [row()] }));
    expect(panel).not.toContain("<b>x</b>");
    expect(panel).toContain("A &amp; B");
  });
});

describe("collectInviteLinkStats", () => {
  /** queryRaw chaqiruvlari tartibi: joins → members → (requests) → unattributed */
  function mockQueries(opts: {
    joins?: { link: string; n: number }[];
    members?: { link: string; n: number }[];
    requests?: { link: string; n: number; approved: number; pending: number }[];
    unattr?: { joins: number; reqs: number };
    withRequests: boolean;
  }) {
    queryRaw.mockResolvedValueOnce(opts.joins ?? []);
    queryRaw.mockResolvedValueOnce(opts.members ?? []);
    if (opts.withRequests) queryRaw.mockResolvedValueOnce(opts.requests ?? []);
    queryRaw.mockResolvedValueOnce([opts.unattr ?? { joins: 0, reqs: 0 }]);
  }

  it("registr qatorlarini hodisalar bilan bog'laydi (eski havola statistikasi yo'qolmaydi)", async () => {
    findMany.mockResolvedValueOnce([
      {
        seq: 1,
        link: "https://t.me/+eski",
        name: "bot_tracking",
        createdAt: new Date("2026-08-01T00:00:00Z"),
        revokedAt: new Date("2026-08-13T00:00:00Z"),
        isCurrent: false,
      },
      {
        seq: 2,
        link: "https://t.me/+yangi",
        name: "bot_tracking",
        createdAt: new Date("2026-08-13T00:00:00Z"),
        revokedAt: null,
        isCurrent: true,
      },
    ]);
    mockQueries({
      joins: [
        { link: "https://t.me/+eski", n: 45 },
        { link: "https://t.me/+yangi", n: 12 },
      ],
      members: [{ link: "https://t.me/+eski", n: 40 }],
      unattr: { joins: 100, reqs: 0 },
      withRequests: false,
    });

    const s = await collectInviteLinkStats(123n, false);

    // Joriy birinchi
    expect(s.rows[0].link).toBe("https://t.me/+yangi");
    expect(s.rows[0].joined).toBe(12);
    expect(s.rows[0].members).toBe(0);
    expect(s.rows[1].link).toBe("https://t.me/+eski");
    expect(s.rows[1].joined).toBe(45);
    expect(s.rows[1].members).toBe(40);
    expect(s.unattributedJoins).toBe(100);
  });

  it("registrda yo'q, lekin hodisalarda uchragan havola ham qatorga tushadi", async () => {
    findMany.mockResolvedValueOnce([]);
    mockQueries({
      joins: [{ link: "https://t.me/+boshqa", n: 7 }],
      members: [{ link: "https://t.me/+boshqa", n: 6 }],
      withRequests: false,
    });

    const s = await collectInviteLinkStats(123n, false);
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0]).toMatchObject({
      seq: null,
      link: "https://t.me/+boshqa",
      joined: 7,
      members: 6,
    });
  });

  it("oddiy kanalda zayifka so'rovi umuman yuborilmaydi", async () => {
    findMany.mockResolvedValueOnce([]);
    mockQueries({ withRequests: false });
    await collectInviteLinkStats(123n, false);
    // joins + members + unattributed = 3 ta so'rov
    expect(queryRaw).toHaveBeenCalledTimes(3);
  });

  it("so'rovli kanalda zayifka kesimi ham olinadi", async () => {
    findMany.mockResolvedValueOnce([
      {
        seq: 1,
        link: "https://t.me/+g",
        name: "bot_tracking",
        createdAt: new Date(),
        revokedAt: null,
        isCurrent: true,
      },
    ]);
    mockQueries({
      requests: [{ link: "https://t.me/+g", n: 300, approved: 50, pending: 250 }],
      unattr: { joins: 0, reqs: 9000 },
      withRequests: true,
    });

    const s = await collectInviteLinkStats(123n, true);
    expect(queryRaw).toHaveBeenCalledTimes(4);
    expect(s.rows[0]).toMatchObject({ requests: 300, reqApproved: 50, reqPending: 250 });
    expect(s.unattributedRequests).toBe(9000);
  });
});
