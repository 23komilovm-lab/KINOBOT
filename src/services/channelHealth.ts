import type { Api } from "grammy";
import type { Channel } from "@prisma/client";
import { prisma } from "../prisma.js";
import { getSetting, setSetting } from "../utils/settings.js";
import { formatError, log, notifyOwner } from "../utils/logger.js";
import { markInviteLinkRevoked, registerInviteLink } from "../utils/inviteLinks.js";

/**
 * KANAL SOG'LIG'I — jim nosozliklarni aniqlash.
 *
 * Uchta holat botni butunlay ishlamas qiladi va HECH QANDAY xato bermaydi:
 *  1. Bot kanaldan chiqarilgan / kanal o'chirilgan — `getChatMember` yiqiladi,
 *     `subscription.ts` uni `catch(() => null)` bilan yutadi va natijani
 *     "obuna emas" deb hisoblaydi. Ya'ni HAQIQIY a'zolar ham darvozada
 *     bloklanadi — bot hamma uchun ishlamay qoladi.
 *  2. Bot admin emas yoki "havola orqali taklif" huquqi yo'q — xuddi shunday.
 *  3. Tracking havolasi qo'lda bekor qilingan — darvoza tugmasi o'lik havolaga
 *     olib boradi, yangi foydalanuvchilar obuna bo'la olmaydi.
 *
 * Modul ularni davriy tekshiradi, egaga xabar beradi va 3-holatni O'ZI
 * TUZATADI (yangi havola yaratib).
 */

export type ChannelProblem = "no_access" | "not_admin" | "no_invite_right" | "link_dead";

export interface ChannelHealth {
  problems: ChannelProblem[];
  /** O'lik havola avtomatik almashtirildimi */
  healed: boolean;
  checkedAt: number;
}

export const PROBLEM_LABEL: Record<ChannelProblem, string> = {
  no_access: "kanalga kirib bo'lmayapti — o'chirilgan yoki bot chiqarilgan",
  not_admin: "bot admin emas — a'zolikni tekshira olmaydi, HAMMA bloklanadi",
  no_invite_right: "botda «havola orqali taklif qilish» huquqi yo'q",
  link_dead: "tracking havolasi o'lik — yangi foydalanuvchilar obuna bo'la olmaydi",
};

/** Sog'liq holati panelda ko'rsatish uchun keshda (sweep to'ldiradi) */
const healthCache = new Map<string, ChannelHealth>();

export function getCachedHealth(chatId: bigint): ChannelHealth | undefined {
  return healthCache.get(chatId.toString());
}

/** Muammolar ro'yxatini taqqoslash uchun barqaror satr */
function signature(problems: ChannelProblem[]): string {
  return [...problems].sort().join(",");
}

/**
 * Bitta kanalni tekshiradi. `autoHeal` — o'lik havolani yangisiga almashtirish.
 *
 * Tekshiruvlar ketma-ket: oldingisi yiqilsa keyingisi ma'nosiz bo'ladi
 * (masalan bot admin bo'lmasa havolani tahrirlay ham olmaydi va natija
 * "havola o'lik" deb yolg'on ko'rinardi).
 */
export async function checkChannelHealth(
  api: Api,
  ch: Channel,
  botId: number,
  opts: { autoHeal?: boolean } = {}
): Promise<ChannelHealth> {
  const problems: ChannelProblem[] = [];
  let healed = false;
  const chatId = Number(ch.chatId);

  const done = (): ChannelHealth => {
    const h: ChannelHealth = { problems, healed, checkedAt: Date.now() };
    healthCache.set(ch.chatId.toString(), h);
    return h;
  };

  // INSTAGRAM — sintetik chatId, Telegram API bilan tekshirib bo'lmaydi
  if (ch.type === "INSTAGRAM") return done();

  const chat = await api.getChat(chatId).catch(() => null);
  if (!chat) {
    problems.push("no_access");
    return done();
  }

  const me = await api.getChatMember(chatId, botId).catch(() => null);
  if (!me || (me.status !== "administrator" && me.status !== "creator")) {
    problems.push("not_admin");
    return done();
  }

  const canInvite = me.status === "creator" || me.can_invite_users === true;
  if (!canInvite) {
    problems.push("no_invite_right");
    return done();
  }

  // Havola tirikmi. `editChatInviteLink` faqat BOT yaratgan va TIRIK havolani
  // tahrirlaydi — bekor qilingan havolada xato qaytaradi, ya'ni bu ishonchli
  // tiriklik probasi (`ch:setlink` da egalik tekshiruvi sifatida ishlatiladi).
  //
  // DIQQAT: `creates_join_request` ni UZATISH SHART. Telegram ko'rsatilmagan
  // ixtiyoriy maydonlarni standart qiymatga qaytaradi — so'rovli kanalda uni
  // tushirib qoldirish havolani "tasdiqlashsiz" qilib qo'yadi va odamlar
  // navbatsiz kirib ketadi.
  if (!ch.botInviteLink) return done();

  const alive = await api
    .editChatInviteLink(chatId, ch.botInviteLink, {
      name: "bot_tracking",
      creates_join_request: ch.type === "REQUEST",
    })
    .then(() => true)
    .catch(() => false);

  if (alive) return done();

  problems.push("link_dead");
  if (!opts.autoHeal) return done();

  // AVTO-TUZATISH: yangi havola yaratamiz. Eskisi registrda "bekor qilingan"
  // bo'lib qoladi — statistikasi yo'qolmaydi.
  try {
    const link = await api.createChatInviteLink(chatId, {
      name: "bot_tracking",
      creates_join_request: ch.type === "REQUEST",
    });
    await markInviteLinkRevoked(ch.botInviteLink);
    await prisma.channel.update({
      where: { id: ch.id },
      data: { botInviteLink: link.invite_link },
    });
    await registerInviteLink(ch.chatId, link.invite_link, "bot_tracking");
    healed = true;
    log("warn", "Kanal havolasi o'lik edi — avtomatik almashtirildi", {
      chatId: ch.chatId.toString(),
      title: ch.title,
    });
  } catch (err) {
    log("error", "O'lik havolani almashtirib bo'lmadi", {
      chatId: ch.chatId.toString(),
      error: formatError(err),
    });
  }
  return done();
}

/**
 * Barcha faol kanallarni tekshiradi va HOLAT O'ZGARGANDA egaga xabar beradi.
 *
 * Takroriy xabar yubormaslik uchun oxirgi holat `Setting` jadvalida saqlanadi
 * (xotirada emas — Railway redeploy tez-tez bo'ladi va har safar bir xil
 * ogohlantirish yuborilib turardi).
 */
export async function runHealthSweep(
  api: Api,
  botId: number,
  opts: { autoHeal?: boolean } = { autoHeal: true }
): Promise<ChannelHealth[]> {
  const channels = await prisma.channel.findMany({
    where: { isActive: true, NOT: { type: "INSTAGRAM" } },
    orderBy: { sortOrder: "asc" },
  });

  const results: ChannelHealth[] = [];
  const broke: string[] = [];
  const fixed: string[] = [];

  for (const ch of channels) {
    const health = await checkChannelHealth(api, ch, botId, opts);
    results.push(health);

    const key = `chhealth:${ch.chatId}`;
    const prev = await getSetting(key, "");
    const now = signature(health.problems);
    if (prev === now) continue;
    await setSetting(key, now);

    if (health.problems.length > 0) {
      const lines = health.problems.map((p) => `   • ${PROBLEM_LABEL[p]}`).join("\n");
      broke.push(
        `📢 ${ch.title}\n${lines}` +
          (health.healed ? `\n   ✅ Havola avtomatik almashtirildi.` : "")
      );
    } else if (prev !== "") {
      fixed.push(`📢 ${ch.title}`);
    }
  }

  if (broke.length > 0) {
    await notifyOwner(
      `🚨 Kanal sog'ligi — muammo aniqlandi:\n\n${broke.join("\n\n")}\n\n` +
        `Bot admin emas yoki kanalga kira olmasa, majburiy obuna tekshiruvi ` +
        `HAMMA foydalanuvchini bloklaydi.`,
      "channel_health_broke"
    );
  }
  if (fixed.length > 0) {
    await notifyOwner(`✅ Kanal sog'ligi tiklandi:\n\n${fixed.join("\n")}`, "channel_health_fixed");
  }

  return results;
}

const SWEEP_INTERVAL_MS = 30 * 60 * 1000;
const FIRST_SWEEP_DELAY_MS = 60 * 1000;

/** Davriy tekshiruvni ishga tushiradi (main() dan chaqiriladi) */
export function startChannelHealthWatcher(api: Api, botId: number): void {
  const sweep = () => {
    runHealthSweep(api, botId, { autoHeal: true }).catch((e) => {
      log("error", "Kanal sog'ligi tekshiruvida xato", { error: formatError(e) });
    });
  };
  // Startdan keyin darhol emas — bot to'liq ko'tarilib olsin
  setTimeout(sweep, FIRST_SWEEP_DELAY_MS).unref?.();
  setInterval(sweep, SWEEP_INTERVAL_MS).unref?.();
  log("info", "Kanal sog'ligi kuzatuvchisi yoqildi", {
    intervalMin: SWEEP_INTERVAL_MS / 60000,
  });
}
