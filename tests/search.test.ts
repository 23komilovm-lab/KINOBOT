import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/prisma.js", () => ({
  prisma: {
    movie: { findMany: vi.fn() },
    serial: { findMany: vi.fn() },
    $queryRaw: vi.fn(),
  },
}));

import { prisma } from "../src/prisma.js";
import { escapeLike, searchContent, type SearchHit } from "../src/services/search.js";

const movieHit = (id: number, title: string): SearchHit => ({
  kind: "movie",
  id,
  code: id,
  title,
  views: 0,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("escapeLike", () => {
  it("LIKE wildcard'larini escape qiladi", () => {
    expect(escapeLike("50%")).toBe("50\\%");
    expect(escapeLike("a_b")).toBe("a\\_b");
    expect(escapeLike("a\\b")).toBe("a\\\\b");
  });

  it("oddiy matnni o'zgartirmaydi", () => {
    expect(escapeLike("qor")).toBe("qor");
  });
});

describe("searchContent — 3 bosqichli fallback", () => {
  it("2 ta harfdan kam so'rov → bo'sh (DB ga urilmaydi)", async () => {
    const res = await searchContent("a");
    expect(res).toEqual([]);
    expect(prisma.movie.findMany).not.toHaveBeenCalled();
  });

  it("1-bosqich (titleNorm) natija bersa — o'shani qaytaradi, fuzzy'ga tushmaydi", async () => {
    vi.mocked(prisma.movie.findMany).mockImplementation((args) =>
      Promise.resolve((args?.where?.titleNorm ? [movieHit(1, "Qor")] : []) as never[])
    );
    vi.mocked(prisma.serial.findMany).mockResolvedValue([] as never[]);

    const res = await searchContent("qor");
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ kind: "movie", title: "Qor" });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it("1-2-bosqich bo'sh bo'lsa — pg_trgm fuzzy qidiruvga tushadi", async () => {
    vi.mocked(prisma.movie.findMany).mockResolvedValue([] as never[]);
    vi.mocked(prisma.serial.findMany).mockResolvedValue([] as never[]);
    vi.mocked(prisma.$queryRaw).mockResolvedValue([
      { kind: "movie", id: 7, code: 700, title: "Qor uchquni", views: 3 },
    ] as never[]);

    const res = await searchContent("qorqor");
    expect(prisma.$queryRaw).toHaveBeenCalled();
    expect(res).toHaveLength(1);
    expect(res[0]).toMatchObject({ kind: "movie", id: 7, code: 700 });

    // REGRESSIYA (prodda "column titlenorm does not exist" bergan):
    //  1. camelCase ustun qo'shtirnoqda bo'lishi shart — aks holda Postgres uni
    //     kichik harfga tushiradi va topa olmaydi.
    //  2. UNION'dan keyin ORDER BY ifoda qabul qilmaydi, faqat chiquvchi ustun —
    //     saralash ichki so'rovdagi `sim` ustuni bo'yicha bo'lishi kerak.
    const [strings] = vi.mocked(prisma.$queryRaw).mock.calls[0] as unknown as [
      TemplateStringsArray,
    ];
    const sql = strings.join("?");
    expect(sql).toContain('"titleNorm"');
    expect(sql).not.toMatch(/[^"]titleNorm[^"]/);
    expect(sql).toMatch(/ORDER BY\s+sim DESC/);
  });

  it("ikki bosqich natijalarini takrorsiz birlashtiradi", async () => {
    // titleNorm va title ikkalasi ham bitta kino qaytarsin — takror chiqmasin
    vi.mocked(prisma.movie.findMany).mockImplementation(() =>
      Promise.resolve([movieHit(1, "Qor")] as never[])
    );
    vi.mocked(prisma.serial.findMany).mockResolvedValue([] as never[]);

    const res = await searchContent("qor");
    expect(res).toHaveLength(1);
  });
});
