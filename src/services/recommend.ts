import { prisma } from "../prisma.js";
import { isAdmin } from "../config.js";
import { isPremiumActive } from "../utils/premium.js";
import { log } from "../utils/logger.js";
import type { MyContext } from "../types.js";
import type { Movie } from "@prisma/client";

/**
 * TAVSIYA TIZIMI (2.4)
 *
 * Signal manbai: `WatchEvent` — har bir muvaffaqiyatli yetkazilgan kino/serial
 * qismi uchun delivery.ts tomonidan yoziladi. Shu asosida:
 *  - `getGenreAffinity` — foydalanuvchi qaysi janrga moyil (WatchEvent hisobi).
 *  - `recommendMovies` — skor = Σ(affinity × views), ko'rilganlar chiqariladi.
 *    Sovuq foydalanuvchi (hech narsa ko'rmagan) → top-views fallback.
 *  - `weightedRandomMovie` — top-N views hovuzi + views-og'irlikli tasodifiy
 *    tanlov ("/random" adolatliligi: bir marta ko'rilgan kino yana chiqavermaydi).
 *
 * MUHIM: tavsiya premium-gated — premium bo'lmagan foydalanuvchiga premium
 * kino tavsiya qilinmaydi (aks holda "tavsiya" to'lov taklifiga aylanib qolardi).
 */

/** Video tugmasi ostidagi "Sizga yoqishi mumkin" — callback data doimiy identifikator. */
export const RECOMMEND_CALLBACK = "rec:open";

/**
 * Ko'rish hodisasini yozadi. Adminlar uchun skip (admin testi statistikani
 * ifloslantirmasin). Hech qachon delivery oqimini buzmaydi — xato loglanadi.
 */
export async function recordWatch(
  ctx: MyContext,
  opts: { movieId?: number; serialId?: number; genre?: string | null }
): Promise<void> {
  const uid = ctx.from?.id;
  if (!uid || isAdmin(uid)) return; // adminlar signal manbai emas

  await prisma.watchEvent
    .create({
      data: {
        userId: BigInt(uid),
        movieId: opts.movieId ?? null,
        serialId: opts.serialId ?? null,
        genre: opts.genre?.trim() ? opts.genre.trim() : null,
      },
    })
    .catch((err) => {
      log("warn", "WatchEvent yozilmadi", { userId: uid.toString(), error: String(err) });
    });
}

/**
 * Foydalanuvchining janr affiniteti: janr → ko'rishlar soni.
 * Genre string bo'lishi mumkin ("Drama / Romantika") — qidiruvda bo'lish uchun
 * xom qiymat bo'yicha guruhlaymiz (bitta kino bir nechta janrga tegishi mumkin).
 */
async function getGenreAffinity(userId: bigint): Promise<Map<string, number>> {
  const rows = await prisma.watchEvent.groupBy({
    by: ["genre"],
    where: { userId, genre: { not: null } },
    _count: { _all: true },
  });
  const map = new Map<string, number>();
  for (const r of rows) {
    if (!r.genre) continue;
    // Bir yozuvdagi bir nechta janrni ajratamiz — har biriga ulush hisoblanadi
    const genres = r.genre
      .split(/[/,;|]+/)
      .map((g) => g.trim())
      .filter(Boolean);
    const share = r._count._all / Math.max(genres.length, 1);
    for (const g of genres) map.set(g.toLowerCase(), (map.get(g.toLowerCase()) ?? 0) + share);
  }
  return map;
}

/** Premium bo'lmagan foydalanuvchi uchun premium kinoni chiqarib tashlaydigan filter. */
async function premiumFilter(ctx: MyContext) {
  const uid = ctx.from?.id;
  if (uid && isAdmin(uid)) return {};
  if (uid) {
    const user = await prisma.user.findUnique({ where: { id: BigInt(uid) } });
    if (isPremiumActive(user?.premiumUntil)) return {};
  }
  return { isPremium: false };
}

const REC_PAGE_SIZE = 10;
const REC_CANDIDATE_LIMIT = 200;

/**
 * Tavsiyalar: janr affiniteti × views skori, ko'rilganlar chiqarib tashlanadi.
 * Sovuq foydalanuvchi yoki janr mos kelmasa → top-views fallback.
 */
export async function recommendMovies(ctx: MyContext, take = REC_PAGE_SIZE): Promise<Movie[]> {
  const uid = ctx.from?.id;
  const where = await premiumFilter(ctx);

  // Ko'rilgan kinolar id'lari — qayta tavsiya qilinmasligi uchun
  let watchedIds: number[] = [];
  let affinity = new Map<string, number>();
  if (uid && !isAdmin(uid)) {
    const [events, grouped] = await Promise.all([
      prisma.watchEvent.findMany({
        where: { userId: BigInt(uid), movieId: { not: null } },
        select: { movieId: true },
      }),
      getGenreAffinity(BigInt(uid)),
    ]);
    watchedIds = events.map((e) => e.movieId!);
    affinity = grouped;
  }

  // Sovuq foydalanuvchi (hech narsa ko'rmagan) — top-views fallback
  if (watchedIds.length === 0 || affinity.size === 0) {
    return prisma.movie.findMany({
      where: { ...where, id: { notIn: watchedIds } },
      orderBy: { views: "desc" },
      take,
    });
  }

  // Kandidat hovuzi (top-views ichidan) — barchasini skan qilmaymiz
  const candidates = await prisma.movie.findMany({
    where: { ...where, id: { notIn: watchedIds } },
    orderBy: { views: "desc" },
    take: REC_CANDIDATE_LIMIT,
  });

  const scored = candidates
    .map((m) => {
      const genres = (m.genre ?? "")
        .split(/[/,;|]+/)
        .map((g) => g.trim().toLowerCase())
        .filter(Boolean);
      let aff = 0;
      for (const g of genres) aff += affinity.get(g) ?? 0;
      // views bonus: bir xil affinitetda mashhuri birinchi chiqadi; 0-views kinolar
      // ham butunlay nolga tushib qolmasin
      const score = aff * (1 + m.views);
      return { m, score };
    })
    .sort((a, b) => b.score - a.score);

  // Affinitet hech bir janrga tegmasa (masalan user faqat janrsiz kino ko'rgan) —
  // top-views fallback, bo'sh ro'yxat qaytarmaymiz
  const nonZero = scored.filter((s) => s.score > 0);
  if (nonZero.length === 0) {
    return prisma.movie.findMany({
      where: { ...where, id: { notIn: watchedIds } },
      orderBy: { views: "desc" },
      take,
    });
  }

  return nonZero.slice(0, take).map((s) => s.m);
}

/** Views-og'irlikli tasodifiy kino: top-N hovuz ichidan JS weighted pick. */
export async function weightedRandomMovie(ctx: MyContext): Promise<Movie | null> {
  const where = await premiumFilter(ctx);
  const uid = ctx.from?.id;

  // Ko'rilgan kinolar chiqarib tashlanadi — /random bir xil kinoni qayta
  // beravermasin. Barchasi ko'rilgan bo'lsa (yoki admin bo'lsa) hovuz to'liq.
  let exclude: { movieId: number | null }[] = [];
  if (uid && !isAdmin(uid)) {
    exclude = await prisma.watchEvent.findMany({
      where: { userId: BigInt(uid), movieId: { not: null } },
      select: { movieId: true },
      distinct: ["movieId"],
    });
  }
  const watchedIds = new Set(exclude.map((e) => e.movieId!).filter((id): id is number => id !== null));

  let pool = await prisma.movie.findMany({
    where: { ...where, id: watchedIds.size ? { notIn: [...watchedIds] } : undefined },
    orderBy: { views: "desc" },
    take: 100,
    select: { id: true, views: true },
  });
  // Barchasi ko'rilgan — bo'sh qaytarmasdan, to'liq hovuzga qaytamiz
  // (0-views kino ham imkoniyatga ega bo'lsin).
  if (pool.length === 0) {
    pool = await prisma.movie.findMany({
      where,
      orderBy: { views: "desc" },
      take: 100,
      select: { id: true, views: true },
    });
  }
  if (pool.length === 0) return null;

  // Og'irlik = 1 + views (0-views kino ham imkoniyatga ega bo'lsin).
  // Katta views'lar orasidagi farqni yumshatish uchun log-scaled og'irlik
  // ishlatilmaydi — bu bot uchun top-views adolatliligi kifoya.
  const weights = pool.map((m) => 1 + m.views);
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  let picked = pool[pool.length - 1];
  for (let i = 0; i < pool.length; i++) {
    r -= weights[i];
    if (r <= 0) {
      picked = pool[i];
      break;
    }
  }

  return prisma.movie.findUnique({ where: { id: picked.id } });
}
