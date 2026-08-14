import { InlineKeyboard } from "grammy";
import { prisma } from "../prisma.js";
import { getBool, getSetting, KEYS } from "./settings.js";
import { ATTRIB_WINDOW_MS, recordChannelJoin } from "./channelEvents.js";
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
 * Bitta (kanal, foydalanuvchi) uchun a'zolik keshini bekor qiladi.
 *
 * `chat_member` yangilanishida CHAQIRILISHI SHART. Musbat natija 10 daqiqa
 * keshlanadi — kesh tozalanmasa kanaldan chiqib ketgan odam o'sha vaqt
 * davomida darvozadan bemalol o'tib ketardi (14.08.2026 da prodda shu
 * aniqlandi). Telegram chiqishni darhol xabar qiladi, shuning uchun kesh
 * TTL'ni kutmasdan aynan o'sha lahzada bekor qilinadi.
 */
export function invalidateMembership(chatId: bigint | number, userId: number): void {
  membershipCache.delete(`${chatId}:${userId}`);
}

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

/**
 * Obuna tasdiqlanganda (sub:check) — qo'shilishni "bot orqali" deb belgilaydi.
 *
 * DIQQAT: yangi yozuv YARATILMAYDI. `chat_member` handleri o'sha qo'shilish uchun
 * allaqachon ChannelEvent yozgan — yana bittasini qo'shsak, har bir odam ikki
 * marta sanaladi. Shuning uchun oxirgi yozuvning manbasi yangilanadi.
 *
 * Telegram `invite_link` ni har doim ham yubormaydi (masalan ochiq kanalga
 * username orqali kirilsa), shuning uchun bu yo'l ishonchliroq: foydalanuvchi
 * bot darvozasidan o'tib, aynan shu kanalga endigina a'zo bo'ldi.
 */
export async function recordSubscriptionJoin(
  _ctx: MyContext,
  userId: number,
  channelId: bigint
): Promise<void> {
  // Serializatsiya va dublikat-himoyasi recordChannelJoin'da (snapshot upsert —
  // chat_member va sub:check parallel kelsa ham bitta yozuv). Bot darvozasi
  // tasdiqlagani uchun source = "bot".
  await recordChannelJoin(channelId, userId, "bot");
}

async function buildSubscriptionMarkup(channels: Channel[]): Promise<InlineKeyboard> {
  const checkText = await getSetting(KEYS.subCheckBtnText, "Tekshirish");
  const defLabel = await getSetting(KEYS.subChannelBtnLabel, "+ Kanalga obuna bo'lish");

  const kb = new InlineKeyboard();
  for (const ch of channels) {
    const url = channelUrl(ch);
    if (!url) continue;
    const label = ch.buttonLabel?.trim() || (ch.type === "INSTAGRAM" ? `📸 ${ch.title}` : defLabel);
    // To'g'ridan-to'g'ri URL tugma. Callback + answerCallbackQuery(url=...) ISHLAMAYDI:
    // Telegram u parametrda faqat o'yin havolasi yoki t.me/<bot>?start=... qabul qiladi,
    // kanal havolasi `URL_INVALID` beradi (2026-08-09 da prodda aynan shu yuz berdi).
    // Atributsiya `chat_member` yangilanishidagi `invite_link` orqali biliniladi.
    // DIQQAT: egasi o'z havolasini ulagan bo'lsa (`adminInviteLink`) u ustun
    // turadi va uni bot yaratmagani uchun qo'shilish "🔗 Havola" deb sanaladi,
    // "🤖 Bot orqali" emas — bu ataylab qilingan kelishuv (channelUrl izohi).
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
/**
 * Darvoza ko'rsatilgan paytda qaysi kanallar bloklayotganini sessiyaga yozamiz.
 * `sub:check` muvaffaqiyatli o'tganda shu ro'yxat "bot orqali qo'shilgan" deb
 * belgilanadi — URL tugma callback bermagani uchun boshqa ishonchli belgi yo'q.
 *
 * SO'ROVLI KANAL BU RO'YXATGA KIRMAYDI. Darvoza u yerda `pending` zayifkani
 * "obuna" deb qabul qiladi (ataylab — odam navbatda turib ham kontentga o'tadi),
 * lekin odam guruhga HALI KIRMAGAN. Uni "qo'shilgan" deb yozish statistikani
 * soxtalashtiradi: 2026-08-12 da Guruh 2k da odam zayifka yuborganidan 11
 * soniya keyin "a'zo" bo'lib yozilgan, zayifkasi esa hamon pending edi.
 * So'rovli kanalda haqiqiy qo'shilish faqat `chat_member` orqali biliniladi
 * (siz tasdiqlaganingizdan keyin), asosiy metrika esa — zayifka soni.
 */
export function rememberBlockingChannels(ctx: MyContext, channels: Channel[]): void {
  const ids = channels
    .filter((c) => c.type !== "INSTAGRAM" && c.type !== "REQUEST")
    .map((c) => c.chatId.toString());
  if (ids.length === 0) return;

  // RO'YXAT QISQARMAYDI. "Tekshirish" bosilganda darvoza qayta chiziladi va
  // unga faqat QOLGAN kanallar tushadi. Agar shu yerda ro'yxat almashtirilsa,
  // allaqachon qo'shilgan kanallar atributsiya ro'yxatidan tushib qolardi va
  // `attributePendingSubscriptions` ularni "bot" deb belgilamasdi.
  //
  // Shuning uchun sessiyadagi ro'yxat HALI YANGI bo'lsa — birlashtiriladi.
  // Eskirgan bo'lsa almashtiriladi: o'sha kanallar allaqachon atributsiya
  // oynasidan chiqib ketgan va ularni tiriltirish soxta "bot" yozuvi bo'lardi.
  const prev = ctx.session.scratch?.pendingSubChannels as string[] | undefined;
  const prevAt = ctx.session.scratch?.pendingSubAt as number | undefined;
  const prevFresh =
    Array.isArray(prev) && typeof prevAt === "number" && Date.now() - prevAt <= ATTRIB_WINDOW_MS;

  ctx.session.scratch = {
    ...(ctx.session.scratch ?? {}),
    pendingSubChannels: prevFresh ? [...new Set([...prev, ...ids])] : ids,
    // Yangilik shtampi: faqat oxirgi 30 daqiqada ko'rsatilgan darvoza atributsiya
    // qiladi. Eskirib qolgan sessiya (foydalanuvchi darvozani korib, organik
    // qo'shilgan) soxta "bot" yozuvini yaratmasin.
    pendingSubAt: Date.now(),
  };
}

export async function sendSubscriptionPrompt(ctx: MyContext, channels: Channel[]): Promise<void> {
  const kb = await buildSubscriptionMarkup(channels);
  rememberBlockingChannels(ctx, channels);
  await ctx.reply(SUB_PROMPT_TEXT, { reply_markup: kb });
}

/** Obuna so'rovi xabarini joriy (masalan, premium taklifidan qaytilgan) xabar ustiga tahrirlaydi */
export async function editSubscriptionPrompt(ctx: MyContext, channels: Channel[]): Promise<void> {
  const kb = await buildSubscriptionMarkup(channels);
  rememberBlockingChannels(ctx, channels);
  await ctx.editMessageText(SUB_PROMPT_TEXT, { reply_markup: kb }).catch(async () => {
    await ctx.reply(SUB_PROMPT_TEXT, { reply_markup: kb });
  });
}

/**
 * Darvoza tugmasi qaysi havolani beradi. Tartib MUHIM:
 *
 *  1. `adminInviteLink` — egasi "📎 Havolani ulash" orqali O'ZI ulagan havola.
 *     Eng ustun: u egasining nazoratida, Telegram'ning o'z statistikasida
 *     ko'rinadi va bot uni hech qachon almashtirmaydi.
 *     Narxi: Telegram boshqa admin yaratgan havola satrini niqoblaydi va
 *     `creator` bot bo'lmaydi, shuning uchun qo'shilishlar statistikada
 *     "🔗 Havola" deb sanaladi, "🤖 Bot orqali" emas.
 *  2. `botInviteLink` — bot tracking havolasi, to'liq atributsiya beradi.
 *  3. `@username` — hech qachon eskirmaydi, lekin atributsiyasi yo'q.
 *  4. `inviteLink` — bot yaratgan zaxira havola (PRIVATE/REQUEST kanallarda).
 */
export function channelUrl(ch: Channel): string | null {
  if (ch.type === "INSTAGRAM") return ch.inviteLink ?? null;
  if (ch.adminInviteLink) return ch.adminInviteLink;
  if (ch.botInviteLink) return ch.botInviteLink;
  if (ch.username) return `https://t.me/${ch.username.replace(/^@/, "")}`;
  if (ch.inviteLink) return ch.inviteLink;
  return null;
}

/** True qaytarsa — foydalanuvchi hamma Telegram kanalga a'zo (yoki kanal yo'q) */
export async function ensureSubscribed(ctx: MyContext, userId: number): Promise<boolean> {
  const notJoined = await getUnsubscribedChannels(ctx, userId);
  // Instagram kanallarini obunasiz ham o'tkazib yuboramiz (tekshirish imkonsiz)
  const blocking = notJoined.filter((c) => c.type !== "INSTAGRAM");
  if (blocking.length === 0) {
    // Darvoza ilgari ko'rsatilgan bo'lsa va endi hamma kanalga a'zo bo'lsa —
    // bu odam bot orqali qo'shilgan. "Tekshirish" tugmasini bosmasdan to'g'ridan
    // kino kodi yuborganlar ham shu yerda hisobga olinadi (aks holda ular
    // `direct` bo'lib qolib, referal statistikasi kam ko'rsatardi).
    await attributePendingSubscriptions(ctx, userId);
    return true;
  }
  await sendSubscriptionPrompt(ctx, notJoined);
  return false;
}

/**
 * Sessiyada saqlangan "darvoza bloklagan kanallar" ro'yxatini `bot` deb
 * belgilaydi va ro'yxatni tozalaydi. Bir necha marta chaqirilishi xavfsiz —
 * `recordSubscriptionJoin` mavjud yozuvni yangilaydi, yangisini yaratmaydi.
 */
export async function attributePendingSubscriptions(ctx: MyContext, userId: number): Promise<void> {
  const v = ctx.session?.scratch;
  const pending = v?.pendingSubChannels as string[] | undefined;
  if (!Array.isArray(pending) || pending.length === 0) return;

  const at = v?.pendingSubAt as number | undefined;
  const fresh = typeof at === "number" && Date.now() - at <= ATTRIB_WINDOW_MS;
  if (fresh) {
    for (const idStr of pending) {
      await recordSubscriptionJoin(ctx, userId, BigInt(idStr));
    }
  }
  // Ro'yxat qanday bo'lmasin tozalanadi — eskirgan darvoza keyingi chaqiruvda
  // soxta atributsiya (organik qo'shilishni "bot" deb belgilash) qilmasin.
  delete v!.pendingSubChannels;
  delete v!.pendingSubAt;
}
