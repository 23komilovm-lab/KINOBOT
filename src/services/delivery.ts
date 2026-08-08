import { prisma } from "../prisma.js";
import { isAdmin } from "../config.js";
import {
  checkContentAccessResult,
  countContentRequest,
  type AccessReason,
  type AccessResult,
} from "../utils/access.js";
import { sendEpisode, sendMovie } from "./media.js";
import { sendSerialSeasons } from "../handlers/serialView.js";
import { confirmReferral } from "../utils/referral.js";
import { recordWatch } from "./recommend.js";
import { saveProgress } from "./serialProgress.js";
import { log } from "../utils/logger.js";
import type { MyContext } from "../types.js";
import type { Movie, Serial, Episode } from "@prisma/client";

/**
 * KVOTA UNIFIKATSIYASI (D3) — barcha kontent yetkazish yo'llari shu moduldan
 * o'tadi: pre-gate (obuna → bepul limit) → premium gate → send (try/catch) →
 * faqat muvaffaqiyatda count + views. Shunda hech bir yo'l kvotani chetlab
 * o'tolmaydi yoki jimgina muvaffaqiyatsizlikka uchramaydi.
 *
 * `ok:false` bo'lsa bloklovchi xabar (obuna/premium taklifi) allaqachon
 * ko'rsatilgan. `reason="sub"` bo'lsa pendingCode saqlanadi — foydalanuvchi
 * obuna bo'lgach "Tekshirish" tugmasi kodni qayta yetkazadi.
 */
export interface DeliverResult {
  /** Gate o'tdimi? false — bloklovchi xabar ko'rsatilgan. */
  ok: boolean;
  reason: AccessReason;
  /** Kontent haqiqatan yetkazildimi (send muvaffaqiyatli). */
  delivered: boolean;
  /**
   * Kod/ID bazada TOPILGANMI. `delivered:false` va `found:true` = topildi, lekin
   * yetkazilmadi (premium taklifi ko'rsatilgan / send xatosi). Chaqiruvchi buni
   * "topilmadi" deb talqin qilmasligi kerak (search.ts'dagi yolg'on xabar bug'i).
   */
  found: boolean;
}

function storePendingCode(ctx: MyContext, code: number): void {
  ctx.session.scratch = { ...(ctx.session.scratch ?? {}), pendingCode: code };
}

/**
 * Pre-gate. Obunaga bloklangan bo'lsa va `codeForPending` berilsa — kodni
 * eslab qolamiz (sub:check qayta yetkazadi). "quota"/"premium" da kod
 * saqlanmaydi — premium taklifi ko'rsatilgan, o'sha oqim o'z ishini qiladi.
 */
async function gate(ctx: MyContext, codeForPending?: number): Promise<AccessResult> {
  const res = await checkContentAccessResult(ctx, false);
  if (!res.ok && res.reason === "sub" && codeForPending !== undefined) {
    storePendingCode(ctx, codeForPending);
  }
  return res;
}

/** Kino yetkazish — to'liq gate + count. Views sendMovie ichida (muvaffaqiyatda). */
export async function deliverMovie(ctx: MyContext, movie: Movie): Promise<DeliverResult> {
  const g = await gate(ctx, movie.code);
  if (!g.ok) return { ok: false, reason: g.reason, delivered: false, found: true };

  if (!isAdmin(ctx.from!.id)) await confirmReferral(ctx, ctx.from!.id);
  const sent = await sendMovie(ctx, movie);
  if (sent) {
    await countContentRequest(ctx);
    await recordWatch(ctx, { movieId: movie.id, genre: movie.genre });
  }
  return { ok: true, reason: "ok", delivered: sent, found: true };
}

/** Serial sezonlar ro'yxatini yetkazish — gate bor, lekin hisob YO'Q (ro'yxat). */
export async function deliverSerialSeasons(
  ctx: MyContext,
  serialId: number
): Promise<DeliverResult> {
  const serial = await prisma.serial.findUnique({ where: { id: serialId } });
  if (!serial) return { ok: true, reason: "ok", delivered: false, found: false };

  const g = await gate(ctx, serial.code);
  if (!g.ok) return { ok: false, reason: g.reason, delivered: false, found: true };

  if (!isAdmin(ctx.from!.id)) await confirmReferral(ctx, ctx.from!.id);
  await sendSerialSeasons(ctx, serial.id);
  return { ok: true, reason: "ok", delivered: true, found: true };
}

/** Serial episodini yetkazish — gate + count + views (bitta so'rov = bitta hisob). */
export async function deliverEpisode(
  ctx: MyContext,
  episode: Episode & { season: { number: number; serial: Serial } }
): Promise<DeliverResult> {
  // Episod uchun pendingCode saqlanmaydi (kod emas, bosib ochiladi)
  const g = await gate(ctx);
  if (!g.ok) return { ok: false, reason: g.reason, delivered: false, found: true };

  const serial = episode.season.serial;
  if (!isAdmin(ctx.from!.id)) await confirmReferral(ctx, ctx.from!.id);
  const sent = await sendEpisode(ctx, episode, serial, episode.season.number);
  if (sent) {
    await countContentRequest(ctx);
    // Serial views — FAQAT episod yetkazilganda (ro'yxat ko'rish hisoblanmaydi)
    await prisma.serial
      .update({
        where: { id: serial.id },
        data: { views: { increment: 1 } },
      })
      .catch((err) => {
        log("warn", "Serial views oshmadi", { serialId: serial.id, error: String(err) });
      });
    await recordWatch(ctx, { serialId: serial.id, genre: serial.genre });
    // "Davom etish" uchun progress — faqat muvaffaqiyatli yetkazilgach
    await saveProgress(ctx, { serialId: serial.id, episodeId: episode.id });
  }
  return { ok: true, reason: "ok", delivered: sent, found: true };
}

/** Kod bo'yicha kino YOKI serial — to'liq gate bilan (ilgari gate'siz edi). */
export async function deliverByCode(ctx: MyContext, code: number): Promise<DeliverResult> {
  const movie = await prisma.movie.findUnique({ where: { code } });
  if (movie) return deliverMovie(ctx, movie);
  const serial = await prisma.serial.findUnique({ where: { code } });
  if (serial) return deliverSerialSeasons(ctx, serial.id);
  return { ok: true, reason: "ok", delivered: false, found: false };
}
