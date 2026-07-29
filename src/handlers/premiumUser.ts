import { Composer } from "grammy";
import { prisma } from "../prisma.js";
import { config } from "../config.js";
import { e } from "../utils/emoji.js";
import { contactAdminBtn, contactAdminKb, ibtn, kb, BE } from "../utils/keyboard.js";
import { getSetting, KEYS } from "../utils/settings.js";
import { activeTariffs, grantPremium, isPremiumActive, premiumEnabled, seedDefaultTariffs } from "../utils/premium.js";
import { getUnsubscribedChannels, editSubscriptionPrompt } from "../utils/subscription.js";
import { formatUzDateTime } from "../utils/dateRange.js";
import type { MyContext } from "../types.js";

export const premiumHandler = new Composer<MyContext>();

/** Premium taklifi xabari (limit tugaganda, /premium yoki obuna so'rovi ostidagi tugma orqali) */
export async function sendPremiumPrompt(ctx: MyContext, reason?: string, edit = false): Promise<void> {
  let tariffs = await activeTariffs();
  // Premium yoqilgan-u tarif yo'q bo'lsa — standart tariflarni avtomatik qo'shamiz
  if (tariffs.length === 0 && (await premiumEnabled())) {
    await seedDefaultTariffs();
    tariffs = await activeTariffs();
  }

  const head =
    `<tg-emoji emoji-id="5258093637450866522">💎</tg-emoji> <b>Premium obuna</b>\n\n` +
    (reason ? `${reason}\n\n` : "") +
    `Premium a'zolik bilan botdan <b>to'liq erkin</b> foydalanasiz:\n\n` +
    `✅ <b>Cheksiz</b> kino va serial — limitsiz\n` +
    `✅ <b>Majburiy obunasiz</b> — hech qanday kanal so'ralmaydi\n` +
    `✅ <b>Cheksiz AI yordamchi</b> — tavsiya + rasm orqali kino topish\n` +
    `✅ Reklama va kutishlarsiz, eng tez xizmat\n\n`;

  if (tariffs.length === 0) {
    const text = head + `Hozircha tariflar sozlanmagan. Admin bilan bog'laning.`;
    if (edit) await ctx.editMessageText(text).catch(() => ctx.reply(text));
    else await ctx.reply(text);
    return;
  }

  // Eng foydali tarifni aniqlash: kunlik narxi eng arzon bo'lgani.
  const perDay = (t: (typeof tariffs)[number]) => (t.days > 0 ? t.price / t.days : t.price);
  const bestPerDay = Math.min(...tariffs.map(perDay));
  // Taqqoslash uchun eng qimmat kunlik narx (odatda eng qisqa tarif)
  const worstPerDay = Math.max(...tariffs.map(perDay));

  const lines: string[] = [head, `<b>Tarifni tanlang:</b>`];
  const rows = tariffs.map((t) => {
    const pd = perDay(t);
    const isBest = pd <= bestPerDay + 0.01;
    // Eng qisqa/qimmat tarifga nisbatan tejash foizi
    const saving = worstPerDay > 0 ? Math.round((1 - pd / worstPerDay) * 100) : 0;

    const priceStr = t.price.toLocaleString("ru-RU");
    const perDayStr = Math.round(pd).toLocaleString("ru-RU");

    // Eski narx bo'lsa — ustidan chizib ko'rsatamiz + chegirma foizi
    const hasOld = t.oldPrice != null && t.oldPrice > t.price;
    const oldStr = hasOld ? t.oldPrice!.toLocaleString("ru-RU") : "";
    const offPct = hasOld ? Math.round((1 - t.price / t.oldPrice!) * 100) : 0;

    let info = `• <b>${e.escapeHtml(t.label)}</b> — `;
    if (hasOld) info += `<s>${oldStr}</s> `;
    info += `<b>${priceStr} so'm</b>`;
    if (hasOld) info += ` 🎁 <b>-${offPct}%</b>`;
    info += `\n   <i>${perDayStr} so'm/kun</i>`;
    if (isBest) info += `  ⭐️ <b>eng foydali</b>`;
    else if (saving >= 5) info += `  💰 yana ${saving}% tejash`;
    lines.push(info);

    const btnLabel = isBest
      ? `⭐️ ${t.label} — ${priceStr} so'm (eng foydali)`
      : `${t.label} — ${priceStr} so'm`;
    return [ibtn(btnLabel, `prem:buy:${t.id}`, isBest ? "success" : "primary")];
  });
  rows.push([ibtn("⬅️ Orqaga", "prem:back", undefined, BE.backMenu)]);

  const text = lines.join("\n");
  const markup = kb(...rows);
  if (edit) await ctx.editMessageText(text, { reply_markup: markup }).catch(() => ctx.reply(text, { reply_markup: markup }));
  else await ctx.reply(text, { reply_markup: markup });
}

// /premium — holat + sotib olish
premiumHandler.command("premium", async (ctx) => {
  const user = await prisma.user.findUnique({ where: { id: BigInt(ctx.from!.id) } });
  if (isPremiumActive(user?.premiumUntil)) {
    const until = user!.premiumUntil!;
    const daysLeft = Math.max(1, Math.ceil((until.getTime() - Date.now()) / (24 * 60 * 60 * 1000)));
    await ctx.reply(
      `<tg-emoji emoji-id="5258093637450866522">💎</tg-emoji> <b>Sizda Premium faol!</b>\n\n` +
      `Amal qilish muddati: <b>${until.toLocaleDateString("ru-RU")}</b> gacha — <b>${daysLeft} kun</b> qoldi.\n\n` +
      `<i>Muddat tugagach majburiy obuna va limitlar qaytadan ishlaydi. ` +
      `Tugashiga 3 kun qolganda eslatma yuboramiz.</i>`,
      { reply_markup: kb([ibtn("💎 Obunani uzaytirish", "prem:show", "success")], [contactAdminBtn()]) }
    );
    return;
  }
  await sendPremiumPrompt(ctx);
});

// Obuna so'rovi ostidagi "Premium obuna" tugmasi — shu xabarni o'zini yangilaydi
premiumHandler.callbackQuery("prem:show", async (ctx) => {
  await ctx.answerCallbackQuery();
  await sendPremiumPrompt(ctx, undefined, true);
});

// Tariflardan "Orqaga" — obuna so'rovi hali kerak bo'lsa unga qaytadi, aks holda yopadi
premiumHandler.callbackQuery("prem:back", async (ctx) => {
  await ctx.answerCallbackQuery();
  const notJoined = await getUnsubscribedChannels(ctx, ctx.from.id);
  const blocking  = notJoined.filter((c) => c.type !== "INSTAGRAM");
  if (blocking.length > 0) {
    await editSubscriptionPrompt(ctx, notJoined);
  } else {
    await ctx.deleteMessage().catch(() => {});
  }
});

// Tarif tanlandi → to'lov usulini tanlash (Karta / TON / Stars)
premiumHandler.callbackQuery(/^prem:buy:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const tariff = await prisma.tariff.findUnique({ where: { id: Number(ctx.match[1]) } });
  if (!tariff || !tariff.isActive) {
    await ctx.reply("❌ Tarif topilmadi.");
    return;
  }

  const rows = [
    [ibtn("💳 Karta orqali", `pm:karta:${tariff.id}`, "primary")],
    // TON orqali vaqtincha yashirilgan (so'ralganda qayta yoqiladi) — pm:ton handler o'zi qoladi.
  ];
  if (tariff.starsPrice) {
    rows.push([ibtn(`⭐ Stars orqali (${tariff.starsPrice} ⭐)`, `pm:stars:${tariff.id}`, "success")]);
  }
  rows.push([ibtn("⬅️ Orqaga", "prem:show", undefined, BE.backMenu)]);

  await ctx.editMessageText(
    `💳 <b>${e.escapeHtml(tariff.label)}</b> — ${priceWithOld(tariff)} (${tariff.days} kun)\n\n` +
    `To'lov usulini tanlang:`,
    { reply_markup: kb(...rows) }
  ).catch(() => ctx.reply(`To'lov usulini tanlang:`, { reply_markup: kb(...rows) }));
});

/** "eski narx (chizilgan) yangi narx -N%" ko'rinishidagi matn */
function priceWithOld(t: { price: number; oldPrice: number | null }): string {
  const now = `<b>${t.price.toLocaleString("ru-RU")} so'm</b>`;
  if (t.oldPrice == null || t.oldPrice <= t.price) return now;
  const off = Math.round((1 - t.price / t.oldPrice) * 100);
  return `<s>${t.oldPrice.toLocaleString("ru-RU")}</s> ${now} 🎁 <b>-${off}%</b>`;
}

const METHOD_LABEL: Record<"karta" | "ton", string> = {
  karta: "💳 Karta orqali",
  ton: "💎 TON orqali o'tkazma",
};

// Karta / TON — ko'rsatma + screenshot so'rash
premiumHandler.callbackQuery(/^pm:(karta|ton):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const method = ctx.match[1] as "karta" | "ton";
  const tariff = await prisma.tariff.findUnique({ where: { id: Number(ctx.match[2]) } });
  if (!tariff || !tariff.isActive) {
    await ctx.reply("❌ Tarif topilmadi.");
    return;
  }

  const infoKey = method === "karta" ? KEYS.paymentInfo : KEYS.paymentInfoTon;
  const payInfo = await getSetting(infoKey, "");
  ctx.session.scratch = { ...(ctx.session.scratch ?? {}), premBuyTariff: tariff.id, premBuyMethod: method };

  const text =
    `${METHOD_LABEL[method]}\n\n` +
    `Tarif: <b>${e.escapeHtml(tariff.label)}</b>\n` +
    `Narx: ${priceWithOld(tariff)}\n` +
    `Muddat: <b>${tariff.days} kun</b>\n\n` +
    (payInfo
      ? `${e.escapeHtml(payInfo)}\n\n`
      : `To'lov ma'lumotlari sozlanmagan. Admin bilan bog'laning.\n\n`) +
    `To'lovni amalga oshirgach, <b>chek/screenshot</b> rasmini shu yerga yuboring. ` +
    `Admin tekshirib premiumni yoqadi.`;
  const markup = kb([ibtn("❌ Bekor qilish", "prem:cancel", "danger")]);
  await ctx.editMessageText(text, { reply_markup: markup }).catch(() => ctx.reply(text, { reply_markup: markup }));
});

premiumHandler.callbackQuery("prem:cancel", async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Bekor qilindi." });
  if (ctx.session.scratch) {
    delete ctx.session.scratch.premBuyTariff;
    delete ctx.session.scratch.premBuyMethod;
  }
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
});

// ⭐ Stars orqali — native Telegram to'lov (avtomatik, admin tasdig'i shart emas)
premiumHandler.callbackQuery(/^pm:stars:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const tariff = await prisma.tariff.findUnique({ where: { id: Number(ctx.match[1]) } });
  if (!tariff || !tariff.isActive || !tariff.starsPrice) {
    await ctx.reply("❌ Stars orqali to'lov hozircha mavjud emas.");
    return;
  }
  await ctx.api.sendInvoice(
    ctx.chat!.id,
    `💎 Premium — ${tariff.label}`,
    `${tariff.days} kunlik Premium obuna (Kino vaqti)`,
    `stars:${tariff.id}`,
    "XTR",
    [{ label: tariff.label, amount: tariff.starsPrice }],
  ).catch(async () => {
    await ctx.reply("❌ To'lov oynasini ochib bo'lmadi. Birozdan keyin urinib ko'ring.");
  });
});

premiumHandler.on("pre_checkout_query", async (ctx) => {
  const payload = ctx.preCheckoutQuery.invoice_payload;
  const m = payload.match(/^stars:(\d+)$/);
  if (!m) { await ctx.answerPreCheckoutQuery(false, "Noto'g'ri so'rov."); return; }
  const tariff = await prisma.tariff.findUnique({ where: { id: Number(m[1]) } });
  if (!tariff || !tariff.isActive) { await ctx.answerPreCheckoutQuery(false, "Tarif topilmadi."); return; }
  await ctx.answerPreCheckoutQuery(true);
});

premiumHandler.on("message:successful_payment", async (ctx) => {
  const sp = ctx.message.successful_payment;
  const m = sp.invoice_payload.match(/^stars:(\d+)$/);
  if (!m) return;
  const tariff = await prisma.tariff.findUnique({ where: { id: Number(m[1]) } });
  if (!tariff) return;

  const uid = BigInt(ctx.from!.id);
  const until = await grantPremium(uid, tariff.days);
  await prisma.payment.create({
    data: {
      userId: uid,
      tariffId: tariff.id,
      tariffLabel: tariff.label,
      days: tariff.days,
      amount: tariff.price,
      method: "stars",
      status: "approved",
      reviewedAt: new Date(),
    },
  });

  await ctx.reply(
    `<tg-emoji emoji-id="5258093637450866522">💎</tg-emoji> <b>Premium yoqildi!</b>\n\n` +
    `To'lov Stars orqali muvaffaqiyatli qabul qilindi. Premium <b>${until.toLocaleDateString("ru-RU")}</b> gacha amal qiladi.\n` +
    `Endi cheksiz va obunasiz foydalanishingiz mumkin! 🎉\n\n` +
    `<i>Muddat tugashiga 3 kun qolganda sizga eslatma yuboramiz.</i>`,
    { reply_markup: contactAdminKb() }
  );
});

// Chek/screenshot (rasm yoki fayl) qabul qilish — Karta/TON oqimi
premiumHandler.on(["message:photo", "message:document"], async (ctx, next) => {
  const tariffId = ctx.session.scratch?.premBuyTariff as number | undefined;
  if (!tariffId) return next();
  const method = (ctx.session.scratch?.premBuyMethod as "karta" | "ton" | undefined) ?? "karta";

  const tariff = await prisma.tariff.findUnique({ where: { id: tariffId } });
  if (!tariff) {
    if (ctx.session.scratch) { delete ctx.session.scratch.premBuyTariff; delete ctx.session.scratch.premBuyMethod; }
    return;
  }

  const proofFileId = ctx.message.photo?.at(-1)?.file_id ?? ctx.message.document?.file_id ?? null;
  if (ctx.session.scratch) { delete ctx.session.scratch.premBuyTariff; delete ctx.session.scratch.premBuyMethod; }

  const payment = await prisma.payment.create({
    data: {
      userId: BigInt(ctx.from!.id),
      tariffId: tariff.id,
      tariffLabel: tariff.label,
      days: tariff.days,
      amount: tariff.price,
      method,
      proofFileId,
      status: "pending",
    },
  });

  await ctx.reply(
    `✅ <b>Chek qabul qilindi!</b>\n\n` +
    `To'lovingiz admin tomonidan tekshirilmoqda. Tasdiqlangach premium avtomatik yoqiladi. ` +
    `Odatda bu bir necha daqiqa/soat ichida bo'ladi.`
  );

  // Adminlarga (owner) xabar — to'g'ridan-to'g'ri Tasdiqlash/Rad etish tugmalari bilan.
  // Firibgarlik holatida foydalanuvchini topish uchun to'liq ma'lumot bilan —
  // ro'yxatdan o'tgan sana ham qo'shiladi (yangi hisob + darhol to'lov — shubhali belgi).
  const uname = ctx.from!.username ? `@${ctx.from!.username}` : "—";
  const dbUser = await prisma.user.findUnique({
    where: { id: BigInt(ctx.from!.id) },
    select: { createdAt: true, region: true },
  });
  const notify =
    `<tg-emoji emoji-id="5258093637450866522">💎</tg-emoji> <b>Yangi premium to'lov!</b>\n\n` +
    `To'lov ID: <code>#${payment.id}</code>\n` +
    `Foydalanuvchi: <b>${e.escapeHtml(ctx.from!.first_name ?? "—")}</b> ${uname}\n` +
    `Telegram ID: <code>${ctx.from!.id}</code>\n` +
    (dbUser?.region ? `Viloyat: <b>${e.escapeHtml(dbUser.region)}</b>\n` : "") +
    (dbUser?.createdAt ? `Botda ro'yxatdan o'tgan: <b>${formatUzDateTime(dbUser.createdAt)}</b>\n` : "") +
    `Usul: <b>${METHOD_LABEL[method]}</b>\n` +
    `Tarif: <b>${e.escapeHtml(tariff.label)}</b> — ${tariff.price.toLocaleString("ru-RU")} so'm (${tariff.days} kun)\n` +
    `To'lov vaqti: <b>${formatUzDateTime(payment.createdAt)}</b>`;
  const notifyMarkup = kb([
    ibtn("✅ Tasdiqlash", `prm:approve:${payment.id}`, "success"),
    ibtn("❌ Rad etish", `prm:reject:${payment.id}`, "danger"),
  ]);

  const notifyChatIds = [...config.ownerIds.map((o) => Number(o))];
  if (config.paymentChannelId) notifyChatIds.push(config.paymentChannelId);

  for (const chatId of notifyChatIds) {
    await ctx.api.sendMessage(chatId, notify, { parse_mode: "HTML", reply_markup: notifyMarkup }).catch((err) => {
      console.error(`🛑 To'lov bildirishnomasi yetmadi (${chatId}):`, (err as Error).message);
    });
    if (proofFileId && ctx.message.photo) {
      await ctx.api.sendPhoto(chatId, proofFileId, { caption: `Chek — to'lov #${payment.id}` }).catch(() => null);
    } else if (proofFileId && ctx.message.document) {
      await ctx.api.sendDocument(chatId, proofFileId, { caption: `Chek — to'lov #${payment.id}` }).catch(() => null);
    }
  }
});
