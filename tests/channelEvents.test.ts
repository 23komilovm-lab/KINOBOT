import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * channelEvents — atomik join/leave yozish (channel_members snapshot +
 * append-only channel_events). Amaldagi DB mock: tranzaksiya ichidagi amallarni
 * xotiralik tasvirda bajaradi — snapshot upsert, atributsiya oynasi (30 daqiqa),
 * `bot` source-ni pastga tushirmaslik, race → bitta yozuv.
 */

type Ev = {
  id: number;
  channelId: bigint;
  userId: bigint;
  type: string;
  source: string | null;
  date: Date;
};
const events: Ev[] = [];
let nextId = 1;
const members = new Map<string, { source: string; leftAt: Date | null }>();
const key = (cid: bigint, uid: bigint) => `${cid}:${uid}`;

vi.mock("../src/prisma.js", () => ({
  prisma: { $transaction: vi.fn() },
}));

import { recordChannelJoin, recordChannelLeave } from "../src/utils/channelEvents.js";
import { prisma } from "../src/prisma.js";

const $transaction = prisma.$transaction as unknown as ReturnType<typeof vi.fn>;

// Event log + snapshot uchun xotiralik DB. `$executeRaw` upsert'i Postgres
// row-lock'ini modellashtiradi (per-key mutex): ikkinchi parallel tranzaksiya
// birinchisi COMMIT qilmaguncha kutadi, keyin uning yozgan event'ini oynada
// topadi → dublikat yozuv yaratilmaydi. Aynan shu serializatsiya real race'ni
// hal qiladi (Railway multi-instance'da ham DB darajasida).
const locks = new Map<string, Promise<void>>();

const dbMock = {
  channelEvent: {
    findFirst: async (args: {
      where: { channelId: bigint; userId: bigint; type: string; date?: { gte?: Date } };
    }) => {
      const gte = args.where.date?.gte?.getTime() ?? -Infinity;
      return (
        events
          .filter(
            (e) =>
              e.type === "join" &&
              e.channelId === args.where.channelId &&
              e.userId === args.where.userId &&
              e.date.getTime() >= gte
          )
          .sort((a, b) => b.date.getTime() - a.date.getTime() || b.id - a.id)[0] ?? null
      );
    },
    create: async (args: {
      data: { channelId: bigint; userId: bigint; type: string; source: string };
    }) => {
      const ev: Ev = { id: nextId++, date: new Date(), ...args.data };
      events.push(ev);
      return ev;
    },
    update: async (args: { where: { id: number }; data: { source?: string } }) => {
      const ev = events.find((e) => e.id === args.where.id);
      if (ev && args.data.source) ev.source = args.data.source;
      return ev;
    },
  },
  channelMember: {
    updateMany: async (args: {
      where: { channelId: bigint; userId: bigint; leftAt: null };
      data: { leftAt: Date };
    }) => {
      for (const [k, m] of members) {
        if (m.leftAt !== null) continue;
        const [cid, uid] = k.split(":");
        if (BigInt(cid) === args.where.channelId && BigInt(uid) === args.where.userId) {
          m.leftAt = args.data.leftAt;
        }
      }
      return { count: 0 };
    },
  },
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-12T10:00:00.000Z"));
  events.length = 0;
  nextId = 1;
  members.clear();
  locks.clear();

  $transaction.mockImplementation(async (fn: (t: unknown) => Promise<unknown>) => {
    // Row-lock tranzaksiya darajasida ushlanadi: birinchi $executeRaw chaqiruvida
    // kalit aniqlanadi, fn tugagach (commit) bo'shatiladi.
    let rowKey: string | null = null;
    let releaseLock: (() => void) | undefined;

    const tx = {
      // INSERT ... ON CONFLICT upsert — channel_events emas, snapshot jadval.
      $executeRaw: async (...args: unknown[]) => {
        const [, channelId, userId] = args as [TemplateStringsArray, bigint, bigint];
        if (!rowKey) {
          rowKey = key(channelId, userId);
          const prev = locks.get(rowKey) ?? Promise.resolve();
          let r!: () => void;
          locks.set(rowKey, new Promise<void>((res) => (r = res)));
          releaseLock = r;
          await prev; // old egasi commit qilmaguncha kutadi
        }
        const source = args[3] as string;
        const k = key(channelId, userId);
        const prevM = members.get(k);
        members.set(k, {
          // source 'bot' bo'lsa 'bot' qoladi — bir marta bot = doim bot
          source: prevM?.source === "bot" ? "bot" : source,
          leftAt: null,
        });
      },
      ...dbMock,
    };

    await fn(tx);
    releaseLock?.(); // commit — navbatdagi yozuvchi davom etishi mumkin
  });
});

afterEach(() => {
  vi.useRealTimers();
});

const C = 123n;
const U = 456;

describe("recordChannelJoin", () => {
  it("yangi qo'shilish: snapshot yozadi + join event yaratadi", async () => {
    await recordChannelJoin(C, U, "unknown");

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ channelId: C, userId: BigInt(U), type: "join", source: "unknown" });
    const m = members.get(key(C, BigInt(U)));
    expect(m?.source).toBe("unknown");
    expect(m?.leftAt).toBeNull();
  });

  it("30 daqiqa ichida qayta join dublikat YARATMAYDI — mavjud event'ga bot belgilanadi", async () => {
    await recordChannelJoin(C, U, "link");
    vi.advanceTimersByTime(10 * 60 * 1000);
    await recordChannelJoin(C, U, "bot");

    expect(events).toHaveLength(1);
    expect(events[0].source).toBe("bot");
    expect(members.get(key(C, BigInt(U)))?.source).toBe("bot");
  });

  it("`bot` source pastga tushirilmaydi — keyingi organik join ham 'bot' qoldiradi", async () => {
    await recordChannelJoin(C, U, "bot");
    await recordChannelJoin(C, U, "link");

    expect(events).toHaveLength(1);
    expect(events[0].source).toBe("bot");
  });

  it("30 daqiqadan keyingi qayta qo'shilish yangi event yaratadi (qayta-join saqlanadi)", async () => {
    await recordChannelJoin(C, U, "link");
    vi.advanceTimersByTime(31 * 60 * 1000);
    await recordChannelJoin(C, U, "link");

    expect(events).toHaveLength(2);
    expect(events.every((e) => e.type === "join")).toBe(true);
  });

  it("ikki parallel join (chat_member va sub:check) → bitta event — serializatsiya", async () => {
    await Promise.all([recordChannelJoin(C, U, "bot"), recordChannelJoin(C, U, "unknown")]);

    // Ikkinchisi birinchi yozgan event'ni oynada topadi va faqat source'ni ko'taradi.
    expect(events).toHaveLength(1);
    expect(events[0].source).toBe("bot");
  });

  it("DB xatosi yutiladi — bot ishlashda davom etadi", async () => {
    $transaction.mockRejectedValueOnce(new Error("db down"));
    await expect(recordChannelJoin(C, U, "bot")).resolves.toBeUndefined();
    expect(events).toHaveLength(0);
  });
});

describe("recordChannelLeave", () => {
  it("leave event yozadi va snapshot leftAt ni o'rnatadi", async () => {
    await recordChannelJoin(C, U, "bot");
    await recordChannelLeave(C, U);

    expect(events).toHaveLength(2);
    expect(events[1].type).toBe("leave");
    const m = members.get(key(C, BigInt(U)));
    expect(m?.leftAt).not.toBeNull();
  });

  it("a'zo bo'lmagan chiqish — leftAt o'zgarmaydi, lekin leave event yoziladi", async () => {
    await recordChannelLeave(C, U);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("leave");
    expect(members.size).toBe(0);
  });
});