import { describe, it, expect, beforeEach, vi } from "vitest";
import type { MyContext } from "../src/types.js";

/**
 * OBUNADAN KEYIN AVVALGI SO'ROVNI QAYTA BAJARISH.
 *
 * Har bir amal turi TO'G'RI yo'lga yuborilishi kerak — bittasi adashsa
 * foydalanuvchi obuna bo'lgach boshqa narsa oladi (masalan "tasodifiy kino"
 * so'rab, aniq bir kinoni). Handler'lar mock qilinadi: bu yerda sinaladigan
 * narsa — DISPATCHER, kontent yetkazish emas.
 */

const deliverByCode = vi.hoisted(() => vi.fn());
const deliverEpisode = vi.hoisted(() => vi.fn());
const deliverMovie = vi.hoisted(() => vi.fn());
const weightedRandomMovie = vi.hoisted(() => vi.fn());
const searchByName = vi.hoisted(() => vi.fn());
const renderPopular = vi.hoisted(() => vi.fn());
const renderList = vi.hoisted(() => vi.fn());
const enterAiChat = vi.hoisted(() => vi.fn());
const episodeFindUnique = vi.hoisted(() => vi.fn());

vi.mock("../src/prisma.js", () => ({
  prisma: { episode: { findUnique: episodeFindUnique } },
}));
vi.mock("../src/services/delivery.js", () => ({
  deliverByCode,
  deliverEpisode,
  deliverMovie,
}));
vi.mock("../src/services/recommend.js", () => ({ weightedRandomMovie }));
vi.mock("../src/handlers/search.js", () => ({ searchByName, renderPopular }));
vi.mock("../src/handlers/recommend.js", () => ({ renderList }));
vi.mock("../src/handlers/aiUser.js", () => ({ enterAiChat }));

import { resumePendingAction } from "../src/services/resumeAction.js";
import { rememberPendingAction, type PendingAction } from "../src/utils/pendingAction.js";

const reply = vi.fn();

function ctxFor(action?: PendingAction): MyContext {
  const ctx = { session: { scratch: {} }, reply } as unknown as MyContext;
  if (action) rememberPendingAction(ctx, action);
  return ctx;
}

beforeEach(() => {
  vi.clearAllMocks();
  deliverByCode.mockResolvedValue({ ok: true, delivered: true, found: true, reason: "ok" });
  deliverMovie.mockResolvedValue({ ok: true, delivered: true, found: true, reason: "ok" });
  deliverEpisode.mockResolvedValue({ ok: true, delivered: true, found: true, reason: "ok" });
});

describe("resumePendingAction — yo'naltirish", () => {
  it("amal yo'q bo'lsa hech narsa qilmaydi va false qaytaradi", async () => {
    await expect(resumePendingAction(ctxFor())).resolves.toBe(false);
    expect(deliverByCode).not.toHaveBeenCalled();
    expect(searchByName).not.toHaveBeenCalled();
  });

  it("code → deliverByCode", async () => {
    const ctx = ctxFor({ kind: "code", code: 42 });
    await expect(resumePendingAction(ctx)).resolves.toBe(true);
    expect(deliverByCode).toHaveBeenCalledWith(ctx, 42);
  });

  it("search → searchByName (foydalanuvchi yozgan so'rov bilan)", async () => {
    const ctx = ctxFor({ kind: "search", query: "avatar" });
    await expect(resumePendingAction(ctx)).resolves.toBe(true);
    expect(searchByName).toHaveBeenCalledWith(ctx, "avatar");
  });

  it("ai → enterAiChat, seed so'rov ham uzatiladi", async () => {
    const ctx = ctxFor({ kind: "ai", seed: "jangari kino" });
    await resumePendingAction(ctx);
    expect(enterAiChat).toHaveBeenCalledWith(ctx, "jangari kino");
  });

  it("ai (seedsiz) → enterAiChat undefined bilan", async () => {
    const ctx = ctxFor({ kind: "ai" });
    await resumePendingAction(ctx);
    expect(enterAiChat).toHaveBeenCalledWith(ctx, undefined);
  });

  it("popular → renderPopular birinchi sahifadan", async () => {
    const ctx = ctxFor({ kind: "popular" });
    await resumePendingAction(ctx);
    expect(renderPopular).toHaveBeenCalledWith(ctx, 0, false);
  });

  it("recommend → tavsiyalar ro'yxati", async () => {
    const ctx = ctxFor({ kind: "recommend" });
    await resumePendingAction(ctx);
    expect(renderList).toHaveBeenCalledWith(ctx, 0, false);
  });

  it("random → YANGI tasodifiy kino tanlanadi", async () => {
    // Muhim: foydalanuvchi aynan "tasodifiy" so'ragan. Agar bu yerda aniq kod
    // saqlangan bo'lsa, u obunadan keyin doim o'sha bitta kinoni olardi.
    weightedRandomMovie.mockResolvedValue({ id: 5, code: 100 });
    const ctx = ctxFor({ kind: "random" });
    await resumePendingAction(ctx);
    expect(weightedRandomMovie).toHaveBeenCalled();
    expect(deliverMovie).toHaveBeenCalledWith(ctx, { id: 5, code: 100 });
  });

  it("random — baza bo'sh bo'lsa xabar beradi, yiqilmaydi", async () => {
    weightedRandomMovie.mockResolvedValue(null);
    const ctx = ctxFor({ kind: "random" });
    await expect(resumePendingAction(ctx)).resolves.toBe(true);
    expect(reply).toHaveBeenCalled();
    expect(deliverMovie).not.toHaveBeenCalled();
  });

  it("episode → qism bazadan olinib yetkaziladi", async () => {
    const ep = { id: 7, season: { number: 1, serial: { id: 3 } } };
    episodeFindUnique.mockResolvedValue(ep);
    const ctx = ctxFor({ kind: "episode", episodeId: 7 });
    await expect(resumePendingAction(ctx)).resolves.toBe(true);
    expect(episodeFindUnique).toHaveBeenCalledWith({
      where: { id: 7 },
      include: { season: { include: { serial: true } } },
    });
    expect(deliverEpisode).toHaveBeenCalledWith(ctx, ep);
  });

  it("episode o'chirilgan bo'lsa — jimgina o'tkaziladi", async () => {
    episodeFindUnique.mockResolvedValue(null);
    const ctx = ctxFor({ kind: "episode", episodeId: 99 });
    await expect(resumePendingAction(ctx)).resolves.toBe(false);
    expect(deliverEpisode).not.toHaveBeenCalled();
  });

  it("kod bazadan topilmasa false — chaqiruvchi umumiy xabar bersin", async () => {
    deliverByCode.mockResolvedValue({ ok: true, delivered: false, found: false, reason: "ok" });
    await expect(resumePendingAction(ctxFor({ kind: "code", code: 1 }))).resolves.toBe(false);
  });

  it("amal BIR MARTA bajariladi — takroriy chaqiruv bo'sh", async () => {
    const ctx = ctxFor({ kind: "search", query: "avatar" });
    await resumePendingAction(ctx);
    await resumePendingAction(ctx);
    expect(searchByName).toHaveBeenCalledTimes(1);
  });
});
