import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../src/prisma.js", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    movie: { findMany: vi.fn(), findUnique: vi.fn() },
    watchEvent: { findMany: vi.fn(), groupBy: vi.fn(), create: vi.fn() },
  },
}));
vi.mock("../src/config.js", () => ({ isAdmin: vi.fn(() => false) }));
vi.mock("../src/utils/premium.js", () => ({ isPremiumActive: vi.fn(() => false) }));
vi.mock("../src/utils/logger.js", () => ({ log: vi.fn() }));

import { prisma } from "../src/prisma.js";
import { isAdmin } from "../src/config.js";
import { isPremiumActive } from "../src/utils/premium.js";
import { weightedRandomMovie, recommendMovies, recordWatch } from "../src/services/recommend.js";
import type { MyContext } from "../src/types.js";

function ctxFor(id = 42): MyContext {
  return { from: { id } } as unknown as MyContext;
}

const movie = (id: number, genre: string, views: number) => ({
  id,
  genre,
  views,
  title: `kino-${id}`,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isAdmin).mockReturnValue(false);
  vi.mocked(isPremiumActive).mockReturnValue(false);
  vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
  // Ko'rilgan kinolar so'rovi default bo'sh — /random hovuzni to'liq tanlaydi
  vi.mocked(prisma.watchEvent.findMany).mockResolvedValue([] as never[]);
  // recordWatch ichida `.catch()` zanjirlanadi — promise qaytishi shart
  vi.mocked(prisma.watchEvent.create).mockResolvedValue({} as never);
});

describe("weightedRandomMovie — views-og'irlikli pick", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("Math.random=0 → eng kam views'li (id=1) tanlanadi", async () => {
    vi.mocked(prisma.movie.findMany).mockResolvedValue([
      { id: 1, views: 0 },
      { id: 2, views: 9 },
    ] as never[]);
    vi.mocked(prisma.movie.findUnique).mockImplementation((args) =>
      Promise.resolve({ id: args.where.id } as never)
    );
    vi.spyOn(Math, "random").mockReturnValue(0);

    const picked = await weightedRandomMovie(ctxFor());
    expect(picked).toMatchObject({ id: 1 });
  });

  it("Math.random~1 → eng ko'p views'li (id=2) tanlanadi", async () => {
    vi.mocked(prisma.movie.findMany).mockResolvedValue([
      { id: 1, views: 0 },
      { id: 2, views: 9 },
    ] as never[]);
    vi.mocked(prisma.movie.findUnique).mockImplementation((args) =>
      Promise.resolve({ id: args.where.id } as never)
    );
    vi.spyOn(Math, "random").mockReturnValue(0.9999);

    const picked = await weightedRandomMovie(ctxFor());
    expect(picked).toMatchObject({ id: 2 });
  });

  it("0-views kino ham imkoniyatga ega (id=1, r=0.09)", async () => {
    vi.mocked(prisma.movie.findMany).mockResolvedValue([
      { id: 1, views: 0 },
      { id: 2, views: 9 },
    ] as never[]);
    vi.mocked(prisma.movie.findUnique).mockImplementation((args) =>
      Promise.resolve({ id: args.where.id } as never)
    );
    vi.spyOn(Math, "random").mockReturnValue(0.09);

    const picked = await weightedRandomMovie(ctxFor());
    expect(picked).toMatchObject({ id: 1 });
  });

  it("hovuz bo'sh bo'lsa null qaytadi", async () => {
    vi.mocked(prisma.movie.findMany).mockResolvedValue([] as never[]);
    await expect(weightedRandomMovie(ctxFor())).resolves.toBeNull();
  });
});

describe("recommendMovies — affinitet × views skori", () => {
  it("sovuq foydalanuvchi → top-views fallback", async () => {
    vi.mocked(prisma.watchEvent.findMany).mockResolvedValue([] as never[]);
    vi.mocked(prisma.watchEvent.groupBy).mockResolvedValue([] as never[]);
    const fallback = [movie(1, "Drama", 99)];
    vi.mocked(prisma.movie.findMany).mockResolvedValue(fallback as never[]);

    const res = await recommendMovies(ctxFor(), 10);
    expect(res).toEqual(fallback);
    // fallback'da premium filter qo'llanadi (where: { isPremium: false, id: { notIn: [...] } })
    expect(prisma.movie.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isPremium: false }),
      })
    );
  });

  it("janrga mos kinolar birinchi chiqadi, nomos mos chiqariladi", async () => {
    // user 1 ta kino ko'rgan (id=1) — qayta tavsiya qilinmasligi kerak
    vi.mocked(prisma.watchEvent.findMany).mockResolvedValue([{ movieId: 1 }] as never[]);
    // affinitet: Drama=1, Romantika=1 (bitta "Drama / Romantika" yozuvidan)
    vi.mocked(prisma.watchEvent.groupBy).mockResolvedValue([
      { genre: "Drama / Romantika", _count: { _all: 2 } },
    ] as never[]);
    // kandidat hovuzi (views bo'yicha tartiblangan)
    vi.mocked(prisma.movie.findMany).mockResolvedValue([
      movie(2, "Drama", 5),
      movie(3, "Action", 100),
    ] as never[]);

    const res = await recommendMovies(ctxFor(), 10);
    expect(res).toHaveLength(1);
    expect(res[0].id).toBe(2); // faqat Drama — affinitet bor kino
  });

  it("affinitet hech qaysi janrga tegmasa → top-views fallback", async () => {
    vi.mocked(prisma.watchEvent.findMany).mockResolvedValue([{ movieId: 1 }] as never[]);
    vi.mocked(prisma.watchEvent.groupBy).mockResolvedValue([
      { genre: "Drama", _count: { _all: 1 } },
    ] as never[]);
    const fallback = [movie(9, "Action", 50)];
    vi.mocked(prisma.movie.findMany).mockResolvedValue(fallback as never[]);

    const res = await recommendMovies(ctxFor(), 10);
    expect(res).toEqual(fallback);
  });
});

describe("recordWatch — signal manbai", () => {
  it("adminlar uchun skip (statistika ifloslanmasin)", async () => {
    vi.mocked(isAdmin).mockReturnValue(true);
    await recordWatch(ctxFor(), { movieId: 1, genre: "Drama" });
    expect(prisma.watchEvent.create).not.toHaveBeenCalled();
  });

  it("oddiy user uchun yoziladi", async () => {
    await recordWatch(ctxFor(), { movieId: 1, genre: "Drama" });
    expect(prisma.watchEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: BigInt(42),
          movieId: 1,
          genre: "Drama",
        }),
      })
    );
  });
});
