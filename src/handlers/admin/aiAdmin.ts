import { Composer } from "grammy";
import { prisma } from "../../prisma.js";
import { adminCan } from "../../config.js";
import { e } from "../../utils/emoji.js";
import { ibtn, kb, aiActiveKeyboard, adminMenuKeyboard } from "../../utils/keyboard.js";
import { aiEnabled, askAIChat, type ChatMsg } from "../../services/ai.js";
import { AI_CONTROLLABLE, findControllable, applyControllable, getSetting } from "../../utils/settings.js";
import { summarizeGender } from "../../utils/gender.js";
import { acquireBulkLock, bulkSend, formatBulkResult, releaseBulkLock } from "../../services/bulkSend.js";
import type { MyContext } from "../../types.js";

export const aiAdminHandler = new Composer<MyContext>();

/** broadcast.ts bilan bir xil qulf — bir vaqtda bitta ommaviy yuborish */
const BULK_KEY = "broadcast";

const AI_BTN  = "AI yordamchi";
const AI_EXIT = "❌ Chiqish";

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Jonli bot statistikasi — admin AI kontekstiga uzatiladi */
async function buildAdminStats(): Promise<string> {
  const today = startOfToday();
  const weekAgo = new Date(today); weekAgo.setDate(weekAgo.getDate() - 6);
  const [
    totalUsers, blockedUsers, todayUsers, weekUsers,
    totalMovies, todayMovies, moviesNoGenre,
    totalSerials,
    totalChannels, activeChannels, inactiveChannels,
    totalReferrals,
    premiumUsers, totalAdmins,
    allFirstNames, regionGroups,
    weekJoinUsers,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { isBlocked: true } }),
    prisma.user.count({ where: { createdAt: { gte: today } } }),
    prisma.user.count({ where: { createdAt: { gte: weekAgo } } }),
    prisma.movie.count(),
    prisma.movie.count({ where: { createdAt: { gte: today } } }),
    prisma.movie.findMany({ where: { genre: null }, select: { code: true, title: true }, take: 15 }),
    prisma.serial.count(),
    prisma.channel.count(),
    prisma.channel.count({ where: { isActive: true } }),
    prisma.channel.findMany({ where: { isActive: false }, select: { title: true }, take: 15 }),
    prisma.user.count({ where: { referralConfirmed: true } }),
    prisma.user.count({ where: { premiumUntil: { gt: new Date() } } }),
    prisma.user.count({ where: { isAdmin: true } }),
    prisma.user.findMany({ select: { firstName: true } }),
    prisma.user.groupBy({ by: ["region"], where: { region: { not: null } }, _count: { id: true }, orderBy: { _count: { id: "desc" } } }),
    prisma.user.findMany({ where: { createdAt: { gte: weekAgo } }, select: { createdAt: true } }),
  ]);

  const topRefRaw = await prisma.user.groupBy({
    by: ["referredById"],
    where: { referredById: { not: null }, referralConfirmed: true },
    _count: { id: true },
    orderBy: { _count: { id: "desc" } },
    take: 5,
  });
  const topReferrers: string[] = [];
  for (const g of topRefRaw) {
    const u = await prisma.user.findUnique({ where: { id: g.referredById! } });
    const name = u?.firstName || (u?.username ? `@${u.username}` : `ID ${g.referredById}`);
    topReferrers.push(`${name} — ${g._count.id} ta`);
  }

  const gender = summarizeGender(allFirstNames.map((u) => u.firstName));

  // Oxirgi 7 kun bo'yicha kunlik qo'shilishlar
  const dayCounts = new Map<string, number>();
  for (const u of weekJoinUsers) {
    const key = u.createdAt.toISOString().slice(0, 10);
    dayCounts.set(key, (dayCounts.get(key) ?? 0) + 1);
  }
  const weekTrend = [...dayCounts.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([day, count]) => `${day}: ${count} ta`).join(", ");

  const lines = [
    `Foydalanuvchilar: ${totalUsers} (bloklangan: ${blockedUsers}, bugun qo'shilgan: ${todayUsers}, oxirgi 7 kunda: ${weekUsers})`,
    `Jins bo'yicha (ISMGA QARAB TAXMINIY — Telegram aniq jins bermaydi): ayol ~${gender.female}, erkak ~${gender.male}, aniqlanmadi ${gender.unknown}`,
    `Premium foydalanuvchilar: ${premiumUsers}`,
    `Adminlar: ${totalAdmins}`,
    `Kinolar: ${totalMovies} (bugun qo'shilgan: ${todayMovies}, janrsiz: ${moviesNoGenre.length} ta)`,
    `Seriallar: ${totalSerials}`,
    `Kanallar: ${totalChannels} (faol: ${activeChannels}, nofaol: ${totalChannels - activeChannels})`,
    `Tasdiqlangan referallar: ${totalReferrals}`,
  ];
  if (regionGroups.length) {
    lines.push(`Hududlar bo'yicha:\n  - ${regionGroups.map((g) => `${g.region} — ${g._count.id} ta`).join("\n  - ")}`);
  }
  if (weekTrend) lines.push(`Oxirgi 7 kunlik qo'shilish tendensiyasi: ${weekTrend}`);
  if (topReferrers.length) lines.push(`Top referrerlar:\n  - ${topReferrers.join("\n  - ")}`);
  if (moviesNoGenre.length) lines.push(`Janrsiz kinolar: ${moviesNoGenre.map((m) => `${m.title} (m${m.code})`).join(", ")}`);
  if (inactiveChannels.length) lines.push(`Nofaol kanallar: ${inactiveChannels.map((c) => c.title).join(", ")}`);

  return lines.join("\n");
}

function buildAdminInfo(ctx: MyContext): string {
  const u = ctx.from!;
  const name = u.first_name?.trim() || "Admin";
  const username = u.username ? `@${u.username}` : "yo'q";
  return `Ism: ${name}\nUsername: ${username}\nTelegram ID: ${u.id}`;
}

function adminSystemPrompt(stats: string, userInfo: string): string {
  return (
    `Sen — "🎬 Kino vaqti" botining ADMIN uchun shaxsiy AI yordamchisisan. Bu yerda cheklovlar yo'q — ` +
    `admin bilan ochiq, erkin va samimiy suhbatlashasan: savollariga to'liq javob berasan, xato yoki ` +
    `kamchiliklarini topib tuzatib berasan, tavsiyalar berasan.\n\n` +

    `━━━ ADMIN ━━━\n${userInfo}\nUni ismi bilan chaqir.\n\n` +

    `━━━ TIL ━━━\n` +
    `Admin qaysi tilda va alifboda yozsa (o'zbek lotin/kirill, rus, ingliz va h.k.), sen ham aynan ` +
    `o'shanda javob ber.\n\n` +

    `━━━ USLUB ━━━\n` +
    `HTML teglar (<b>,<i>,<code>) va mos emojilar bilan chiroyli, tushunarli javob ber. Markdown ISHLATMA.\n\n` +

    `━━━ JONLI BOT STATISTIKASI ━━━\n${stats}\n` +
    `Admin statistika, foydalanuvchilar (jins, hudud, premium, qo'shilish tendensiyasi), ` +
    `kino/kanal boshqaruvi haqida so'rasa — shu ma'lumotlardan ANIQ foydalan, o'zingdan taxmin qilma. ` +
    `Jins ma'lumoti FAQAT ismga qarab dasturiy taxmin ekanini eslatib o't (Telegram bot API foydalanuvchi ` +
    `jinsini umuman bermaydi) — sonlarni "taxminan" so'zi bilan ber, 100% aniq deb ko'rsatma.\n\n` +

    `━━━ XABAR YUBORISH (BROADCAST) ━━━\n` +
    `Agar admin BARCHA foydalanuvchilarga xabar yubormoqchi bo'lsa (masalan: "foydalanuvchilarga yangi ` +
    `kino qo'shildi deb xabar yubor"), quyidagicha ishla:\n` +
    `1. Yubormoqchi bo'lgan XABAR MATNINI (foydalanuvchi ko'radigan, chiroyli, HTML formatlangan) tayyorla.\n` +
    `2. Javobing OXIRIGA aynan shu formatda qo'sh:\n[BROADCAST_START]\n<foydalanuvchilarga yuboriladigan aniq matn>\n[BROADCAST_END]\n` +
    `3. Bu blokdan OLDIN adminga qisqa izoh yozishing mumkin, lekin blok ICHIDA FAQAT foydalanuvchiga ` +
    `ko'rinadigan matn bo'lsin — hech qanday qo'shimcha izoh yoki tirnoq yozma.\n` +
    `4. XABARNI O'ZING YUBORMAYSAN — bot adminga tasdiqlash/fikr bildirish/bekor qilish tugmalarini ` +
    `ko'rsatadi, admin tasdiqlagandan keyingina yuboriladi.\n\n` +

    `━━━ SOZLAMALARNI O'ZGARTIRISH ━━━\n` +
    `Agar admin bot SOZLAMASINI o'zgartirishni so'rasa (masalan "majburiy obunani o'chir", ` +
    `"foydalanuvchi AI modelini cerebras qil"), javobing OXIRIGA quyidagicha qo'sh:\n` +
    `[SETTING:kalit=qiymat] (bir nechta bo'lsa har birini alohida qatorda).\n` +
    `FAQAT quyidagi ruxsat etilgan kalitlardan foydalan (boshqasini YOZMA):\n${settingsWhitelistText()}\n` +
    `bool kalitlar uchun qiymat: 1 (yoq) yoki 0 (o'chir). Model kalitlari uchun "provider:model" ` +
    `formatida (masalan cerebras:llama-3.3-70b). O'zgarishni O'ZING QO'LLAMAYSAN — bot adminga ` +
    `tasdiqlash tugmalarini ko'rsatadi, tasdiqdan keyin qo'llaydi. Blokdan oldin qisqa izoh yozishing mumkin.\n\n` +

    `Endi adminga eng yaxshi tarzda yordam ber!`
  );
}

function settingsWhitelistText(): string {
  return AI_CONTROLLABLE.map((s) => `- ${s.key} (${s.label}, ${s.type})`).join("\n");
}

/** [SETTING:key=value] bloklarini ajratib oladi va matndan olib tashlaydi */
function extractSettings(answer: string): { display: string; changes: { key: string; value: string }[] } {
  const changes: { key: string; value: string }[] = [];
  const re = /\[SETTING:\s*([a-z0-9_]+)\s*=\s*([^\]]*)\]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(answer)) !== null) {
    changes.push({ key: m[1].trim(), value: m[2].trim() });
  }
  const display = answer.replace(/\[SETTING:[^\]]*\]/gi, "").trim();
  return { display, changes };
}

// ─── Suhbat xotirasi (admin) — oxirgi 6 xabar ───────────────────────────────
const ADMIN_HISTORY_MAX = 6;
function getAdminHistory(ctx: MyContext): ChatMsg[] {
  const h = ctx.session.scratch?.aiAdminHistory;
  return Array.isArray(h) ? (h as ChatMsg[]) : [];
}
function pushAdminHistory(ctx: MyContext, userText: string, assistantText: string) {
  const h = getAdminHistory(ctx);
  h.push({ role: "user", content: userText });
  h.push({ role: "assistant", content: assistantText });
  ctx.session.scratch = { ...(ctx.session.scratch ?? {}), aiAdminHistory: h.slice(-ADMIN_HISTORY_MAX) };
}
function clearAdminHistory(ctx: MyContext) {
  if (ctx.session.scratch) delete ctx.session.scratch.aiAdminHistory;
}

async function askAdminAi(ctx: MyContext, prompt: string): Promise<string | null> {
  const stats = await buildAdminStats();
  return askAIChat("admin", {
    system: adminSystemPrompt(stats, buildAdminInfo(ctx)),
    history: getAdminHistory(ctx),
    userText: prompt,
  });
}

function extractBroadcast(answer: string): { display: string; draft: string | null } {
  const m = answer.match(/\[BROADCAST_START\]([\s\S]*?)\[BROADCAST_END\]/i);
  const display = answer.replace(/\[BROADCAST_START\][\s\S]*?\[BROADCAST_END\]/gi, "").trim();
  return { display, draft: m ? m[1].trim() : null };
}

async function showDraftPreview(ctx: MyContext, draft: string) {
  ctx.session.scratch = { ...(ctx.session.scratch ?? {}), aiAdminDraft: draft };
  await ctx.reply(
    `📢 <b>Xabar qoralamasi</b> (barcha foydalanuvchilarga):\n\n${draft}`,
    {
      reply_markup: kb(
        [ibtn("✅ Tasdiqlash va yuborish", "aiadm:send", "success")],
        [ibtn("✏️ Fikr bildirish", "aiadm:feedback", "primary")],
        [ibtn("❌ Bekor qilish", "aiadm:cancel", "danger")],
      ),
    }
  );
}

async function enterAdminAiChat(ctx: MyContext): Promise<void> {
  if (!adminCan(ctx.from!.id, "ai")) return;
  if (!aiEnabled()) {
    await ctx.reply("🤖 AI yordamchi hozircha sozlanmagan.");
    return;
  }
  ctx.session.scratch = { ...(ctx.session.scratch ?? {}), aiAdminChat: true };
  clearAdminHistory(ctx);
  await ctx.reply(
    `🤖 <b>Admin AI yordamchi</b> — cheklovsiz xizmatingizda! ✨\n\n` +
    `Men bilan erkin suhbatlashing:\n` +
    `📊 <i>"Nechta foydalanuvchimiz bor?"</i>\n` +
    `🎬 <i>"Qaysi kinolar janrsiz qolgan?"</i>\n` +
    `📢 <i>"Foydalanuvchilarga yangi serial qo'shildi deb xabar yubor"</i>\n` +
    `💬 yoki istalgan savol/muammoingizni yozing.\n\n` +
    `Chiqish uchun <b>${AI_EXIT}</b> tugmasini bosing.`,
    { reply_markup: aiActiveKeyboard() }
  );
}

aiAdminHandler.hears(AI_BTN, enterAdminAiChat);

// /ai komandasi — admin panelda alohida reply tugma yo'q, shu orqali kiriladi
aiAdminHandler.command("ai", enterAdminAiChat);

aiAdminHandler.hears(AI_EXIT, async (ctx) => {
  const wasActive = !!ctx.session.scratch?.aiAdminChat;
  if (ctx.session.scratch) {
    delete ctx.session.scratch.aiAdminChat;
    delete ctx.session.scratch.aiAdminDraft;
    delete ctx.session.scratch.aiAdminAwaitingFeedback;
  }
  clearAdminHistory(ctx);
  await ctx.reply(
    wasActive ? "AI yordamchidan chiqdingiz. 👋" : "Asosiy menyu:",
    { reply_markup: adminMenuKeyboard(ctx.from!.id) }
  );
});

aiAdminHandler.on("message:text", async (ctx, next) => {
  if (!ctx.session.scratch?.aiAdminChat) return next();

  const text = ctx.message.text.trim();
  if (text.startsWith("/")) { if (ctx.session.scratch) delete ctx.session.scratch.aiAdminChat; clearAdminHistory(ctx); return next(); }

  // Qoralamaga fikr bildirish rejimi
  if (ctx.session.scratch?.aiAdminAwaitingFeedback) {
    const prevDraft = ctx.session.scratch?.aiAdminDraft as string | undefined;
    if (ctx.session.scratch) delete ctx.session.scratch.aiAdminAwaitingFeedback;
    await ctx.replyWithChatAction("typing").catch(() => {});
    const answer = await askAdminAi(
      ctx,
      `Avvalgi xabar qoralamasi:\n"${prevDraft}"\n\nMening fikrim: "${text}"\n\n` +
      `Shu fikr asosida xabarni qayta tayyorla va [BROADCAST_START]/[BROADCAST_END] formatida ber.`
    );
    if (!answer) { await ctx.reply("🤖 Xatolik yuz berdi, qayta urinib ko'ring."); return; }
    const { display, draft } = extractBroadcast(answer);
    if (display) await ctx.reply(display);
    if (draft) await showDraftPreview(ctx, draft);
    return;
  }

  await ctx.replyWithChatAction("typing").catch(() => {});
  const answer = await askAdminAi(ctx, text);

  if (!answer) {
    await ctx.reply("🤖 Kechirasiz, hozir javob bera olmadim. Birozdan keyin urinib ko'ring.");
    return;
  }

  pushAdminHistory(ctx, text, answer);

  // Avval sozlama o'zgarishlarini ajratamiz, keyin broadcastni
  const { display: afterSettings, changes } = extractSettings(answer);
  const { display, draft } = extractBroadcast(afterSettings);
  if (display) {
    await ctx.reply(display).catch(async () => { await ctx.reply(e.escapeHtml(display)); });
  }
  if (draft) await showDraftPreview(ctx, draft);
  if (changes.length) await showSettingsPreview(ctx, changes);
});

/** AI taklif qilgan sozlama o'zgarishlarini tasdiqlash uchun ko'rsatadi */
async function showSettingsPreview(ctx: MyContext, changes: { key: string; value: string }[]) {
  const valid = changes.filter((c) => findControllable(c.key));
  if (valid.length === 0) return;

  const lines: string[] = ["⚙️ <b>Sozlama o'zgarishi taklifi</b>\n"];
  for (const c of valid) {
    const spec = findControllable(c.key)!;
    const cur = await getSetting(c.key, "—");
    lines.push(`• <b>${spec.label}</b>\n   <code>${cur || "—"}</code> → <code>${e.escapeHtml(c.value)}</code>`);
  }

  ctx.session.scratch = { ...(ctx.session.scratch ?? {}), aiAdminSettings: valid };
  await ctx.reply(lines.join("\n"), {
    reply_markup: kb(
      [ibtn("✅ Tasdiqlash va qo'llash", "aiadm:setapply", "success")],
      [ibtn("❌ Bekor qilish", "aiadm:setcancel", "danger")],
    ),
  });
}

aiAdminHandler.callbackQuery("aiadm:setapply", async (ctx) => {
  await ctx.answerCallbackQuery();
  const changes = ctx.session.scratch?.aiAdminSettings as { key: string; value: string }[] | undefined;
  if (!changes?.length) { await ctx.reply("❌ O'zgarish topilmadi."); return; }
  if (ctx.session.scratch) delete ctx.session.scratch.aiAdminSettings;

  let applied = 0;
  for (const c of changes) {
    if (await applyControllable(c.key, c.value)) applied++;
  }
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  await ctx.reply(`✅ <b>${applied}</b> ta sozlama qo'llandi.`);
});

aiAdminHandler.callbackQuery("aiadm:setcancel", async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Bekor qilindi." });
  if (ctx.session.scratch) delete ctx.session.scratch.aiAdminSettings;
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
});

aiAdminHandler.callbackQuery("aiadm:send", async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Yuborilmoqda..." });
  const draft = ctx.session.scratch?.aiAdminDraft as string | undefined;
  if (!draft) { await ctx.reply("❌ Qoralama topilmadi."); return; }
  if (ctx.session.scratch) delete ctx.session.scratch.aiAdminDraft;

  if (!acquireBulkLock(BULK_KEY)) {
    await ctx.reply("⏳ Hozir boshqa ommaviy yuborish davom etmoqda. Tugashini kuting.");
    return;
  }

  // AI qoralamasi HTML sifatida yuboriladi — buzuq teg bo'lsa HAR BIR yuborish
  // xato beradi. Avval o'zimizga sinov yuboramiz: xato bo'lsa hech kimga ketmaydi.
  const chatId = ctx.chat!.id;
  try {
    await ctx.api.sendMessage(chatId, draft, { parse_mode: "HTML" });
  } catch {
    releaseBulkLock(BULK_KEY);
    await ctx.reply(
      "❌ Xabar matnida xato bor (HTML teglari noto'g'ri) — hech kimga yuborilmadi.\n" +
      "Qoralamani qayta yozdiring."
    );
    return;
  }

  const users = await prisma.user.findMany({ where: { isBlocked: false }, select: { id: true } });
  const statusMsg = await ctx.reply(`⏳ Yuborilmoqda: 0 / ${users.length}...`);

  void (async () => {
    try {
      const result = await bulkSend({
        userIds: users.map((u) => u.id),
        send: (uid) => ctx.api.sendMessage(uid, draft, { parse_mode: "HTML" }),
        onProgress: async (r) => {
          if (r.processed < r.total) {
            await ctx.api.editMessageText(chatId, statusMsg.message_id, `⏳ ${r.processed} / ${r.total}...`).catch(() => {});
          }
        },
      });

      await prisma.broadcast.create({
        data: {
          targetType: "all",
          targetExtra: "ai",
          sentCount: result.sent,
          failCount: result.blocked + result.failed,
        },
      }).catch(() => null);

      await ctx.api.editMessageText(
        chatId, statusMsg.message_id,
        `✅ <b>Xabar yuborildi!</b>\n\n${formatBulkResult(result)}`
      ).catch(() => {});
    } catch (err) {
      console.error("🛑 AI broadcast xatosi:", err);
    } finally {
      releaseBulkLock(BULK_KEY);
    }
  })();
});

aiAdminHandler.callbackQuery("aiadm:feedback", async (ctx) => {
  await ctx.answerCallbackQuery();
  ctx.session.scratch = { ...(ctx.session.scratch ?? {}), aiAdminAwaitingFeedback: true };
  await ctx.reply("✏️ Xabarni qanday o'zgartirish kerak? Fikringizni yozing:");
});

aiAdminHandler.callbackQuery("aiadm:cancel", async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Bekor qilindi." });
  if (ctx.session.scratch) {
    delete ctx.session.scratch.aiAdminDraft;
    delete ctx.session.scratch.aiAdminAwaitingFeedback;
  }
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
});
