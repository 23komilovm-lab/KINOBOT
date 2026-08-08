import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getCachedStat, clearStatsCache } from "../src/services/statsCache.js";

describe("statsCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearStatsCache();
  });

  afterEach(() => {
    vi.useRealTimers();
    clearStatsCache();
  });

  it("TTL ichida fetch bir marta chaqiriladi", async () => {
    let calls = 0;
    const fetch = vi.fn(async () => `v${++calls}`);
    await getCachedStat("k", fetch);
    await getCachedStat("k", fetch);
    await getCachedStat("k", fetch);
    expect(calls).toBe(1);
  });

  it("TTL o'tgandan keyin qayta hisoblaydi", async () => {
    let calls = 0;
    const fetch = vi.fn(async () => `v${++calls}`);
    await getCachedStat("k", fetch);
    vi.advanceTimersByTime(60_001);
    await getCachedStat("k", fetch);
    expect(calls).toBe(2);
  });

  it("clearStatsCache bitta kalitni tozalaydi, boshqasini tozalamaydi", async () => {
    const a = vi.fn(async () => "A");
    const b = vi.fn(async () => "B");
    await getCachedStat("a", a);
    await getCachedStat("b", b);
    clearStatsCache("a");
    await getCachedStat("a", a);
    await getCachedStat("b", b);
    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("turli kalitlar alohida keshlanadi", async () => {
    const a = vi.fn(async () => "A");
    const b = vi.fn(async () => "B");
    await getCachedStat("a", a);
    await getCachedStat("b", b);
    await getCachedStat("a", a);
    await getCachedStat("b", b);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});
