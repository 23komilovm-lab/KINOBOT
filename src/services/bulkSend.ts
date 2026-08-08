import { GrammyError, HttpError } from "grammy";
import { prisma } from "../prisma.js";

// ─────────────────────────────────────────────────────────────────────────────
// OMMAVIY XABAR YUBORISH — umumiy dvigatel
// broadcast.ts, funnel.ts, aiAdmin.ts va premiumExpiry.ts shu yerdan foydalanadi.
// ─────────────────────────────────────────────────────────────────────────────

const MIN_INTERVAL_MS = 50; // ~20 xabar/sekund (Telegram amaliy chegarasi ~30)
const PROGRESS_INTERVAL_MS = 4_000; // holat xabari shu oraliqda yangilanadi (~15 tahrir/daqiqa)
const MAX_ATTEMPTS = 3; // vaqtinchalik xatolar uchun urinishlar soni
const MAX_RETRY_AFTER_S = 60; // 429 dagi retry_after uchun yuqori chegara
const ABORT_AFTER_CONSECUTIVE = 25; // ketma-ket shuncha "vaqtinchalik" xato bo'lsa to'xtaymiz
const BLOCKED_FLUSH = 500; // bloklanganlarni shuncha to'planganda bazaga yozamiz

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * blocked — foydalanuvchiga boshqa hech qachon yetkazib bo'lmaydi (bloklagan, o'chirgan hisob).
 * retry   — vaqtinchalik (429, tarmoq, 5xx): qayta urinamiz, foydalanuvchini bloklamaymiz.
 * fatal   — xabarning o'zi xato (buzuq HTML, noto'g'ri knopka, o'chirilgan shablon):
 *           hamma uchun bir xil takrorlanadi, shuning uchun butun yuborishni to'xtatamiz.
 */
export type FailKind = "blocked" | "retry" | "fatal";

export interface Classified {
  kind: FailKind;
  retryAfterMs: number;
  reason: string;
}

/** "Bu foydalanuvchiga umuman yetkazib bo'lmaydi" degan xato matnlari */
const BLOCKED_PATTERNS = [
  "bot was blocked by the user",
  "user is deactivated",
  "chat not found",
  "peer_id_invalid",
  "user_is_blocked",
  "chat_write_forbidden",
  "bot can't initiate conversation",
  "bot was kicked",
  "have no rights to send a message",
];

/**
 * Telegram xatosini tasniflaydi.
 * MUHIM: ilgari har qanday xato "foydalanuvchi bloklagan" deb hisoblanardi va
 * bitta tarmoq uzilishi odamni bazadan abadiy chiqarib yuborardi.
 */
export function classifyError(err: unknown): Classified {
  if (err instanceof GrammyError) {
    const code = err.error_code;
    const desc = (err.description ?? "").toLowerCase();

    if (code === 429) {
      const after = Math.min(err.parameters?.retry_after ?? 1, MAX_RETRY_AFTER_S);
      return { kind: "retry", retryAfterMs: after * 1000, reason: `flood limit (${after}s)` };
    }
    if (code >= 500) {
      return { kind: "retry", retryAfterMs: 2000, reason: `Telegram server xatosi (${code})` };
    }
    if (BLOCKED_PATTERNS.some((p) => desc.includes(p))) {
      return { kind: "blocked", retryAfterMs: 0, reason: err.description };
    }
    if (code === 403) {
      return { kind: "blocked", retryAfterMs: 0, reason: err.description };
    }
    // Qolgan 400 — xabar/klaviaturaning o'zida xato
    return { kind: "fatal", retryAfterMs: 0, reason: err.description };
  }

  if (err instanceof HttpError) {
    return { kind: "retry", retryAfterMs: 2000, reason: "tarmoq xatosi" };
  }

  const msg = err instanceof Error ? err.message : String(err);
  return { kind: "retry", retryAfterMs: 2000, reason: msg };
}

export interface BulkResult {
  total: number;
  processed: number;
  sent: number;
  blocked: number; // haqiqatan yetkazib bo'lmadi — isBlocked qilindi
  failed: number; // vaqtinchalik xato, keyingi safar qayta urinsa bo'ladi
  /** Vaqtinchalik xato bo'lganlar (qayta yuborish uchun; MAX_FAILED_IDS bilan cheklangan) */
  failedIds: bigint[];
  aborted: boolean;
  abortReason?: string;
}

/** Qayta yuborish uchun eslab qolinadigan maksimal id soni */
const MAX_FAILED_IDS = 500;

export interface BulkOptions {
  userIds: readonly (bigint | number)[];
  /** Bitta foydalanuvchiga yuborish. Xatoni YUTMANG — tasniflash uchun otilishi kerak. */
  send: (userId: number) => Promise<unknown>;
  /** Har `progressEvery` tadan keyin va oxirida chaqiriladi */
  onProgress?: (r: BulkResult) => Promise<void> | void;
  progressEvery?: number;
  /** true qaytarsa yuborish to'xtatiladi */
  isCancelled?: () => boolean;
}

async function flushBlocked(ids: bigint[]): Promise<void> {
  if (ids.length === 0) return;
  await prisma.user
    .updateMany({ where: { id: { in: ids } }, data: { isBlocked: true } })
    .catch(() => null);
  ids.length = 0;
}

/**
 * Ro'yxatdagi foydalanuvchilarga ketma-ket xabar yuboradi:
 *  · sur'atni cheklaydi (~20/sek) va 429 dagi `retry_after` ni hurmat qiladi
 *  · vaqtinchalik xatolarda 3 martagacha qayta uriladi
 *  · faqat haqiqatan yetkazib bo'lmaydiganlarni `isBlocked` qiladi (bitta updateMany bilan)
 *  · shablon xato bo'lsa (fatal) yoki ketma-ket 25 ta vaqtinchalik xato bo'lsa — to'xtaydi,
 *    ya'ni bitta buzuq xabar butun bazani bloklab qo'ymaydi
 */
export async function bulkSend(opts: BulkOptions): Promise<BulkResult> {
  const { userIds, send, onProgress, isCancelled } = opts;
  // Progress VAQT bo'yicha yangilanadi, son bo'yicha emas. Ilgari qadam
  // `total / 20` edi — 38 000 foydalanuvchida bu 1900 tadan bir marta, ya'ni
  // ~1.5 daqiqa jim turib keyin sakrash degani edi (qotib qolgandek ko'rinardi).
  const progressEvery = opts.progressEvery;

  const result: BulkResult = {
    total: userIds.length,
    processed: 0,
    sent: 0,
    blocked: 0,
    failed: 0,
    failedIds: [],
    aborted: false,
  };

  const blockedIds: bigint[] = [];
  let consecutiveFailures = 0;
  let lastCallAt = 0;
  let lastReportAt = Date.now();

  const pace = async () => {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastCallAt);
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
  };

  const report = async () => {
    if (onProgress) await onProgress({ ...result });
  };

  for (const raw of userIds) {
    if (isCancelled?.()) {
      result.aborted = true;
      result.abortReason = "admin to'xtatdi";
      break;
    }

    const uid = Number(raw);
    let delivered = false;
    let permanentlyBlocked = false;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await pace();
      try {
        await send(uid);
        delivered = true;
        break;
      } catch (err) {
        const c = classifyError(err);

        if (c.kind === "blocked") {
          permanentlyBlocked = true;
          break;
        }
        if (c.kind === "fatal") {
          result.aborted = true;
          result.abortReason = `xabar xato: ${c.reason}`;
          break;
        }
        if (attempt < MAX_ATTEMPTS) await sleep(c.retryAfterMs);
      }
    }

    if (result.aborted) break;

    result.processed++;
    if (delivered) {
      result.sent++;
      consecutiveFailures = 0;
    } else if (permanentlyBlocked) {
      result.blocked++;
      blockedIds.push(BigInt(uid));
      if (blockedIds.length >= BLOCKED_FLUSH) await flushBlocked(blockedIds);
      // Bloklangan foydalanuvchi kutilgan holat — "ketma-ket xato" deb hisoblanmaydi
    } else {
      result.failed++;
      if (result.failedIds.length < MAX_FAILED_IDS) result.failedIds.push(BigInt(uid));
      consecutiveFailures++;
      if (consecutiveFailures >= ABORT_AFTER_CONSECUTIVE) {
        result.aborted = true;
        result.abortReason = `ketma-ket ${consecutiveFailures} ta xato — yuborish to'xtatildi`;
        break;
      }
    }

    // Progress: har PROGRESS_INTERVAL_MS da bir marta (yoki chaqiruvchi aniq
    // qadam bergan bo'lsa — o'shanda). Katta bazada ham silliq yangilanadi.
    const byCount = progressEvery ? result.processed % progressEvery === 0 : false;
    if (byCount || Date.now() - lastReportAt >= PROGRESS_INTERVAL_MS) {
      lastReportAt = Date.now();
      await report();
    }
  }

  await flushBlocked(blockedIds);
  await report();
  return result;
}

/** Yakuniy hisobot matni (HTML) */
export function formatBulkResult(r: BulkResult): string {
  const lines = [`✅ Yuborildi: <b>${r.sent}</b>`, `🚫 Bloklagan/o'chirgan: <b>${r.blocked}</b>`];
  if (r.failed > 0) lines.push(`⚠️ Vaqtinchalik xato: <b>${r.failed}</b>`);
  if (r.aborted) {
    lines.push(``, `⛔️ <b>To'xtatildi:</b> ${r.abortReason}`);
    lines.push(`<i>${r.processed} / ${r.total} ta ko'rib chiqildi.</i>`);
  }
  return lines.join("\n");
}

// ─── Bir vaqtda faqat bitta ommaviy yuborish ─────────────────────────────────
// Webhook rejimida Telegram javob kutmay update'ni qayta yuborishi mumkin —
// bu qulf ikkinchi marta yuborilib ketishining oldini oladi.

const locks = new Set<string>();
const cancelled = new Set<string>();

export function acquireBulkLock(key: string): boolean {
  if (locks.has(key)) return false;
  locks.add(key);
  cancelled.delete(key);
  return true;
}

export function releaseBulkLock(key: string): void {
  locks.delete(key);
  cancelled.delete(key);
}

export function isBulkRunning(key: string): boolean {
  return locks.has(key);
}

export function cancelBulk(key: string): void {
  if (locks.has(key)) cancelled.add(key);
}

export function isBulkCancelled(key: string): boolean {
  return cancelled.has(key);
}
