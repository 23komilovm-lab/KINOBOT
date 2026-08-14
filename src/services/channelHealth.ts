import type { Api } from "grammy";
import type { Channel } from "@prisma/client";
import { prisma } from "../prisma.js";
import { getSetting, setSetting } from "../utils/settings.js";
import { formatError, log, notifyOwner } from "../utils/logger.js";

/**
 * KANAL SOG'LIGI — jim nosozliklarni aniqlash va DARVOZANI HIMOYA QILISH.
 *
 * Uchta holat botni butunlay ishlamas qiladi va HECH QANDAY xato bermaydi:
 *  1. Bot kanaldan chiqarilgan / kanal o'chirilgan — `getChatMember` yiqiladi,
 *     `subscription.ts` uni `catch(() => null)` bilan yutadi va natijani
 *     "obuna emas" deb hisoblaydi. Ya'ni HAQIQIY a'zolar ham darvozada
 *     bloklanadi — bot hamma uchun ishlamay qoladi.
 *  2. Bot admin emas — xuddi shunday.
 *  3. Tracking havolasi o'lik — darvoza tugmasi ishlamaydi, yangi
 *     foydalanuvchi obuna bo'la olmaydi va o'tolmay qoladi.
 *
 * REAKSIYA: bot kanalga hech narsa YOZMAYDI. Buzuq kanalning majburiy
 * obunasini vaqtincha o'chiradi (darvozadan chiqaradi) va egaga xabar beradi.
 * Shunda bot ishlashda davom etadi, egasi esa xotirjam tuzatadi. Muammo
 * tuzalganda majburiy obuna avtomatik qayta yoqiladi — lekin FAQAT biz
 * o'chirgan bo'lsak (egasi qo'lda o'chirganini qayta yoqmaymiz).
 */

export type ChannelProblem =
  "no_access" | "not_admin" | "no_invite_right" | "link_dead" | "link_limited";

export interface ChannelHealth {
  problems: ChannelProblem[];
  /** Shu tekshiruvda majburiy obuna o'chirildimi */
  disabled: boolean;
  /** Muammo tuzalib, majburiy obuna qayta yoqildimi */
  reEnabled: boolean;
  checkedAt: number;
}

export const PROBLEM_LABEL: Record<ChannelProblem, string> = {
  no_access: "kanalga kirib bo'lmayapti — o'chirilgan yoki bot chiqarilgan",
  not_admin: "bot admin emas — a'zolikni tekshira olmaydi",
  no_invite_right: "botda «havola orqali taklif qilish» huquqi yo'q",
  link_dead: "tracking havolasi o'lik — yangi foydalanuvchilar obuna bo'la olmaydi",
  link_limited:
    "tracking havolasida A'ZO LIMITI yoki MUDDAT bor — to'lgach havola o'ladi va " +
    "darvoza jimgina buziladi. Telegram'da kanal → Taklif havolalari → shu " +
    "havolani tahrirlab limitni olib tashlang",
};

/**
 * Darvozani buzadigan muammolar. Ikkitasi ataylab ro'yxatda YO'Q:
 *
 * · `no_invite_right` — bot havola yarata olmasa ham a'zolikni tekshira oladi,
 *   ya'ni mavjud havola bilan darvoza ishlayveradi.
 * · `link_limited` — havola HALI ishlayapti, faqat limiti bor. Kanalni hozir
 *   o'chirish erta bo'lardi: ogohlantirish yuboriladi, limit to'lib havola
 *   o'lganda `link_dead` ishga tushadi va kanal o'sha payt chiqariladi.
 */
const BLOCKING: ChannelProblem[] = ["no_access", "not_admin", "link_dead"];

/**
 * Telegram'da taklif havolasini "limitsiz" qilishning YAGONA yo'li — maksimal
 * qiymat. `member_limit: 0` yuborilsa Telegram uni e'tiborsiz qoldiradi va eski
 * limit joyida qoladi (14.08.2026 da prodda tekshirilgan), `creates_join_request`
 * ni almashtirish esa vaqtinchalik: `false` ga qaytganda limit tiklanadi.
 */
export const UNLIMITED_MEMBER_LIMIT = 99_999;

/**
 * Havolada AMALDA cheklov bormi. `UNLIMITED_MEMBER_LIMIT` — bizning "limitsiz"
 * belgimiz, uni muammo deb hisoblamaymiz.
 */
export function isLimited(memberLimit?: number, expireDate?: number): boolean {
  if (expireDate) return true;
  return !!memberLimit && memberLimit < UNLIMITED_MEMBER_LIMIT;
}

/** Sog'liq holati panelda ko'rsatish uchun keshda (sweep to'ldiradi) */
const healthCache = new Map<string, ChannelHealth>();

export function getCachedHealth(chatId: bigint): ChannelHealth | undefined {
  return healthCache.get(chatId.toString());
}

/** Muammolar ro'yxatini taqqoslash uchun barqaror satr */
function signature(problems: ChannelProblem[]): string {
  return [...problems].sort().join(",");
}

const stateKey = (chatId: bigint) => `chhealth:${chatId}`;
/** "1" — majburiy obunani AYNAN sog'liq tekshiruvi o'chirgan */
const offKey = (chatId: bigint) => `chhealth:off:${chatId}`;

/**
 * Telegram so'rovini bir marta qayta uriniб ko'radi.
 *
 * Prodda `getUpdates` da 502 Bad Gateway va ECONNRESET uchraydi — o'tkinchi
 * tarmoq uzilishi. Bir martalik xato tufayli kanalni darvozadan chiqarish
 * mijozlarni bekorga yo'qotish demakdir, shuning uchun xulosa faqat ikki
 * marta ketma-ket muvaffaqiyatsizlikdan keyin chiqariladi.
 */
const RETRY_DELAY_MS = 3000;

async function tryTwice<T>(fn: () => Promise<T>, delayMs = RETRY_DELAY_MS): Promise<T | null> {
  const first = await fn().catch(() => null);
  if (first !== null) return first;
  if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  return fn().catch(() => null);
}

/**
 * Bitta kanalni tekshiradi. `act` — muammo topilsa majburiy obunani
 * o'chirish / tuzalganda qayta yoqish (sweep uchun `true`, paneldagi
 * qo'lda tekshiruv uchun `false`).
 *
 * Tekshiruvlar ketma-ket to'xtaydi: oldingisi yiqilsa keyingisi ma'nosiz
 * (masalan bot admin bo'lmasa havolani tahrirlay ham olmaydi va natija
 * "havola o'lik" degan yolg'on xulosa berardi).
 */
export async function checkChannelHealth(
  api: Api,
  ch: Channel,
  botId: number,
  opts: { act?: boolean; retryDelayMs?: number } = {}
): Promise<ChannelHealth> {
  const problems: ChannelProblem[] = [];
  const chatId = Number(ch.chatId);

  const finish = async (): Promise<ChannelHealth> => {
    let disabled = false;
    let reEnabled = false;

    if (opts.act) {
      const blocking = problems.some((p) => BLOCKING.includes(p));
      const weDisabled = (await getSetting(offKey(ch.chatId), "")) === "1";

      if (blocking && ch.isActive) {
        await prisma.channel.update({ where: { id: ch.id }, data: { isActive: false } });
        await setSetting(offKey(ch.chatId), "1");
        disabled = true;
      } else if (!blocking && weDisabled) {
        // Faqat O'ZIMIZ o'chirgan bo'lsak qayta yoqamiz — egasi qo'lda
        // o'chirgan kanalni tiklab yuborish uning qaroriga zid bo'lardi.
        await prisma.channel.update({ where: { id: ch.id }, data: { isActive: true } });
        await setSetting(offKey(ch.chatId), "");
        reEnabled = true;
      }
    }

    const h: ChannelHealth = { problems, disabled, reEnabled, checkedAt: Date.now() };
    healthCache.set(ch.chatId.toString(), h);
    return h;
  };

  // INSTAGRAM — sintetik chatId, Telegram API bilan tekshirib bo'lmaydi
  if (ch.type === "INSTAGRAM") return finish();

  const chat = await tryTwice(() => api.getChat(chatId), opts.retryDelayMs);
  if (!chat) {
    problems.push("no_access");
    return finish();
  }

  const me = await tryTwice(() => api.getChatMember(chatId, botId), opts.retryDelayMs);
  if (!me || (me.status !== "administrator" && me.status !== "creator")) {
    problems.push("not_admin");
    return finish();
  }

  if (!(me.status === "creator" || me.can_invite_users === true)) {
    problems.push("no_invite_right");
    return finish();
  }

  // HAVOLA HOLATI. Bu chaqiruv bir vaqtning o'zida tekshiradi VA tuzatadi:
  // `creates_join_request` bilan so'rovli kanal rejimini saqlaydi, `member_limit`
  // bilan esa tashqaridan qo'yilgan limitni tozalaydi (u bo'lmasa Telegram
  // limitni saqlangan past qiymatga QAYTARADI va havola avtomatik bekor
  // qilinadi — 14.08.2026 da aynan shu tekshiruvning o'zi limitni tiklab,
  // tuzatishni bekor qilgan edi).
  if (!ch.botInviteLink) return finish();

  const link = await tryTwice(
    () =>
      api.editChatInviteLink(chatId, ch.botInviteLink!, {
        name: "bot_tracking",
        creates_join_request: ch.type === "REQUEST",
        // Limitni HAR SAFAR tozalab turamiz — pastdagi izohga qarang.
        // So'rovli kanalda `member_limit` va `creates_join_request` o'zaro
        // istisno, shuning uchun u yerda uzatilmaydi.
        ...(ch.type === "REQUEST" ? {} : { member_limit: UNLIMITED_MEMBER_LIMIT }),
      }),
    opts.retryDelayMs
  );

  // Chaqiruvning O'ZI yiqilsa — havola bu botniki emas yoki chat yo'q.
  if (!link) {
    problems.push("link_dead");
    return finish();
  }

  // ⚠️ ENG MUHIM TEKSHIRUV. `editChatInviteLink` BEKOR QILINGAN havolada ham
  // `ok: true` qaytaradi — 14.08.2026 da prodda tekshirilgan. Ya'ni "chaqiruv
  // yiqilmadi = havola tirik" degan xulosa YOLG'ON edi: o'sha kuni beshtala
  // havola bekor qilingan bo'lsa ham tekshiruv hammasini "sog'lom" deb
  // ko'rsatgan va majburiy obuna jimgina buzilgan.
  //
  // Bekor qilingan havolani TIKLAB BO'LMAYDI — yangisi kerak.
  if (link.is_revoked) {
    problems.push("link_dead");
    return finish();
  }

  // Havolada a'zo limiti bo'lsa Telegram uni limit to'lgach AVTOMATIK bekor
  // qiladi — darvoza hech qanday xatosiz buziladi. Bot limitni hech qachon
  // qo'ymaydi (kodda `member_limit` faqat shu yerda, tozalash uchun), demak
  // uni tashqaridan qo'yishgan: 14.08.2026 da beshtala kanalda limit bor edi
  // (9, 6, 3, 4, 9) va u vaqt o'tishi bilan qayta qo'yilib turardi.
  //
  // Yuqoridagi chaqiruv limitni tozalaydi, shuning uchun bu yerga tushish —
  // tozalash ishlamagani (yoki muddat qo'yilgani) degani.
  if (isLimited(link.member_limit, link.expire_date)) problems.push("link_limited");
  return finish();
}

/**
 * Barcha kanallarni tekshiradi va HOLAT O'ZGARGANDA egaga xabar beradi.
 *
 * Takroriy xabar yubormaslik uchun oxirgi holat `Setting` jadvalida saqlanadi
 * (xotirada emas — Railway redeploy tez-tez bo'ladi va har safar bir xil
 * ogohlantirish yuborilib turardi).
 *
 * DIQQAT: o'chirilgan kanallar ham tekshiriladi — aks holda biz o'chirgan
 * kanal ro'yxatdan chiqib ketardi va hech qachon qayta yoqilmasdi.
 */
export async function runHealthSweep(
  api: Api,
  botId: number,
  opts: { act?: boolean; retryDelayMs?: number } = { act: true }
): Promise<ChannelHealth[]> {
  const channels = await prisma.channel.findMany({
    where: { NOT: { type: "INSTAGRAM" } },
    orderBy: { sortOrder: "asc" },
  });

  const results: ChannelHealth[] = [];
  const broke: string[] = [];
  const fixed: string[] = [];

  for (const ch of channels) {
    const health = await checkChannelHealth(api, ch, botId, opts);
    results.push(health);

    const prev = await getSetting(stateKey(ch.chatId), "");
    const now = signature(health.problems);
    if (prev === now && !health.disabled && !health.reEnabled) continue;
    await setSetting(stateKey(ch.chatId), now);

    if (health.problems.length > 0) {
      const lines = health.problems.map((p) => `   • ${PROBLEM_LABEL[p]}`).join("\n");
      broke.push(
        `📢 ${ch.title}\n${lines}` +
          (health.disabled
            ? `\n   ⛔️ Majburiy obuna VAQTINCHA O'CHIRILDI — bot ishlashda davom etadi.`
            : "")
      );
    } else if (prev !== "" || health.reEnabled) {
      fixed.push(`📢 ${ch.title}` + (health.reEnabled ? " — majburiy obuna qayta yoqildi" : ""));
    }
  }

  if (broke.length > 0) {
    await notifyOwner(
      `🚨 Kanal sog'ligi — muammo aniqlandi:\n\n${broke.join("\n\n")}\n\n` +
        `Tuzatgach majburiy obuna o'zi qayta yoqiladi (30 daqiqada bir tekshiriladi).`,
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
    runHealthSweep(api, botId, { act: true }).catch((e) => {
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
