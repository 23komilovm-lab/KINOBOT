// ─────────────────────────────────────────────────────────────────────────────
// SANA ORALIG'I — O'zbekiston vaqti (UTC+5) bo'yicha
//
// Ilgari `new Date(y, m-1, d)` ishlatilardi — bu SERVER vaqt mintaqasiga bog'liq.
// Railway'da server UTC'da ishlaydi, admin esa Toshkent vaqtida o'ylaydi, natijada
// chegara kunlarida 5 soatlik siljish bo'lardi: masalan 01.08 ni tanlasa,
// 31.07 kuni soat 19:00–24:00 (UZT) da ro'yxatdan o'tganlar ham qo'shilib ketardi.
// ─────────────────────────────────────────────────────────────────────────────

const UZ_OFFSET_MS = 5 * 60 * 60 * 1000; // UTC+5, yozgi vaqt yo'q

export interface Ymd {
  y: number;
  m: number;
  d: number;
}

/** "DD.MM.YYYY" ni tekshirib ajratadi. 31.02.2026 kabi mavjud bo'lmagan sanalar rad etiladi. */
export function parseYmd(s: string): Ymd | null {
  const match = s.trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!match) return null;
  const d = Number(match[1]);
  const m = Number(match[2]);
  const y = Number(match[3]);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    return null;
  }
  return { y, m, d };
}

/** Shu kunning boshlanishi (Toshkent vaqti bilan 00:00:00) — UTC instant */
export function dayStartUz(p: Ymd): Date {
  return new Date(Date.UTC(p.y, p.m - 1, p.d) - UZ_OFFSET_MS);
}

/** Shu kunning oxiri (Toshkent vaqti bilan 23:59:59.999) — UTC instant */
export function dayEndUz(p: Ymd): Date {
  return new Date(Date.UTC(p.y, p.m - 1, p.d + 1) - UZ_OFFSET_MS - 1);
}

/** Ymd → "DD.MM.YYYY" (normallashtirilgan) */
export function formatYmd(p: Ymd): string {
  return `${String(p.d).padStart(2, "0")}.${String(p.m).padStart(2, "0")}.${p.y}`;
}

/** Ikki sana matnidan Prisma uchun `{ gte, lte }` oralig'i. Xato bo'lsa null. */
export function rangeFromStrings(fromStr: string, toStr: string): { gte: Date; lte: Date } | null {
  const from = parseYmd(fromStr);
  const to = parseYmd(toStr);
  if (!from || !to) return null;
  const gte = dayStartUz(from);
  const lte = dayEndUz(to);
  if (gte.getTime() > lte.getTime()) return null;
  return { gte, lte };
}

/** UTC instant'ni Toshkent vaqti bo'yicha "DD.MM.YYYY HH:mm" ko'rinishida */
export function formatUzDateTime(d: Date): string {
  const uz = new Date(d.getTime() + UZ_OFFSET_MS);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(uz.getUTCDate())}.${p(uz.getUTCMonth() + 1)}.${uz.getUTCFullYear()} ${p(uz.getUTCHours())}:${p(uz.getUTCMinutes())}`;
}