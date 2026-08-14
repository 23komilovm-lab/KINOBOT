import type { MyContext } from "../types.js";

/**
 * KUTIB TURGAN AMAL — majburiy obuna bloklaganda "foydalanuvchi nima
 * so'ragan" degan yozuv.
 *
 * Muammo: darvoza faqat kino KODINI eslab qolardi (`pendingCode`). Nom bilan
 * qidirgan, AI ni ochgan yoki tugma bosgan odam obuna bo'lgach hech narsa
 * olmasdi — "endi kod yuboring" xabari chiqib, so'rovini qaytadan yozishi
 * kerak edi. Nom bilan qidirish esa eng ko'p ishlatiladigan yo'l.
 *
 * Endi har bir bloklangan amal shu yerga yoziladi va "Tekshirish" bosilgach
 * `resumeAction.ts` uni qayta bajaradi.
 *
 * Bu modul ATAYLAB sof: faqat sessiyaga yozadi/o'qiydi va hech qanday
 * handler'ni import qilmaydi — aks holda `search → delivery → search` kabi
 * halqalar paydo bo'lardi. Qayta bajarish `services/resumeAction.ts` da.
 */
export type PendingAction =
  | { kind: "code"; code: number }
  | { kind: "search"; query: string }
  | { kind: "ai"; seed?: string }
  | { kind: "popular" }
  | { kind: "random" }
  | { kind: "recommend" }
  | { kind: "episode"; episodeId: number };

const KEY = "pendingAction";

/**
 * Amalni eslab qoladi. FAQAT majburiy obuna bloklaganda chaqirilishi kerak —
 * kvota/premium bloklaganda saqlash noto'g'ri bo'lardi: u yerda premium
 * taklifi ko'rsatiladi va o'sha oqim o'z ishini qiladi.
 */
export function rememberPendingAction(ctx: MyContext, action: PendingAction): void {
  ctx.session.scratch = { ...(ctx.session.scratch ?? {}), [KEY]: action };
}

/**
 * Amalni o'qiydi va DARHOL o'chiradi.
 *
 * O'chirish shart: qayta bajarish yana bloklansa (masalan obuna o'rtasida
 * bepul limit tugagan bo'lsa) o'sha oqim o'zi qayta saqlaydi. Aks holda amal
 * sessiyada abadiy qolib, har "Tekshirish" da takrorlanaverardi.
 */
export function takePendingAction(ctx: MyContext): PendingAction | null {
  const raw = ctx.session.scratch?.[KEY] as PendingAction | undefined;
  if (!raw) return null;
  delete ctx.session.scratch![KEY];
  return isValid(raw) ? raw : null;
}

/**
 * Sessiyada eskirgan yoki buzuq yozuv qolishi mumkin (deploy oralig'ida format
 * o'zgarsa) — shunday yozuv `resumeAction` ni yiqitmasligi kerak.
 */
function isValid(a: unknown): a is PendingAction {
  if (!a || typeof a !== "object") return false;
  const k = (a as { kind?: unknown }).kind;
  switch (k) {
    case "code":
      return Number.isInteger((a as { code?: unknown }).code);
    case "search":
      return typeof (a as { query?: unknown }).query === "string";
    case "episode":
      return Number.isInteger((a as { episodeId?: unknown }).episodeId);
    case "ai":
    case "popular":
    case "random":
    case "recommend":
      return true;
    default:
      return false;
  }
}
