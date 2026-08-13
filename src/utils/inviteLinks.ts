import { prisma } from "../prisma.js";
import { formatUzDateTime } from "./dateRange.js";

/**
 * TAKLIF HAVOLALARI REGISTRI VA HAVOLA KESIMIDAGI STATISTIKA.
 *
 * Muammo: "♻️ Yangi havola" bosilganda eski havola bekor qilinardi va uning
 * o'rniga yangisi yozilardi — statistikada esa ikkalasi bitta "bot orqali
 * qo'shilgan" raqamiga qo'shilib ketardi. Qaysi havola qancha odam olib
 * kelganini bilib bo'lmasdi.
 *
 * Yechim: har bir havola `channel_invite_links` da tirik qoladi (yangilansa
 * `isCurrent=false` + `revokedAt`), qo'shilish/zayifka yozuvlarida esa aynan
 * qaysi havola ishlatilgani saqlanadi. Statistika shu ustun bo'yicha guruhlanadi.
 */

/**
 * Havola kesimidagi kuzatuv shu migratsiyadan boshlab yozilyapti. Undan oldingi
 * qo'shilishlarda havola ma'lum emas (Telegram tarixni bermaydi) — ular panelda
 * alohida "havola aniqlanmagan" qatorida ko'rsatiladi.
 */
export const LINK_TRACKING_START = "13.08.2026";

/** Havola turi: darvoza tugmasi beradigan tracking havolasi yoki zaxira havola */
export type InviteLinkName = "bot_tracking" | "majburiy_obuna";

/**
 * Havolani registrga yozadi. Shu TURDAGI (name) oldingi joriy havola
 * `isCurrent=false` + `revokedAt` bilan belgilanadi, lekin O'CHIRILMAYDI —
 * uning statistikasi keyin ham ko'rinib turishi kerak.
 *
 * Idempotent: bir xil havola qayta berilsa yangi qator yaratilmaydi (havola
 * qo'lda qayta ulanishi mumkin).
 */
export async function registerInviteLink(
  channelId: bigint,
  link: string,
  name: InviteLinkName = "bot_tracking"
): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      // Shu turdagi oldingi joriy havolalarni "bekor qilingan" deb belgilaymiz.
      await tx.channelInviteLink.updateMany({
        where: { channelId, name, isCurrent: true, NOT: { link } },
        data: { isCurrent: false, revokedAt: new Date() },
      });

      const existing = await tx.channelInviteLink.findUnique({ where: { link } });
      if (existing) {
        // Qayta ulangan havola — tarixi (seq, createdAt) saqlanadi, faqat tiriladi.
        await tx.channelInviteLink.update({
          where: { link },
          data: { isCurrent: true, revokedAt: null, name },
        });
        return;
      }

      const last = await tx.channelInviteLink.aggregate({
        where: { channelId },
        _max: { seq: true },
      });
      await tx.channelInviteLink.create({
        data: { channelId, link, name, seq: (last._max.seq ?? 0) + 1, isCurrent: true },
      });
    });
  } catch (err) {
    // Registr statistika uchun — yozilmasa ham bot ishlashda davom etadi.
    console.warn(`[inviteLinks] registr yozilmadi chatId=${channelId}:`, (err as Error).message);
  }
}

/**
 * Havola registrda bo'lmasa qo'shadi, bo'lsa hech nima qilmaydi.
 *
 * Registr yozuvi transient xato bilan o'tkazib yuborilgan bo'lishi mumkin
 * (masalan havola yaratilgan payt DB tushib turgan). Panel ochilganda shu
 * teshik yopiladi — aks holda havola statistikasi "registrdan tashqari"
 * qatorida ko'rinardi.
 */
export async function ensureInviteLinkRegistered(
  channelId: bigint,
  link: string,
  name: InviteLinkName = "bot_tracking"
): Promise<void> {
  const existing = await prisma.channelInviteLink
    .findUnique({ where: { link }, select: { id: true } })
    .catch(() => null);
  if (existing) return;
  await registerInviteLink(channelId, link, name);
}

/** Havolani "bekor qilingan" deb belgilaydi (Telegram'da revoke qilingandan keyin) */
export async function markInviteLinkRevoked(link: string): Promise<void> {
  await prisma.channelInviteLink
    .updateMany({
      where: { link, revokedAt: null },
      data: { isCurrent: false, revokedAt: new Date() },
    })
    .catch(() => null);
}

/** Bitta havola bo'yicha yig'ma raqamlar */
export interface InviteLinkStatRow {
  /** Kanal ichidagi tartib raqami; registrda yo'q havola uchun null */
  seq: number | null;
  link: string;
  name: string | null;
  createdAt: Date | null;
  revokedAt: Date | null;
  isCurrent: boolean;
  /** Shu havola orqali qo'shilgan YAGONA odamlar (channel_events) */
  joined: number;
  /** Shundan hozir ham kanalda turganlar (channel_members snapshot) */
  members: number;
  /** So'rovli kanal: shu havola orqali kelgan zayifkalar */
  requests: number;
  reqApproved: number;
  reqPending: number;
}

export interface InviteLinkStats {
  rows: InviteLinkStatRow[];
  /** Havolasi ma'lum bo'lmagan bot-qo'shilishlar (kuzatuvdan oldingi yozuvlar) */
  unattributedJoins: number;
  /** Havolasi ma'lum bo'lmagan zayifkalar */
  unattributedRequests: number;
}

/**
 * Kanal bo'yicha havola kesimini yig'adi: registrdagi barcha havolalar +
 * registrda bo'lmagan, lekin hodisalarda uchragan havolalar (boshqa admin
 * yaratgan havolalar shu yerga tushadi).
 *
 * Tartib: joriy havola birinchi, keyin `seq` kamayish bo'yicha (yangi → eski),
 * registrda yo'q havolalar oxirida — qo'shilganlar soni bo'yicha.
 */
export async function collectInviteLinkStats(
  channelId: bigint,
  isRequestChannel: boolean
): Promise<InviteLinkStats> {
  const [registry, joinRows, memberRows, reqRows, unattr] = await Promise.all([
    prisma.channelInviteLink.findMany({ where: { channelId }, orderBy: { seq: "asc" } }),
    prisma.$queryRaw<{ link: string; n: number }[]>`
      SELECT "inviteLink" AS link, COUNT(DISTINCT "userId")::int AS n
      FROM "channel_events"
      WHERE "channelId" = ${channelId} AND "type" = 'join' AND "inviteLink" IS NOT NULL
      GROUP BY "inviteLink"`,
    prisma.$queryRaw<{ link: string; n: number }[]>`
      SELECT "inviteLink" AS link, COUNT(*)::int AS n
      FROM "channel_members"
      WHERE "channelId" = ${channelId} AND "leftAt" IS NULL AND "inviteLink" IS NOT NULL
      GROUP BY "inviteLink"`,
    isRequestChannel
      ? prisma.$queryRaw<{ link: string; n: number; approved: number; pending: number }[]>`
          SELECT "inviteLink" AS link,
                 COUNT(*)::int AS n,
                 COUNT(*) FILTER (WHERE "status" = 'approved')::int AS approved,
                 COUNT(*) FILTER (WHERE "status" = 'pending')::int AS pending
          FROM "join_requests"
          WHERE "channelId" = ${channelId} AND "inviteLink" IS NOT NULL
          GROUP BY "inviteLink"`
      : Promise.resolve([]),
    prisma.$queryRaw<{ joins: number; reqs: number }[]>`
      SELECT
        (SELECT COUNT(DISTINCT "userId")::int FROM "channel_events"
          WHERE "channelId" = ${channelId} AND "type" = 'join'
            AND "source" = 'bot' AND "inviteLink" IS NULL) AS joins,
        (SELECT COUNT(*)::int FROM "join_requests"
          WHERE "channelId" = ${channelId} AND "inviteLink" IS NULL) AS reqs`,
  ]);

  const joinMap = new Map(joinRows.map((r) => [r.link, r.n]));
  const memberMap = new Map(memberRows.map((r) => [r.link, r.n]));
  const reqMap = new Map(reqRows.map((r) => [r.link, r]));

  const rows: InviteLinkStatRow[] = registry.map((l) => ({
    seq: l.seq,
    link: l.link,
    name: l.name,
    createdAt: l.createdAt,
    revokedAt: l.revokedAt,
    isCurrent: l.isCurrent,
    joined: joinMap.get(l.link) ?? 0,
    members: memberMap.get(l.link) ?? 0,
    requests: reqMap.get(l.link)?.n ?? 0,
    reqApproved: reqMap.get(l.link)?.approved ?? 0,
    reqPending: reqMap.get(l.link)?.pending ?? 0,
  }));

  // Registrda yo'q havolalar (boshqa admin yaratgan yoki kuzatuvdan oldin
  // yaratilib, keyin ishlatilgan) — ular ham ko'rinishi kerak.
  const known = new Set(registry.map((l) => l.link));
  const extraLinks = new Set<string>();
  for (const l of [...joinMap.keys(), ...memberMap.keys(), ...reqMap.keys()]) {
    if (!known.has(l)) extraLinks.add(l);
  }
  for (const link of extraLinks) {
    rows.push({
      seq: null,
      link,
      name: null,
      createdAt: null,
      revokedAt: null,
      isCurrent: false,
      joined: joinMap.get(link) ?? 0,
      members: memberMap.get(link) ?? 0,
      requests: reqMap.get(link)?.n ?? 0,
      reqApproved: reqMap.get(link)?.approved ?? 0,
      reqPending: reqMap.get(link)?.pending ?? 0,
    });
  }

  return {
    rows: sortInviteLinkRows(rows),
    unattributedJoins: unattr[0]?.joins ?? 0,
    unattributedRequests: unattr[0]?.reqs ?? 0,
  };
}

/** Joriy havola tepada, keyin yangi → eski, registrsizlar oxirida (sof funksiya) */
export function sortInviteLinkRows(rows: InviteLinkStatRow[]): InviteLinkStatRow[] {
  return [...rows].sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    if ((a.seq === null) !== (b.seq === null)) return a.seq === null ? 1 : -1;
    if (a.seq !== null && b.seq !== null) return b.seq - a.seq;
    return b.joined - a.joined;
  });
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Telegram xabar chegarasiga sig'ishi uchun bir ekranda ko'rsatiladigan havolalar soni */
export const MAX_LINK_ROWS = 12;

const NAME_LABEL: Record<string, string> = {
  bot_tracking: "darvoza havolasi",
  majburiy_obuna: "zaxira havola",
};

/**
 * Havolalar kesimi panelini quradi — SOF funksiya (DB/Telegram'siz sinaladi).
 *
 * Har bir havola uchun: qo'shilgan yagona odamlar, shundan hozir a'zoda
 * turganlar, so'rovli kanalda esa zayifka soni. Havola bekor qilingan bo'lsa
 * ham qatori qoladi — "eski havola qancha olib kelgan" savolining javobi shu.
 */
export function buildInviteLinkPanel(
  channelTitle: string,
  isRequestChannel: boolean,
  s: InviteLinkStats
): string {
  const head = `🔗 <b>Havolalar bo'yicha statistika</b>\n` + `📢 <b>${esc(channelTitle)}</b>\n`;

  if (s.rows.length === 0 && s.unattributedJoins === 0 && s.unattributedRequests === 0) {
    return (
      head +
      `\nHali birorta havola yozilmagan.\n\n` +
      `<i>"♻️ Yangi havola" tugmasi bilan tracking havolasi yarating — shundan ` +
      `keyin har bir qo'shilish qaysi havola orqali kelgani yoziladi.</i>`
    );
  }

  const shown = s.rows.slice(0, MAX_LINK_ROWS);
  const blocks = shown.map((r) => {
    const num = r.seq === null ? "•" : `#${r.seq}`;
    const kind = r.name ? (NAME_LABEL[r.name] ?? r.name) : "registrdan tashqari";
    const state = r.isCurrent
      ? "🟢 JORIY"
      : r.revokedAt
        ? `🔴 Bekor qilingan · ${formatUzDateTime(r.revokedAt)}`
        : "⚪️ Eski";

    const period = r.createdAt ? `\n  🗓 Yaratilgan: ${formatUzDateTime(r.createdAt)}` : "";

    const reqLine = isRequestChannel
      ? `\n  📨 Zayifka: <b>${r.requests}</b> (⏳ ${r.reqPending} · ✅ ${r.reqApproved})`
      : "";

    return (
      `<b>${num} · ${state}</b> <i>(${kind})</i>${period}${reqLine}\n` +
      `  👤 Qo'shilgan: <b>${r.joined}</b> · Hozir a'zo: <b>${r.members}</b>\n` +
      `  <code>${esc(r.link)}</code>`
    );
  });

  const totalJoined = s.rows.reduce((a, r) => a + r.joined, 0);
  const totalMembers = s.rows.reduce((a, r) => a + r.members, 0);
  const totalReq = s.rows.reduce((a, r) => a + r.requests, 0);

  const more =
    s.rows.length > MAX_LINK_ROWS
      ? `\n\n<i>… va yana ${s.rows.length - MAX_LINK_ROWS} ta havola (kam ishlatilgan).</i>`
      : "";

  const unattrBlock =
    s.unattributedJoins > 0 || s.unattributedRequests > 0
      ? `\n\n❔ <b>Havola aniqlanmagan:</b>\n` +
        `  👤 Bot orqali qo'shilgan: <b>${s.unattributedJoins}</b>` +
        (isRequestChannel ? `\n  📨 Zayifka: <b>${s.unattributedRequests}</b>` : "") +
        `\n<i>Ikki sabab: (1) havola kesimi ${LINK_TRACKING_START} dan beri ` +
        `yozilyapti — undan oldingi qo'shilishlarda Telegram qaysi havola ` +
        `ishlatilganini aytmaydi; (2) odam havolasiz kirgan (ommaviy kanalga ` +
        `@username yoki qidiruv orqali).</i>`
      : "";

  const totals =
    `\n\n📊 <b>Havolalar jami:</b> qo'shilgan <b>${totalJoined}</b> · ` +
    `hozir a'zo <b>${totalMembers}</b>` +
    (isRequestChannel ? ` · zayifka <b>${totalReq}</b>` : "");

  return `${head}\n${blocks.join("\n\n")}${more}${unattrBlock}${totals}`;
}
