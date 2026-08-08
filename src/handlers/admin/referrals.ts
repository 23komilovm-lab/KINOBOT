import { Composer } from "grammy";
import { adminCan } from "../../config.js";
import { prisma } from "../../prisma.js";
import { e } from "../../utils/emoji.js";
import {
  ADMIN_MENU_BUTTONS,
  adminMenuKeyboard,
  cancelKeyboard,
  ibtn,
  BE,
  kb,
} from "../../utils/keyboard.js";
import { setSetting, KEYS } from "../../utils/settings.js";
import { getReferralReward } from "../../utils/referral.js";
import type { MyContext } from "../../types.js";

export const referralsHandler = new Composer<MyContext>();

const PAGE = 10;

referralsHandler.hears(ADMIN_MENU_BUTTONS.referrals, async (ctx) => {
  if (!adminCan(ctx.from?.id ?? 0, "referrals")) return;
  await renderTop(ctx, 0, false);
});

async function renderTop(ctx: MyContext, page: number, edit: boolean) {
  // Referrerlar bo'yicha guruhlash (tasdiqlangan)
  const grouped = await prisma.user.groupBy({
    by: ["referredById"],
    where: { referredById: { not: null }, referralConfirmed: true },
    _count: { id: true },
    orderBy: { _count: { id: "desc" } },
    skip: page * PAGE,
    take: PAGE,
  });

  const totalGroups = await prisma.user.groupBy({
    by: ["referredById"],
    where: { referredById: { not: null }, referralConfirmed: true },
    _count: { id: true },
  });
  const totalReferrers = totalGroups.length;
  const totalReferrals = totalGroups.reduce((a, g) => a + g._count.id, 0);

  if (grouped.length === 0) {
    const text = `<tg-emoji emoji-id="${BE.users}">👥</tg-emoji> <b>Referal bo'lim</b>\n\nHozircha referal yo'q.`;
    const markup = kb([ibtn("Menyuga qaytish", "ref:close", undefined, BE.backMenu)]);
    if (edit) await ctx.editMessageText(text, { reply_markup: markup }).catch(() => {});
    else await ctx.reply(text, { reply_markup: markup });
    return;
  }

  const flat: ReturnType<typeof ibtn>[] = [];
  for (const g of grouped) {
    const refId = g.referredById!;
    const u = await prisma.user.findUnique({ where: { id: refId } });
    const name = u?.firstName || (u?.username ? `@${u.username}` : `ID ${refId}`);
    flat.push(ibtn(`${name} — ${g._count.id} ta`, `ref:view:${refId}`));
  }
  const rows: ReturnType<typeof ibtn>[][] = [];
  for (let i = 0; i < flat.length; i += 2) rows.push(flat.slice(i, i + 2));

  const pages = Math.ceil(totalReferrers / PAGE);
  const nav: ReturnType<typeof ibtn>[] = [];
  if (page > 0) nav.push(ibtn("⬅️", `ref:page:${page - 1}`));
  if (pages > 1) nav.push(ibtn(`${page + 1}/${pages}`, "noop:ref"));
  if (page < pages - 1) nav.push(ibtn("➡️", `ref:page:${page + 1}`));
  if (nav.length) rows.push(nav);
  rows.push([ibtn("Menyuga qaytish", "ref:close", undefined, BE.backMenu)]);

  const reward = await getReferralReward();
  const rewardLine =
    reward.count > 0 && reward.days > 0
      ? `🎁 Mukofot: har <b>${reward.count}</b> ta referal = <b>${reward.days} kun</b> premium`
      : `🎁 Mukofot: <b>o'chirilgan</b>`;

  rows.splice(
    rows.length - 1,
    0,
    [ibtn("🎁 Mukofotni sozlash", "ref:reward", "success")],
    [ibtn("🖼 Taklif rasmi haqida", "ref:photo", "primary")]
  );

  const text =
    `<tg-emoji emoji-id="${BE.users}">👥</tg-emoji> <b>Referal bo'lim</b>\n\n` +
    `Jami referrerlar: <b>${totalReferrers}</b>\n` +
    `Jami referallar: <b>${totalReferrals}</b>\n` +
    `${rewardLine}\n\n` +
    `Batafsil ko'rish va xabar yuborish uchun tanlang:`;

  if (edit) await ctx.editMessageText(text, { reply_markup: kb(...rows) }).catch(() => {});
  else await ctx.reply(text, { reply_markup: kb(...rows) });
}

// ─── Mukofot sozlamasi ───────────────────────────────────────────────────────

referralsHandler.callbackQuery("ref:reward", async (ctx) => {
  await ctx.answerCallbackQuery();
  const reward = await getReferralReward();
  ctx.session.scratch = { ...(ctx.session.scratch ?? {}), refRewardEdit: true };
  await ctx.reply(
    `🎁 <b>Referal mukofoti</b>\n\n` +
      `Hozirgi: ${
        reward.count > 0 && reward.days > 0
          ? `har <b>${reward.count}</b> ta referal = <b>${reward.days} kun</b> premium`
          : `<b>o'chirilgan</b>`
      }\n\n` +
      `Yangi qiymatni <code>referal kun</code> ko'rinishida yuboring.\n` +
      `Masalan: <code>5 7</code> — har 5 ta do'st uchun 7 kun premium.\n\n` +
      `O'chirish uchun: <code>0 0</code>`,
    { reply_markup: kb([ibtn("❌ Bekor qilish", "ref:reward:cancel", "danger")]) }
  );
});

// ─── Taklif rasmi haqida ma'lumot ────────────────────────────────────────────
// Rasm alohida yuklanmaydi: Telegram matn yonida kichik rasm ko'rsatishi uchun
// u OCHIQ havolada turishi shart. Bot havolasining o'zi shunday havola —
// Telegram uning uchun preview yasaganda bot AVATARINI ko'rsatadi. Shuning
// uchun "taklif rasmi" = bot avatari, uni @BotFather orqali almashtiriladi.
referralsHandler.callbackQuery("ref:photo", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.reply(
    `🖼 <b>Taklif rasmi</b>\n\n` +
      `Foydalanuvchi referal havolasini do'stlariga ulashganda, matn yonida ` +
      `<b>botning avatari</b> kichik rasm bo'lib ko'rinadi.\n\n` +
      `Rasmni almashtirish uchun:\n` +
      `1. @BotFather ga kiring\n` +
      `2. <code>/setuserpic</code> buyrug'ini yuboring\n` +
      `3. <b>@${ctx.me.username}</b> botini tanlang\n` +
      `4. Yangi rasmni yuboring\n\n` +
      `<i>Tavsiya: kvadrat rasm (masalan 640×640), yozuv yirik va o'qilarli bo'lsin — ` +
      `u kichik ko'rinadi.</i>`
  );
});

referralsHandler.callbackQuery("ref:reward:cancel", async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Bekor qilindi." });
  if (ctx.session.scratch) delete ctx.session.scratch.refRewardEdit;
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await ctx.reply("❌ Mukofot sozlash bekor qilindi.");
});

referralsHandler.callbackQuery("noop:ref", (ctx) => ctx.answerCallbackQuery());

referralsHandler.callbackQuery(/^ref:page:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await renderTop(ctx, Number(ctx.match[1]), true);
});

referralsHandler.callbackQuery("ref:close", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.deleteMessage().catch(() => {});
  await ctx.reply("Admin panel:", { reply_markup: adminMenuKeyboard(ctx.from.id) });
});

referralsHandler.callbackQuery(/^ref:view:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const refId = BigInt(ctx.match[1]);
  const u = await prisma.user.findUnique({ where: { id: refId } });
  const count = await prisma.user.count({
    where: { referredById: refId, referralConfirmed: true },
  });

  const name = u?.firstName || "—";
  const uname = u?.username ? `@${u.username}` : "—";

  await ctx
    .editMessageText(
      `<tg-emoji emoji-id="${BE.users}">👥</tg-emoji> <b>Referrer ma'lumoti</b>\n\n` +
        `Ism: <b>${e.escapeHtml(name)}</b>\n` +
        `Username: ${uname}\n` +
        `ID: <code>${refId}</code>\n` +
        `Referallar: <b>${count}</b> ta\n\n` +
        `<i>Bu foydalanuvchiga pul haqida xabar yuborishingiz mumkin.</i>`,
      {
        reply_markup: kb(
          [ibtn("✉️ Xabar yuborish", `ref:msg:${refId}`, "success", BE.broadcast)],
          [ibtn("Orqaga", "ref:page:0", undefined, BE.backMenu)]
        ),
      }
    )
    .catch(() => {});
});

referralsHandler.callbackQuery(/^ref:msg:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const refId = ctx.match[1];
  ctx.session.scratch = { ...(ctx.session.scratch ?? {}), refMsgTarget: refId };
  await ctx.reply(
    `✉️ Ushbu foydalanuvchiga yuboriladigan <b>xabarni</b> yozing (matn, rasm, video):`,
    { reply_markup: cancelKeyboard() }
  );
});

referralsHandler.on("message", async (ctx, next) => {
  if (!adminCan(ctx.from?.id ?? 0, "referrals")) return next();

  // ── Mukofot sozlamasi ──
  if (ctx.session.scratch?.refRewardEdit) {
    delete ctx.session.scratch.refRewardEdit;
    const parts = (ctx.message.text ?? "").trim().split(/\s+/);
    const count = parseInt(parts[0], 10);
    const days = parseInt(parts[1], 10);
    if (Number.isNaN(count) || Number.isNaN(days) || count < 0 || days < 0) {
      await ctx.reply("❌ Format: <code>referal kun</code>. Masalan: <code>5 7</code>");
      return;
    }
    await setSetting(KEYS.referralRewardCount, String(count));
    await setSetting(KEYS.referralRewardDays, String(days));
    await ctx.reply(
      count > 0 && days > 0
        ? `✅ Mukofot: har <b>${count}</b> ta referal = <b>${days} kun</b> premium.`
        : `✅ Referal mukofoti <b>o'chirildi</b>.`
    );
    return;
  }

  const target = ctx.session.scratch?.refMsgTarget as string | undefined;
  if (!target) return next();

  const text = ctx.message.text?.trim();
  if (text === "❌ Bekor qilish" || text === "/cancel") {
    if (ctx.session.scratch) delete ctx.session.scratch.refMsgTarget;
    await ctx.reply("❌ Bekor qilindi.");
    return;
  }

  if (ctx.session.scratch) delete ctx.session.scratch.refMsgTarget;
  try {
    await ctx.api.copyMessage(Number(target), ctx.chat.id, ctx.message.message_id);
    await ctx.reply("✅ Xabar yuborildi.");
  } catch {
    await ctx.reply("❌ Yuborilmadi (foydalanuvchi botni bloklagan bo'lishi mumkin).");
  }
});
