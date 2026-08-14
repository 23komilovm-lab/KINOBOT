import { describe, it, expect } from "vitest";
import {
  rememberPendingAction,
  takePendingAction,
  type PendingAction,
} from "../src/utils/pendingAction.js";
import type { MyContext } from "../src/types.js";

/**
 * KUTIB TURGAN AMAL — majburiy obuna bloklaganda "foydalanuvchi nima
 * so'ragan" degan yozuv. "Tekshirish" bosilgach qayta bajariladi.
 */

// Sof funksiyalar faqat `ctx.session.scratch` bilan ishlaydi.
function ctxWith(scratch: Record<string, unknown> = {}): MyContext {
  return { session: { scratch } } as unknown as MyContext;
}

describe("rememberPendingAction / takePendingAction", () => {
  it("saqlaydi va qaytaradi", () => {
    const ctx = ctxWith();
    rememberPendingAction(ctx, { kind: "search", query: "avatar" });
    expect(takePendingAction(ctx)).toEqual({ kind: "search", query: "avatar" });
  });

  it("O'QIGANDAN KEYIN O'CHIRADI — ikkinchi marta null", () => {
    // Aks holda amal sessiyada abadiy qolib, har "Tekshirish" da
    // takrorlanaverardi.
    const ctx = ctxWith();
    rememberPendingAction(ctx, { kind: "popular" });
    expect(takePendingAction(ctx)).toEqual({ kind: "popular" });
    expect(takePendingAction(ctx)).toBeNull();
  });

  it("hech narsa saqlanmagan bo'lsa null", () => {
    expect(takePendingAction(ctxWith())).toBeNull();
  });

  it("yangi amal eskisining ustiga yoziladi", () => {
    const ctx = ctxWith();
    rememberPendingAction(ctx, { kind: "code", code: 1 });
    rememberPendingAction(ctx, { kind: "code", code: 2 });
    expect(takePendingAction(ctx)).toEqual({ kind: "code", code: 2 });
  });

  it("boshqa scratch maydonlari saqlanib qoladi", () => {
    // Sessiya umumiy — AI tarixi, darvoza belgisi va boshqalar yo'qolmasin.
    const ctx = ctxWith({ aiHistory: [1, 2], pendingSubChannels: ["-100"] });
    rememberPendingAction(ctx, { kind: "random" });
    takePendingAction(ctx);
    expect(ctx.session.scratch).toMatchObject({
      aiHistory: [1, 2],
      pendingSubChannels: ["-100"],
    });
  });

  it("har bir amal turi to'g'ri saqlanadi", () => {
    const all: PendingAction[] = [
      { kind: "code", code: 42 },
      { kind: "search", query: "kino" },
      { kind: "ai" },
      { kind: "ai", seed: "jangari kino" },
      { kind: "popular" },
      { kind: "random" },
      { kind: "recommend" },
      { kind: "episode", episodeId: 7 },
    ];
    for (const a of all) {
      const ctx = ctxWith();
      rememberPendingAction(ctx, a);
      expect(takePendingAction(ctx)).toEqual(a);
    }
  });
});

describe("buzuq yozuvlarga chidamlilik", () => {
  // Deploy oralig'ida sessiyada eski formatdagi yozuv qolishi mumkin —
  // u `resumePendingAction` ni yiqitmasligi kerak.
  it("noma'lum kind — null", () => {
    expect(takePendingAction(ctxWith({ pendingAction: { kind: "boshqa" } }))).toBeNull();
  });

  it("kind yo'q — null", () => {
    expect(takePendingAction(ctxWith({ pendingAction: { code: 5 } }))).toBeNull();
  });

  it("code raqam emas — null", () => {
    expect(takePendingAction(ctxWith({ pendingAction: { kind: "code", code: "5" } }))).toBeNull();
  });

  it("search query'siz — null", () => {
    expect(takePendingAction(ctxWith({ pendingAction: { kind: "search" } }))).toBeNull();
  });

  it("episode id butun son emas — null", () => {
    expect(
      takePendingAction(ctxWith({ pendingAction: { kind: "episode", episodeId: 1.5 } }))
    ).toBeNull();
  });

  it("buzuq yozuv ham O'CHIRILADI — qayta-qayta urinilmasin", () => {
    const ctx = ctxWith({ pendingAction: { kind: "boshqa" } });
    takePendingAction(ctx);
    expect(ctx.session.scratch?.pendingAction).toBeUndefined();
  });
});
