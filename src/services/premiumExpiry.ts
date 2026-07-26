import { prisma } from "../prisma.js";
import { getBool, KEYS } from "../utils/settings.js";
import { contactAdminBtn, ibtn, kb } from "../utils/keyboard.js";
import { bulkSend, isBulkRunning } from "./bulkSend.js";
import type { Bot } from "grammy";
import type { MyContext } from "../types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // har soatda tekshirish

/**
 * Eskirgan obunalar uchun "tugadi" xabari yuborilmaydi — bu chegaradan oldin
 * tugagan bo'lsa faqat bosqich belgilanadi. Aks holda funksiya birinchi marta
 * ishga tushganda allaqachon ancha oldin tugagan hamma obunachiga xabar ketardi.
 */
const EXPIRED_GRACE_MS = 2 * DAY_MS;

/** Bosqichlar: 1 = 3 kun qoldi · 2 = 1 kun qoldi · 3 = tugadi */
type Stage = 1 | 2 | 3;

/** Qolgan vaqtga qarab qaysi bosqichdagi xabar tegishli ekanini aniqlaydi (0 = hech qanday) */
function stageFor(msLeft: number): 0 | Stage {
  if (msLeft <= 0) return 3;
  if (msLeft <= DAY_MS) return 2;
  if (msLeft <= 3 * DAY_MS) return 1;
  return 0;
}

/** Muddat tugagach nima o'zgarishi — ogohlantirishlarda takrorlanadi */
const CONSEQUENCES =
  `• <b>Majburiy obuna</b> qayta talab qilinadi — kino olish uchun kanallarga a'zo bo'lish kerak\n` +
  `• <b>Premium kinolar</b> yopiladi\n` +
  `• Kino so'rovlari va AI yordamchi <b>cheklanadi</b>`;

function buildMessage(stage: Stage, until: Date): { text: string; markup: ReturnType<typeof kb> } {
  const untilStr = until.toLocaleDateString("ru-RU");

  if (stage === 3) {
    return {
      text:
        `⌛️ <b>Premium obunangiz tugadi</b>\n\n` +
        `${untilStr} sanasida amal qilish muddati yakunlandi. Endi botdan oddiy rejimda foydalanasiz:\n\n` +
        `${CONSEQUENCES}\n\n` +
        `Cheksiz va obunasiz foydalanishni davom ettirish uchun premiumni tiklang 👇`,
      markup: kb(
        [ibtn("💎 Premiumni tiklash", "prem:show", "success")],
        [contactAdminBtn()],
      ),
    };
  }

  const left = stage === 1 ? "3 kun" : "1 kun";
  return {
    text:
      `⏳ <b>Premium obunangiz tugayapti</b>\n\n` +
      `<tg-emoji emoji-id="5258093637450866522">💎</tg-emoji> Amal qilish muddati: <b>${untilStr}</b> — atigi <b>${left}</b> qoldi.\n\n` +
      `Muddat tugagach:\n${CONSEQUENCES}\n\n` +
      `Uzluksiz foydalanish uchun obunani hoziroq uzaytiring 👇`,
    markup: kb(
      [ibtn("💎 Obunani uzaytirish", "prem:show", "success")],
      [contactAdminBtn()],
    ),
  };
}

/**
 * Premium tugashi haqida ogohlantirish yuboruvchi rejalashtiruvchi.
 * Har soatda 3 kun / 1 kun qolganda va tugagach bir martadan xabar yuboradi.
 * Takrorlanmasligi uchun `User.premiumWarnStage` ishlatiladi — u `grantPremium()`
 * ichida 0 ga qaytadi, ya'ni obuna uzaytirilsa ogohlantirishlar qaytadan boshlanadi.
 */
export function startPremiumExpiryWatcher(bot: Bot<MyContext>): void {
  const tick = async () => {
    try {
      if (!(await getBool(KEYS.premiumWarnEnabled, true))) return;
      // Admin ommaviy xabar yuborayotgan bo'lsa aralashmaymiz — ikki oqim birga
      // ishlasa sur'at ikkilanib flood limitga urardi. Keyingi soatda yuboriladi.
      if (isBulkRunning("broadcast")) return;

      // Faqat premiumi bor va hali barcha bosqichlarni o'tmagan foydalanuvchilar
      const users = await prisma.user.findMany({
        where: {
          premiumUntil: { not: null },
          premiumWarnStage: { lt: 3 },
          isBlocked: false,
        },
        select: { id: true, premiumUntil: true, premiumWarnStage: true },
      });

      // Kimga qaysi bosqich tegishli ekanini oldindan hisoblaymiz
      const due: { id: bigint; stage: Stage; until: Date; silent: boolean }[] = [];
      for (const u of users) {
        const until = u.premiumUntil!;
        const stage = stageFor(until.getTime() - Date.now());
        if (stage === 0 || stage <= u.premiumWarnStage) continue;
        // Ancha oldin tugagan obuna — xabarsiz yopamiz
        const silent = stage === 3 && Date.now() - until.getTime() > EXPIRED_GRACE_MS;
        due.push({ id: u.id, stage, until, silent });
      }
      if (due.length === 0) return;

      // Xabarsiz yopiladiganlarni bir marta bazada belgilaymiz
      const silentIds = due.filter((d) => d.silent).map((d) => d.id);
      if (silentIds.length > 0) {
        await prisma.user
          .updateMany({ where: { id: { in: silentIds } }, data: { premiumWarnStage: 3 } })
          .catch(() => null);
      }

      const toNotify = due.filter((d) => !d.silent);
      const byId = new Map(toNotify.map((d) => [BigInt(d.id).toString(), d]));

      const result = await bulkSend({
        userIds: toNotify.map((d) => d.id),
        send: async (uid) => {
          const d = byId.get(String(uid))!;
          const { text, markup } = buildMessage(d.stage, d.until);
          await bot.api.sendMessage(uid, text, { parse_mode: "HTML", reply_markup: markup });
          // Faqat yetkazilgandan keyin bosqichni yozamiz — vaqtinchalik xato bo'lsa
          // keyingi soatda qayta uriniladi.
          await prisma.user
            .update({ where: { id: d.id }, data: { premiumWarnStage: d.stage } })
            .catch(() => null);
        },
      });

      // Bloklaganlar uchun ham bosqichni yopamiz (aks holda har soat qayta urinaverardi)
      const blockedIds = toNotify.map((d) => d.id);
      if (result.blocked > 0) {
        await prisma.user
          .updateMany({ where: { id: { in: blockedIds }, isBlocked: true }, data: { premiumWarnStage: 3 } })
          .catch(() => null);
      }

      if (result.sent > 0) console.log(`💎 Premium ogohlantirishlari yuborildi: ${result.sent}`);
    } catch {
      // xatolik botni to'xtatmasin
    }
  };

  // Ishga tushgach 2 daqiqadan keyin, so'ng har soatda
  setTimeout(tick, 120_000);
  setInterval(tick, CHECK_INTERVAL_MS);
}