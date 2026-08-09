import { InlineKeyboard } from "grammy";
import { prisma } from "../prisma.js";
import { getBool, getSetting, KEYS } from "./settings.js";
import type { MyContext } from "../types.js";
import type { Channel } from "@prisma/client";

const SUBSCRIBED_STATUSES = ["creator", "administrator", "member", "restricted"];

// Kanal turini avtomatik yangilash uchun throttle (har kanal soatiga 1 marta)
const lastSync = new Map<string, number>();
const SYNC_TTL_MS = 60 * 60 * 1000;
// Kanal o'chirilsa lastSync yozuvi qolib ketmasin — hajmi kanallar sonidan
// oshganda eski yozuvlarni tozalab turamiz.
const LAST_SYNC_CAP = 50;
let lastSyncCleanAt = 0;

// A'zolik keshi — har content so'rovida (matn, inline, ...) har kanal uchun
// getChatMember chaqirilardi. Musbat natija uzoqroq (past xavf — premium holati
// ham real vaqtda qayta tekshirilmaydi), manfiy natija qisqa (haqiqiy a'zoni
// tez tuzatishi kerak) saqlanadi. "Tekshirish" tugmasi har doim bypass qiladi.
type MembershipEntry = { subscribed: boolean; expiresAt: number };
const membershipCache = new Map<string, MembershipEntry>(); // key: `${chatId}:${userId}`
const SUB_POSITIVE_TTL_MS = 10 * 60 * 1000;
const SUB_NEGATIVE_TTL_MS = 20 * 1000;
// Kesh o'lcham chegarasi — o'sish LRU bilan cheklanadi. Xatolar (000) qisqa
// TTL bilan o'z-o'zidan o'chadi, shuning uchun faqat tepa o'lcham muhim.
const MEMBERSHIP_CACHE_MAX = 2000;

/**
 * Kanal ma'lumotini Telegramdan qayta oladi va tur o'zgargan bo'lsa yangilaydi
 * (ommaviy↔maxfiy). REQUEST/INSTAGRAM tegilmaydi.
 */
async function maybeSyncChannel(ctx: MyContext, ch: Channel): Promise<Channel> {
  if (ch.type === "INSTAGRAM" || ch.type === "REQUEST") return ch;
  const key = ch.chatId.toString();
  if (Date.now() - (lastSync.get(key) ?? 0) < SYNC_TTL_MS) return ch;
  lastSync.set(key, Date.now());

  // O'lcham chegarasi: kanal o'chirilganda eski yozuvlar to'planib qolmasin.
  // Soatiga bir marta eskirgan (TTL o'tgan) yozuvlarni tozalaymiz.
  if (lastSync.size > LAST_SYNC_CAP && Date.now() - lastSyncCleanAt > SYNC_TTL_MS) {
    lastSyncCleanAt = Date.now();
    const now = Date.now();
    for (const [k, t] of lastSync) {
      if (now - t > SYNC_TTL_MS) lastSync.delete(k);
    }
  }

  const chat = await ctx.api.getChat(Number(ch.chatId)).catch(() => null);
  if (!chat) return ch;

  const uname = ("username" in chat ? chat.username : undefined) ?? null;
  const title = ("title" in chat ? chat.title : undefined) ?? ch.title;
  const newType = uname ? "PUBLIC" : "PRIVATE";

  if (uname === ch.username && newType === ch.type && title === ch.title) return ch;

  let inviteLink = ch.inviteLink;
  if (newType === "PRIVATE" && !inviteLink) {
    const link = await ctx.api.createChatInviteLink(Number(ch.chatId)).catch(() => null);
    inviteLink = link?.invite_link ?? ch.inviteLink;
  }

  const updated = await prisma.channel
    .update({
      where: { id: ch.id },
      data: { username: uname, title, type: newType, inviteLink },
    })
    .catch(() => null);
  return updated ?? ch;
}

/** Foydalanuvchi a'zo bo'lmagan (yoki so'rov yubormagan) kanallarni qaytaradi */
export async function getUnsubscribedChannels(
  ctx: MyContext,
  userId: number,
  opts?: { bypassCache?: boolean }
): Promise<Channel[]> {
  const raw = await prisma.channel.findMany({
    where: { isActive: true },
    orderBy: { sortOrder: "asc" },
  });
  if (raw.length === 0) return [];

  const results = await Promise.all(
    raw.map(async (ch0) => {
      const ch = await maybeSyncChannel(ctx, ch0);
      // Instagram: API orqali tekshirib bo'lmaydi — har doim ko'rsatiladi
      if (ch.type === "INSTAGRAM") return { channel: ch, isSubscribed: false };

      const cacheKey = `${ch.chatId}:${userId}`;
      const cached = !opts?.bypassCache ? membershipCache.get(cacheKey) : undefined;
      let isSub: boolean;
      if (cached && cached.expiresAt > Date.now()) {
        isSub = cached.subscribed;
      } else {
        const member = await ctx.api.getChatMember(Number(ch.chatId), userId).catch(() => null);
        isSub = !!(member && SUBSCRIBED_STATUSES.includes(member.status));
        membershipCache.set(cacheKey, {
          subscribed: isSub,
          expiresAt: Date.now() + (isSub ? SUB_POSITIVE_TTL_MS : SUB_NEGATIVE_TTL_MS),
        });
        // LRU eviction: Map ketma-ketligi o'rnatish tartibida — birinchi kalit
        // eng eski. O'lcham chegarasidan oshganda faqat bitta yozuvni chiqaramiz
        // (har qo'shishda bir marta, arzon operatsiya).
        if (membershipCache.size > MEMBERSHIP_CACHE_MAX) {
          const oldestKey = membershipCache.keys().next().value;
          if (oldestKey !== undefined) membershipCache.delete(oldestKey);
        }
      }

      if (isSub) {
        return { channel: ch, isSubscribed: true };
      }

      // So'rovli kanal: a'zo bo'lmasa ham PENDING so'rov yuborganini tekshirish.
      // "approved" holat hisobga olinmaydi — chunki tasdiqlangandan keyin kanaldan
      // chiqib ketgan bo'lishi mumkin, bunday holda qayta so'rov talab qilinadi.
      if (ch.type === "REQUEST") {
        const pending = await prisma.joinRequest.findUnique({
          where: {
            channelId_userId: {
              channelId: ch.chatId,
              userId: BigInt(userId),
            },
          },
        });
        if (pending?.status === "pending") return { channel: ch, isSubscribed: true };
      }

      return { channel: ch, isSubscribed: false };
    })
  );

  return results.filter((r) => !r.isSubscribed).map((r) => r.channel);
}

async function buildSubscriptionMarkup(channels: Channel[]): Promise<InlineKeyboard> {
  const checkText = await getSetting(KEYS.subCheckBtnText, "Tekshirish");
  const defLabel = await getSetting(KEYS.subChannelBtnLabel, "+ Kanalga obuna bo'lish");

  const kb = new InlineKeyboard();
  for (const ch of channels) {
    const url = channelUrl(ch);
    if (!url) continue;
    const label = ch.buttonLabel?.trim() || (ch.type === "INSTAGRAM" ? `📸 ${ch.title}` : defLabel);
    kb.url(label, url).row();
  }

  const hasTg = channels.some((c) => c.type !== "INSTAGRAM");
  if (hasTg) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (kb as any).inline_keyboard.push([
      {
        text: checkText,
        callback_data: "sub:check",
        icon_custom_emoji_id: "5861665979968262792",
      },
    ]);
  }

  // Premium tizimi yoqilgan bo'lsa — obunasiz foydalanish uchun premium taklifi
  if (await getBool(KEYS.premiumEnabled, false)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (kb as any).inline_keyboard.push([
      {
        text: "Premium obuna olish",
        callback_data: "prem:show",
        icon_custom_emoji_id: "5211179692496808774",
      },
    ]);
  }

  return kb;
}

const SUB_PROMPT_TEXT =
  `<b>Botdan foydalanish uchun obuna bo'ling:</b>\n\n` +
  `<i>Yoki majburiy obunaga hojat qoldirmasdan, cheksiz foydalanish uchun — Premium obuna oling. 👇</i>`;

/** Obuna so'rovi xabarini yuboradi */
export async function sendSubscriptionPrompt(ctx: MyContext, channels: Channel[]): Promise<void> {
  const kb = await buildSubscriptionMarkup(channels);
  await ctx.reply(SUB_PROMPT_TEXT, { reply_markup: kb });
}

/** Obuna so'rovi xabarini joriy (masalan, premium taklifidan qaytilgan) xabar ustiga tahrirlaydi */
export async function editSubscriptionPrompt(ctx: MyContext, channels: Channel[]): Promise<void> {
  const kb = await buildSubscriptionMarkup(channels);
  await ctx.editMessageText(SUB_PROMPT_TEXT, { reply_markup: kb }).catch(async () => {
    await ctx.reply(SUB_PROMPT_TEXT, { reply_markup: kb });
  });
}

export function channelUrl(ch: Channel): string | null {
  if (ch.type === "INSTAGRAM") return ch.inviteLink ?? null;
  if (ch.username) return `https://t.me/${ch.username.replace(/^@/, "")}`;
  if (ch.inviteLink) return ch.inviteLink;
  return null;
}

/** True qaytarsa — foydalanuvchi hamma Telegram kanalga a'zo (yoki kanal yo'q) */
export async function ensureSubscribed(ctx: MyContext, userId: number): Promise<boolean> {
  const notJoined = await getUnsubscribedChannels(ctx, userId);
  // Instagram kanallarini obunasiz ham o'tkazib yuboramiz (tekshirish imkonsiz)
  const blocking = notJoined.filter((c) => c.type !== "INSTAGRAM");
  if (blocking.length === 0) return true;
  await sendSubscriptionPrompt(ctx, notJoined);
  return false;
}
