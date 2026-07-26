import { Composer } from "grammy";
import { prisma } from "../../prisma.js";
import { adminCan } from "../../config.js";
import { e } from "../../utils/emoji.js";
import { ADMIN_MENU_BUTTONS, adminMenuKeyboard, ibtn, kb, BE } from "../../utils/keyboard.js";
import { getBool, setBool, getSetting, setSetting, KEYS } from "../../utils/settings.js";
import { grantPremium, seedDefaultTariffs, resetToDefaultTariffs } from "../../utils/premium.js";
import type { MyContext } from "../../types.js";

export const premiumAdminHandler = new Composer<MyContext>();

const CONTACT_MARKUP = kb([{ text: "📞 Muammo bormi? Admin bilan bog'lanish", url: "https://t.me/akajon_00" }]);

function can(ctx: MyContext): boolean {
  return adminCan(ctx.from?.id ?? 0, "premium");
}

// ─── Asosiy menyu ────────────────────────────────────────────────────────────
async function menuData() {
  const [enabled, pending, premiumCount] = await Promise.all([
    getBool(KEYS.premiumEnabled, false),
    prisma.payment.count({ where: { status: "pending" } }),
    prisma.user.count({ where: { premiumUntil: { gt: new Date() } } }),
  ]);

  const text =
    `<tg-emoji emoji-id="5258093637450866522">💎</tg-emoji> <b>Premium boshqaruvi</b>\n\n` +
    `Tizim: <b>${enabled ? "🟢 Yoqilgan" : "🔴 O'chirilgan"}</b>\n` +
    `Premium foydalanuvchilar: <b>${premiumCount}</b>\n` +
    `Kutilayotgan to'lovlar: <b>${pending}</b>`;

  const markup = kb(
    [ibtn(`💳 Kutilayotgan to'lovlar (${pending})`, "prm:pending:0", "primary")],
    [ibtn("🏷 Tariflar", "prm:tariffs", "primary"), ibtn("⚙️ Sozlamalar", "prm:settings", "primary")],
    [ibtn("🎁 Qo'lda premium berish", "prm:grant", "success")],
    [ibtn("👥 Premium foydalanuvchilar", "prm:users:0", "primary")],
    [ibtn("Orqaga", "botset:back", undefined, BE.backMenu)],
  );
  return { text, markup };
}

premiumAdminHandler.hears(ADMIN_MENU_BUTTONS.premium, async (ctx) => {
  if (!can(ctx)) return;
  const { text, markup } = await menuData();
  await ctx.reply(text, { reply_markup: markup });
});

premiumAdminHandler.callbackQuery("prm:menu", async (ctx) => {
  await ctx.answerCallbackQuery();
  const { text, markup } = await menuData();
  await ctx.editMessageText(text, { reply_markup: markup }).catch(() => {});
});

premiumAdminHandler.callbackQuery("prm:close", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.deleteMessage().catch(() => {});
  await ctx.reply("Admin panel:", { reply_markup: adminMenuKeyboard(ctx.from.id) });
});

// ─── Kutilayotgan to'lovlar ──────────────────────────────────────────────────
premiumAdminHandler.callbackQuery(/^prm:pending:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const page = Number(ctx.match[1]);
  const PAGE = 8;
  const total = await prisma.payment.count({ where: { status: "pending" } });
  const items = await prisma.payment.findMany({
    where: { status: "pending" }, orderBy: { createdAt: "asc" }, skip: page * PAGE, take: PAGE,
  });

  if (items.length === 0) {
    await ctx.editMessageText("✅ Kutilayotgan to'lov yo'q.", {
      reply_markup: kb([ibtn("Orqaga", "prm:menu", undefined, BE.backMenu)]),
    }).catch(() => {});
    return;
  }

  const rows = items.map((p) => [
    ibtn(`#${p.id} · ${p.tariffLabel} · ${p.amount.toLocaleString("ru-RU")}`, `prm:pay:${p.id}`, "primary"),
  ]);
  const pages = Math.ceil(total / PAGE);
  const nav: ReturnType<typeof ibtn>[] = [];
  if (page > 0) nav.push(ibtn("⬅️", `prm:pending:${page - 1}`));
  if (pages > 1) nav.push(ibtn(`${page + 1}/${pages}`, "noop:prm"));
  if (page < pages - 1) nav.push(ibtn("➡️", `prm:pending:${page + 1}`));
  if (nav.length) rows.push(nav);
  rows.push([ibtn("Orqaga", "prm:menu", undefined, BE.backMenu)]);

  await ctx.editMessageText(`💳 <b>Kutilayotgan to'lovlar</b> (${total}):`, { reply_markup: kb(...rows) }).catch(() => {});
});

premiumAdminHandler.callbackQuery("noop:prm", (ctx) => ctx.answerCallbackQuery());

premiumAdminHandler.callbackQuery(/^prm:pay:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const p = await prisma.payment.findUnique({ where: { id: Number(ctx.match[1]) } });
  if (!p) { await ctx.reply("Topilmadi."); return; }
  const u = await prisma.user.findUnique({ where: { id: p.userId } });
  const uname = u?.username ? `@${u.username}` : "—";

  const methodText = { karta: "💳 Karta", ton: "💎 TON", stars: "⭐ Stars" }[p.method] ?? p.method;
  const text =
    `💳 <b>To'lov #${p.id}</b>\n\n` +
    `Foydalanuvchi: <b>${e.escapeHtml(u?.firstName ?? "—")}</b> ${uname}\n` +
    `ID: <code>${p.userId}</code>\n` +
    `Usul: <b>${methodText}</b>\n` +
    `Tarif: <b>${e.escapeHtml(p.tariffLabel)}</b> — ${p.amount.toLocaleString("ru-RU")} so'm (${p.days} kun)\n` +
    `Holat: <b>${p.status}</b>\n` +
    `Sana: ${p.createdAt.toLocaleString("ru-RU")}`;

  const rows = p.status === "pending"
    ? [
        [ibtn("✅ Tasdiqlash", `prm:approve:${p.id}`, "success"), ibtn("❌ Rad etish", `prm:reject:${p.id}`, "danger")],
        [ibtn("Orqaga", "prm:pending:0", undefined, BE.backMenu)],
      ]
    : [[ibtn("Orqaga", "prm:pending:0", undefined, BE.backMenu)]];

  // Chek rasmini alohida yuboramiz
  if (p.proofFileId) {
    await ctx.editMessageText(text, { reply_markup: kb(...rows) }).catch(() => {});
    await ctx.replyWithPhoto(p.proofFileId, { caption: `Chek — to'lov #${p.id}` }).catch(() => {});
  } else {
    await ctx.editMessageText(text + `\n\n⚠️ Chek biriktirilmagan.`, { reply_markup: kb(...rows) }).catch(() => {});
  }
});

premiumAdminHandler.callbackQuery(/^prm:approve:(\d+)$/, async (ctx) => {
  const p = await prisma.payment.findUnique({ where: { id: Number(ctx.match[1]) } });
  if (!p || p.status !== "pending") { await ctx.answerCallbackQuery({ text: "Allaqachon ko'rib chiqilgan.", show_alert: true }); return; }

  const until = await grantPremium(p.userId, p.days);
  await prisma.payment.update({
    where: { id: p.id },
    data: { status: "approved", reviewedById: BigInt(ctx.from.id), reviewedAt: new Date() },
  });
  await ctx.answerCallbackQuery({ text: "✅ Tasdiqlandi, premium yoqildi.", show_alert: true });
  await ctx.editMessageReplyMarkup({ reply_markup: kb([ibtn("Orqaga", "prm:pending:0", undefined, BE.backMenu)]) }).catch(() => {});

  await ctx.api.sendMessage(
    Number(p.userId),
    `<tg-emoji emoji-id="5258093637450866522">💎</tg-emoji> <b>Premium yoqildi!</b>\n\n` +
    `To'lovingiz tasdiqlandi. Premium <b>${until.toLocaleDateString("ru-RU")}</b> gacha amal qiladi.\n` +
    `Endi cheksiz va obunasiz foydalanishingiz mumkin! 🎉`,
    { parse_mode: "HTML", reply_markup: CONTACT_MARKUP }
  ).catch(() => null);
});

premiumAdminHandler.callbackQuery(/^prm:reject:(\d+)$/, async (ctx) => {
  const p = await prisma.payment.findUnique({ where: { id: Number(ctx.match[1]) } });
  if (!p || p.status !== "pending") { await ctx.answerCallbackQuery({ text: "Allaqachon ko'rib chiqilgan.", show_alert: true }); return; }
  await prisma.payment.update({
    where: { id: p.id },
    data: { status: "rejected", reviewedById: BigInt(ctx.from.id), reviewedAt: new Date() },
  });
  await ctx.answerCallbackQuery({ text: "❌ Rad etildi.", show_alert: true });
  await ctx.editMessageReplyMarkup({ reply_markup: kb([ibtn("Orqaga", "prm:pending:0", undefined, BE.backMenu)]) }).catch(() => {});
  await ctx.api.sendMessage(
    Number(p.userId),
    `❌ To'lovingiz (#${p.id}) tasdiqlanmadi. Savol bo'lsa admin bilan bog'laning.`,
    { reply_markup: CONTACT_MARKUP }
  ).catch(() => null);
});

// ─── Tariflar ────────────────────────────────────────────────────────────────
async function renderTariffs(ctx: MyContext) {
  const tariffs = await prisma.tariff.findMany({ orderBy: { sortOrder: "asc" } });
  const lines = tariffs.length
    ? tariffs.map((t) =>
        `${t.isActive ? "🟢" : "🔴"} <b>${e.escapeHtml(t.label)}</b> — ` +
        (t.oldPrice && t.oldPrice > t.price ? `<s>${t.oldPrice.toLocaleString("ru-RU")}</s> ` : "") +
        `${t.price.toLocaleString("ru-RU")} so'm · ${t.days} kun` +
        (t.starsPrice ? ` · ⭐ ${t.starsPrice}` : ` · ⭐ <i>sozlanmagan</i>`)
      ).join("\n")
    : "Hozircha tarif yo'q.";
  const rows = tariffs.flatMap((t) => [[
    ibtn(`🗑 ${t.label}`, `prm:tdel:${t.id}`, "danger"),
    ibtn(`⭐ ${t.label} narxi`, `prm:tstars:${t.id}`, "primary"),
  ]]);
  rows.push([ibtn("➕ Tarif qo'shish", "prm:tadd", "success")]);
  if (tariffs.length === 0) rows.push([ibtn("✨ Namuna tariflar qo'shish", "prm:tseed", "primary")]);
  rows.push([ibtn("🔥 Aksiya narxlarini qo'yish (5 000 / 9 000 / 30 000)", "prm:treset", "success")]);
  if (tariffs.some((t) => !t.starsPrice)) {
    rows.push([ibtn("⭐ Stars narxlarini avtomatik belgilash", "prm:tstarsauto", "success")]);
  }
  rows.push([ibtn("Orqaga", "prm:menu", undefined, BE.backMenu)]);
  await ctx.editMessageText(
    `🏷 <b>Tariflar</b>\n\n${lines}\n\n` +
    `<i>Format: Nom | kun | narx | (ixtiyoriy) eski narx | (ixtiyoriy) stars\n` +
    `Eski narx foydalanuvchiga ustidan chizilgan holda ko'rsatiladi.</i>`,
    { reply_markup: kb(...rows) }
  ).catch(() => {});
}

premiumAdminHandler.callbackQuery("prm:tariffs", async (ctx) => {
  await ctx.answerCallbackQuery();
  await renderTariffs(ctx);
});

// Namuna tariflar (placeholder narx bilan — admin tahrirlaydi)
premiumAdminHandler.callbackQuery("prm:tseed", async (ctx) => {
  const added = await seedDefaultTariffs();
  await ctx.answerCallbackQuery({
    text: added ? "✨ 3 ta namuna tarif qo'shildi. Narxlarni tahrirlang." : "Tariflar allaqachon bor.",
    show_alert: true,
  });
  await renderTariffs(ctx);
});

// Aksiya narxlarini majburan qayta yozadi (mavjud tariflar o'rniga)
premiumAdminHandler.callbackQuery("prm:treset", async (ctx) => {
  await resetToDefaultTariffs();
  await ctx.answerCallbackQuery({ text: "🔥 Aksiya narxlari qo'yildi (5 000 / 9 000 / 30 000 so'm).", show_alert: true });
  await renderTariffs(ctx);
});

premiumAdminHandler.callbackQuery("prm:tadd", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.scratch = { ...(ctx.session.scratch ?? {}), prmAddTariff: true };
  await ctx.reply(
    `➕ <b>Yangi tarif</b>\n\nQuyidagi formatda yuboring:\n` +
    `<code>Nom | kun | narx | eski narx | stars</code>\n` +
    `(eski narx va stars — ixtiyoriy)\n\n` +
    `Masalan: <code>1 oy | 30 | 5000</code>\n` +
    `yoki chegirma bilan: <code>1 oy | 30 | 5000 | 25000</code>\n` +
    `yoki stars bilan: <code>1 oy | 30 | 5000 | 25000 | 35</code>`
  );
});

// Stars narxi sozlanmagan tariflarga taxminiy narx qo'yadi (≈150 so'm/⭐) — admin keyin tahrirlashi mumkin
premiumAdminHandler.callbackQuery("prm:tstarsauto", async (ctx) => {
  const missing = await prisma.tariff.findMany({ where: { starsPrice: null } });
  for (const t of missing) {
    await prisma.tariff.update({
      where: { id: t.id },
      data: { starsPrice: Math.max(1, Math.round(t.price / 150)) },
    }).catch(() => null);
  }
  await ctx.answerCallbackQuery({
    text: missing.length ? `✨ ${missing.length} ta tarifga Stars narxi belgilandi.` : "Hammasida allaqachon bor.",
    show_alert: true,
  });
  await renderTariffs(ctx);
});

premiumAdminHandler.callbackQuery(/^prm:tdel:(\d+)$/, async (ctx) => {
  await prisma.tariff.delete({ where: { id: Number(ctx.match[1]) } }).catch(() => null);
  await ctx.answerCallbackQuery({ text: "O'chirildi." });
  await renderTariffs(ctx);
});

premiumAdminHandler.callbackQuery(/^prm:tstars:(\d+)$/, async (ctx) => {
  const tariff = await prisma.tariff.findUnique({ where: { id: Number(ctx.match[1]) } });
  if (!tariff) { await ctx.answerCallbackQuery({ text: "Topilmadi.", show_alert: true }); return; }
  await ctx.answerCallbackQuery();
  ctx.session.scratch = { ...(ctx.session.scratch ?? {}), prmField: `tstars:${tariff.id}` };
  await ctx.reply(
    `⭐ <b>${e.escapeHtml(tariff.label)}</b> uchun Stars narxini yuboring.\n\n` +
    `Hozirgi: <b>${tariff.starsPrice ?? "sozlanmagan"}</b>\n` +
    `O'chirish uchun: <code>-</code>`
  );
});

// ─── Sozlamalar ──────────────────────────────────────────────────────────────
async function settingsData() {
  const [enabled, freeReq, freeDays, freeAi, payInfo, payInfoTon] = await Promise.all([
    getBool(KEYS.premiumEnabled, false),
    getSetting(KEYS.freeRequestLimit, "0"),
    getSetting(KEYS.freeDays, "0"),
    getSetting(KEYS.freeAiLimit, "0"),
    getSetting(KEYS.paymentInfo, ""),
    getSetting(KEYS.paymentInfoTon, ""),
  ]);
  const text =
    `⚙️ <b>Premium sozlamalari</b>\n\n` +
    `Tizim: <b>${enabled ? "🟢 Yoqilgan" : "🔴 O'chirilgan"}</b>\n` +
    `Bepul kino so'rovlari: <b>${freeReq}</b> (0 = cheksiz)\n` +
    `Bepul kunlar: <b>${freeDays}</b> (0 = cheksiz)\n` +
    `Bepul AI so'rovlari/kun: <b>${freeAi}</b> (0 = cheksiz)\n` +
    `Karta ma'lumoti: ${payInfo ? "✅ sozlangan" : "❌ yo'q"}\n` +
    `TON ma'lumoti: ${payInfoTon ? "✅ sozlangan" : "❌ yo'q"}\n` +
    `Stars narxi: Tariflar bo'limida, har tarif uchun alohida\n\n` +
    `<i>Bepul chegara: qaysi biri (kino soni yoki kun) birinchi tugasa premium so'raladi. ` +
    `AI so'rovlari alohida kunlik hisoblanadi.</i>`;
  const markup = kb(
    [ibtn(enabled ? "🔴 Tizimni o'chirish" : "🟢 Tizimni yoqish", "prm:toggle", enabled ? "danger" : "success")],
    [ibtn("✏️ Bepul kino soni", "prm:setfreq", "primary"), ibtn("✏️ Bepul kunlar", "prm:setfdays", "primary")],
    [ibtn("🤖 Bepul AI so'rovlari/kun", "prm:setai", "primary")],
    [ibtn("💳 Karta ma'lumoti", "prm:setpay", "primary"), ibtn("💎 TON ma'lumoti", "prm:setpayton", "primary")],
    [ibtn("Orqaga", "prm:menu", undefined, BE.backMenu)],
  );
  return { text, markup };
}

premiumAdminHandler.callbackQuery("prm:settings", async (ctx) => {
  await ctx.answerCallbackQuery();
  const { text, markup } = await settingsData();
  await ctx.editMessageText(text, { reply_markup: markup }).catch(() => {});
});

premiumAdminHandler.callbackQuery("prm:toggle", async (ctx) => {
  const cur = await getBool(KEYS.premiumEnabled, false);
  await setBool(KEYS.premiumEnabled, !cur);
  // Yoqilganda tarif bo'lmasa — standart 3 tarifni avtomatik qo'shamiz
  if (!cur) await seedDefaultTariffs();
  await ctx.answerCallbackQuery({ text: !cur ? "🟢 Premium tizimi yoqildi (tariflar tayyor)" : "🔴 O'chirildi", show_alert: true });
  const { text, markup } = await settingsData();
  await ctx.editMessageText(text, { reply_markup: markup }).catch(() => {});
});

premiumAdminHandler.callbackQuery("prm:setfreq", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.scratch = { ...(ctx.session.scratch ?? {}), prmField: "freq" };
  await ctx.reply("Bepul so'rovlar sonini yuboring (0 = cheksiz):");
});
premiumAdminHandler.callbackQuery("prm:setfdays", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.scratch = { ...(ctx.session.scratch ?? {}), prmField: "fdays" };
  await ctx.reply("Bepul kunlar sonini yuboring (0 = cheksiz):");
});
premiumAdminHandler.callbackQuery("prm:setai", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.scratch = { ...(ctx.session.scratch ?? {}), prmField: "ailimit" };
  await ctx.reply("Bepul AI so'rovlari/kun sonini yuboring (0 = cheksiz):");
});
premiumAdminHandler.callbackQuery("prm:setpay", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.scratch = { ...(ctx.session.scratch ?? {}), prmField: "pay" };
  await ctx.reply("💳 Karta orqali to'lov ma'lumotini yuboring (karta raqami, egasi va ko'rsatma):");
});
premiumAdminHandler.callbackQuery("prm:setpayton", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.scratch = { ...(ctx.session.scratch ?? {}), prmField: "payton" };
  await ctx.reply("💎 TON orqali to'lov ma'lumotini yuboring (wallet manzili va ko'rsatma):");
});

// ─── Qo'lda premium berish ───────────────────────────────────────────────────
premiumAdminHandler.callbackQuery("prm:grant", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.scratch = { ...(ctx.session.scratch ?? {}), prmField: "grant" };
  await ctx.reply(
    `🎁 <b>Qo'lda premium berish</b>\n\nFormat: <code>foydalanuvchi_ID kun</code>\n` +
    `Masalan: <code>123456789 30</code>`
  );
});

// ─── Premium foydalanuvchilar ────────────────────────────────────────────────
premiumAdminHandler.callbackQuery(/^prm:users:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const page = Number(ctx.match[1]);
  const PAGE = 10;
  const now = new Date();
  const total = await prisma.user.count({ where: { premiumUntil: { gt: now } } });
  const users = await prisma.user.findMany({
    where: { premiumUntil: { gt: now } }, orderBy: { premiumUntil: "desc" }, skip: page * PAGE, take: PAGE,
  });

  const lines = users.length
    ? users.map((u, i) => {
        const name = u.firstName || (u.username ? `@${u.username}` : `ID ${u.id}`);
        return `${page * PAGE + i + 1}. <b>${e.escapeHtml(name)}</b> — ${u.premiumUntil!.toLocaleDateString("ru-RU")} gacha`;
      }).join("\n")
    : "Premium foydalanuvchi yo'q.";

  const pages = Math.max(1, Math.ceil(total / PAGE));
  const nav: ReturnType<typeof ibtn>[] = [];
  if (page > 0) nav.push(ibtn("⬅️", `prm:users:${page - 1}`));
  if (pages > 1) nav.push(ibtn(`${page + 1}/${pages}`, "noop:prm"));
  if (page < pages - 1) nav.push(ibtn("➡️", `prm:users:${page + 1}`));
  const rows = nav.length ? [nav] : [];
  rows.push([ibtn("Orqaga", "prm:menu", undefined, BE.backMenu)]);

  await ctx.editMessageText(`👥 <b>Premium foydalanuvchilar</b> (${total}):\n\n${lines}`, { reply_markup: kb(...rows) }).catch(() => {});
});

// ─── Matn kiritish (tariflar/sozlamalar/grant) ───────────────────────────────
premiumAdminHandler.on("message:text", async (ctx, next) => {
  if (!can(ctx)) return next();
  const s = ctx.session.scratch;
  if (!s) return next();

  const text = ctx.message.text.trim();

  if (s.prmAddTariff) {
    delete s.prmAddTariff;
    const parts = text.split("|").map((x) => x.trim());
    const label = parts[0];
    const days = parseInt(parts[1], 10);
    const price = parseInt(parts[2], 10);
    const oldPrice = parts[3] ? parseInt(parts[3], 10) : null;
    const starsPrice = parts[4] ? parseInt(parts[4], 10) : null;
    if (
      !label || Number.isNaN(days) || Number.isNaN(price) ||
      (parts[3] && Number.isNaN(oldPrice)) || (parts[4] && Number.isNaN(starsPrice))
    ) {
      await ctx.reply("❌ Format xato. Namuna: <code>1 oy | 30 | 5000 | 25000</code>");
      return;
    }
    const count = await prisma.tariff.count();
    await prisma.tariff.create({
      data: { label: label.slice(0, 40), days, price, oldPrice, starsPrice, sortOrder: count },
    });
    await ctx.reply(
      `✅ Tarif qo'shildi: <b>${e.escapeHtml(label)}</b> — ` +
      (oldPrice && oldPrice > price ? `<s>${oldPrice.toLocaleString("ru-RU")}</s> ` : "") +
      `${price.toLocaleString("ru-RU")} so'm · ${days} kun` +
      (starsPrice ? ` · ⭐ ${starsPrice}` : "")
    );
    return;
  }

  if (typeof s.prmField === "string" && s.prmField.startsWith("tstars:")) {
    const tariffId = Number(s.prmField.slice("tstars:".length));
    delete s.prmField;
    if (text === "-") {
      await prisma.tariff.update({ where: { id: tariffId }, data: { starsPrice: null } }).catch(() => null);
      await ctx.reply("✅ Stars narxi o'chirildi.");
      return;
    }
    const n = parseInt(text, 10);
    if (Number.isNaN(n) || n <= 0) { await ctx.reply("❌ Faqat musbat raqam yoki <code>-</code>."); return; }
    await prisma.tariff.update({ where: { id: tariffId }, data: { starsPrice: n } }).catch(() => null);
    await ctx.reply(`✅ Stars narxi: <b>${n} ⭐</b>`);
    return;
  }

  if (s.prmField === "freq") {
    delete s.prmField;
    const n = parseInt(text, 10);
    if (Number.isNaN(n) || n < 0) { await ctx.reply("❌ Faqat musbat raqam."); return; }
    await setSetting(KEYS.freeRequestLimit, String(n));
    await ctx.reply(`✅ Bepul so'rovlar: <b>${n}</b>`);
    return;
  }
  if (s.prmField === "fdays") {
    delete s.prmField;
    const n = parseInt(text, 10);
    if (Number.isNaN(n) || n < 0) { await ctx.reply("❌ Faqat musbat raqam."); return; }
    await setSetting(KEYS.freeDays, String(n));
    await ctx.reply(`✅ Bepul kunlar: <b>${n}</b>`);
    return;
  }
  if (s.prmField === "ailimit") {
    delete s.prmField;
    const n = parseInt(text, 10);
    if (Number.isNaN(n) || n < 0) { await ctx.reply("❌ Faqat musbat raqam."); return; }
    await setSetting(KEYS.freeAiLimit, String(n));
    await ctx.reply(`✅ Bepul AI so'rovlari/kun: <b>${n}</b>`);
    return;
  }
  if (s.prmField === "pay") {
    delete s.prmField;
    await setSetting(KEYS.paymentInfo, text.slice(0, 500));
    await ctx.reply(`✅ Karta to'lov ma'lumoti saqlandi.`);
    return;
  }
  if (s.prmField === "payton") {
    delete s.prmField;
    await setSetting(KEYS.paymentInfoTon, text.slice(0, 500));
    await ctx.reply(`✅ TON to'lov ma'lumoti saqlandi.`);
    return;
  }
  if (s.prmField === "grant") {
    delete s.prmField;
    const [idStr, daysStr] = text.split(/\s+/);
    const uid = Number(idStr);
    const days = parseInt(daysStr, 10);
    if (!Number.isInteger(uid) || Number.isNaN(days) || days <= 0) {
      await ctx.reply("❌ Format: <code>ID kun</code>. Masalan: <code>123456789 30</code>");
      return;
    }
    const target = await prisma.user.findUnique({ where: { id: BigInt(uid) } });
    if (!target) { await ctx.reply("❌ Bunday foydalanuvchi bazada yo'q (botga /start bosgan bo'lishi kerak)."); return; }
    const until = await grantPremium(BigInt(uid), days);
    await ctx.reply(`✅ Premium berildi: <code>${uid}</code> — ${until.toLocaleDateString("ru-RU")} gacha`);
    await ctx.api.sendMessage(
      uid,
      `<tg-emoji emoji-id="5258093637450866522">💎</tg-emoji> <b>Sizga Premium berildi!</b>\n\n${until.toLocaleDateString("ru-RU")} gacha amal qiladi. 🎉`,
      { parse_mode: "HTML" }
    ).catch(() => null);
    return;
  }

  return next();
});
