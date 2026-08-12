import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getCachedMemberCount,
  clearMemberCount,
  clearAllMemberCounts,
} from "../src/services/memberCountCache.js";

/**
 * getChatMemberCount keshi — har kanal panalida jonli Telegram chaqiruvlari
 * rate-limit xavfini tug'diradi. TTL 10 daqiqa; "Yangilash" tugmasi `bypass`
 * bilan keshlab o'tib jonli qiymatni oladi.
 */

describe("memberCountCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearAllMemberCounts();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearAllMemberCounts();
  });

  it("TTL (10 daqiqa) ichida Telegram bir marta chaqiriladi", async () => {
    const api = { getChatMemberCount: vi.fn(async () => 150) };
    await getCachedMemberCount(api, 123n);
    await getCachedMemberCount(api, 123n);
    await getCachedMemberCount(api, 123n);
    expect(api.getChatMemberCount).toHaveBeenCalledTimes(1);
  });

  it("TTL o'tgandan keyin qayta chaqiradi", async () => {
    const api = { getChatMemberCount: vi.fn(async () => 150) };
    await getCachedMemberCount(api, 123n);
    vi.advanceTimersByTime(10 * 60 * 1000 + 1);
    await getCachedMemberCount(api, 123n);
    expect(api.getChatMemberCount).toHaveBeenCalledTimes(2);
  });

  it("clearMemberCount bitta kanalni tozalaydi, boshqasini tozalamaydi", async () => {
    const api = { getChatMemberCount: vi.fn(async () => 10) };
    await getCachedMemberCount(api, 111n);
    await getCachedMemberCount(api, 222n);
    clearMemberCount(111n);
    await getCachedMemberCount(api, 111n);
    await getCachedMemberCount(api, 222n);
    expect(api.getChatMemberCount).toHaveBeenCalledTimes(3);
  });

  it("turli kanallar alohida keshlanadi", async () => {
    const api = { getChatMemberCount: vi.fn(async () => 1) };
    await getCachedMemberCount(api, 111n);
    await getCachedMemberCount(api, 222n);
    await getCachedMemberCount(api, 111n);
    expect(api.getChatMemberCount).toHaveBeenCalledTimes(2);
  });

  it("Xato → null qaytaradi va keshlamaydi (keyingi chaqiruv qaytadan oladi)", async () => {
    const api = {
      getChatMemberCount: vi
        .fn()
        .mockRejectedValueOnce(new Error("rate limit"))
        .mockResolvedValue(5),
    };
    await expect(getCachedMemberCount(api, 123n)).resolves.toBeNull();
    await expect(getCachedMemberCount(api, 123n)).resolves.toBe(5);
    expect(api.getChatMemberCount).toHaveBeenCalledTimes(2);
  });

  it("bypass — keshlab o'tib jonli qiymatni oladi (Yangilash tugmasi)", async () => {
    const api = { getChatMemberCount: vi.fn(async () => 20) };
    await getCachedMemberCount(api, 123n);
    await getCachedMemberCount(api, 123n, { bypass: true });
    await getCachedMemberCount(api, 123n);
    expect(api.getChatMemberCount).toHaveBeenCalledTimes(2);
  });
});