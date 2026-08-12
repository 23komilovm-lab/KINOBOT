import { prisma } from "../prisma.js";
import { normalizeTitle } from "../utils/translit.js";

/**
 * AQLLI QIDIRUV — 3 bosqichli, katalogga mos.
 *
 * Eski yechim `title contains "%q%"` edi: B-tree indeks ishlamaydi (leading
 * wildcard), foydalanuvchi kiritgan `%`/`_` LIKE wildcard sifatida o'tib
 * xato/yomon natijalar berardi, kirill/lotin transkripsiya esa umuman yo'q edi.
 *
 * Yangi tartib (har bir bosqich oldingisidan ko'proq tolerant):
 * 1. `titleNorm contains normalizeTitle(q)` — kirill/lotin barcha variantlar.
 * 2. `title contains escapeLike(q)` — xom qator (titleNorm hali to'ldirilmagan
 *    qatorlar uchun xavfsizlik tarmog'i).
 * 3. pg_trgm similarity (`titleNorm % q`) — xatoli/kirill-lotin aralash yozuvda
 *    ham eng yaqin nomlarni topadi.
 *
 * 1+2 natijalari birlashtiriladi (takrorsiz); ikkalasi ham bo'sh bo'lsa — 3.
 */

export interface SearchHit {
  kind: "movie" | "serial";
  id: number;
  code: number;
  title: string;
  views: number;
}

/** LIKE wildcard'larini (% _ \) escape qiladi — foydalanuvchi kiritgan matnni xavfsiz qidiruvga aylantiradi. */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

type TitleFilter =
  | { titleNorm: { contains: string; mode: "insensitive" } }
  | { title: { contains: string; mode: "insensitive" } };

/** Ikkala jadvalda ham qidirib, birlashtirilgan natija qaytaradi. */
async function findBoth(filter: TitleFilter, take: number): Promise<SearchHit[]> {
  const [movies, serials] = await Promise.all([
    prisma.movie.findMany({
      where: filter,
      take,
      orderBy: { views: "desc" },
      select: { id: true, code: true, title: true, views: true },
    }),
    prisma.serial.findMany({
      where: filter,
      take,
      orderBy: { views: "desc" },
      select: { id: true, code: true, title: true, views: true },
    }),
  ]);
  return [
    ...movies.map((m): SearchHit => ({
      kind: "movie",
      id: m.id,
      code: m.code,
      title: m.title,
      views: m.views,
    })),
    ...serials.map((s): SearchHit => ({
      kind: "serial",
      id: s.id,
      code: s.code,
      title: s.title,
      views: s.views,
    })),
  ];
}

/**
 * pg_trgm similarity orqali fuzzy qidiruv.
 * Indeks `lower("titleNorm") gin_trgm_ops` — shuning uchun lower() ishlatiladi.
 *
 * Ikki tuzoq (2026-08-12 da prodda "column titlenorm does not exist" bergan):
 *  1. `titleNorm` QO'SHTIRNOQDA bo'lishi shart. Prisma ustunni camelCase qilib
 *     yaratgan, qo'shtirnoqsiz Postgres uni `titlenorm` ga tushiradi va topa olmaydi.
 *  2. ORDER BY UNION natijasining USTIDA turishi kerak: UNION'dan keyin
 *     ORDER BY faqat chiquvchi ustun nomini qabul qiladi, ifodani emas —
 *     shuning uchun `sim` ichki so'rovda hisoblanib, tashqarida saralanadi.
 */
async function findSimilar(term: string, take: number): Promise<SearchHit[]> {
  const rows = await prisma.$queryRaw<
    { kind: string; id: bigint; code: bigint; title: string; views: bigint }[]
  >`
    SELECT kind, id, code, title, views FROM (
      SELECT 'movie' AS kind, id, code, title, views,
             similarity(lower("titleNorm"), lower(${term})) AS sim
      FROM movies WHERE lower("titleNorm") % lower(${term})
      UNION ALL
      SELECT 'serial' AS kind, id, code, title, views,
             similarity(lower("titleNorm"), lower(${term})) AS sim
      FROM serials WHERE lower("titleNorm") % lower(${term})
    ) t
    ORDER BY sim DESC
    LIMIT ${take}
  `;
  return rows.map((r): SearchHit => ({
    kind: r.kind === "serial" ? "serial" : "movie",
    id: Number(r.id),
    code: Number(r.code),
    title: r.title,
    views: Number(r.views),
  }));
}

function dedupe(hits: SearchHit[]): SearchHit[] {
  const seen = new Set<string>();
  const out: SearchHit[] = [];
  for (const h of hits) {
    const key = `${h.kind}:${h.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

/**
 * Qidiruv. 2 ta harfdan kam so'rov → bo'sh natija (to'liq jadval skanini isrof qilmaymiz).
 */
export async function searchContent(query: string, take = 20): Promise<SearchHit[]> {
  const q = query.trim();
  if (q.length < 2) return [];

  const norm = normalizeTitle(q);

  const [byNorm, byRaw] = await Promise.all([
    norm.length >= 2
      ? findBoth({ titleNorm: { contains: norm, mode: "insensitive" } }, take)
      : Promise.resolve([] as SearchHit[]),
    findBoth({ title: { contains: escapeLike(q), mode: "insensitive" } }, take),
  ]);

  const merged = dedupe([...byNorm, ...byRaw]);
  if (merged.length) return merged;

  return findSimilar(norm || q, take);
}
