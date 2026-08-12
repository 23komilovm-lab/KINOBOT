import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  todayUz,
  daysAgoStartUz,
  monthStartUz,
  dayStartUz,
  dayEndUz,
} from "../src/utils/dateRange.js";

/**
 * Toshkent vaqti (UTC+5, DST yo'q) yordamchilari — "Bugun"/"7 kun"/"30 kun"/
 * "bu oy" oynalari ADMIN o'ylagan kalendar kundan boshlanishi uchun.
 * Regression: eski versiyada `new Date(y, m-1, d)` server-vaqtiga bog'liq edi,
 * Railway'da (UTC) chegara kunlarida 5 soatlik siljish bo'lardi.
 */

const H = 60 * 60 * 1000;

describe("dateRange — Toshkent vaqti (UTC+5)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("todayUz: kechki Toshkent soatlarida ham Toshkent kunini qaytaradi (UTC kuni emas)", () => {
    // UTC 2026-08-11 19:30 = Toshkent 2026-08-12 00:30
    vi.setSystemTime(new Date("2026-08-11T19:30:00Z"));
    expect(todayUz()).toBe("2026-08-12");
    // UTC 2026-08-12 18:59 = Toshkent 2026-08-12 23:59 — shu kunning oxiri ham to'g'ri
    vi.setSystemTime(new Date("2026-08-12T18:59:00Z"));
    expect(todayUz()).toBe("2026-08-12");
  });

  it("daysAgoStartUz(0) — Toshkent bugungi kunning 00:00 (UTC instant, 5 soat orqaga)", () => {
    vi.setSystemTime(new Date("2026-08-11T19:30:00Z")); // Toshkent 08-12 00:30
    expect(daysAgoStartUz(0).toISOString()).toBe("2026-08-11T19:00:00.000Z");
  });

  it("kalendar-kun semantikasi: 7 kun = 6 kun oldin, 30 kun = 29 kun oldin (rolling emas)", () => {
    vi.setSystemTime(new Date("2026-08-12T12:00:00Z")); // Toshkent 08-12 17:00
    expect(daysAgoStartUz(6).toISOString()).toBe("2026-08-05T19:00:00.000Z");
    expect(daysAgoStartUz(29).toISOString()).toBe("2026-07-13T19:00:00.000Z");
  });

  it("monthStartUz — joriy oyning 1-kuni Toshkent 00:00", () => {
    vi.setSystemTime(new Date("2026-08-12T12:00:00Z"));
    expect(monthStartUz().toISOString()).toBe("2026-07-31T19:00:00.000Z");
  });

  it("dayStartUz/dayEndUz — bir kun davomiyligi (5-soat siljish regression)", () => {
    const d0 = dayStartUz({ y: 2026, m: 8, d: 12 });
    const d1 = dayEndUz({ y: 2026, m: 8, d: 12 });
    expect(d1.getTime() - d0.getTime()).toBe(24 * H - 1);
  });
});