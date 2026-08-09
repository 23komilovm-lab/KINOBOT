import { Composer, InlineKeyboard } from "grammy";
import { prisma } from "../prisma.js";
import { isAdmin } from "../config.js";
import { ce, e } from "../utils/emoji.js";
import { weightedRandomMovie } from "../services/recommend.js";
import { checkContentAccess } from "../utils/access.js";
import { confirmReferral } from "../utils/referral.js";
import { deliverByCode, deliverMovie, deliverSerialSeasons } from "../services/delivery.js";
import { searchContent } from "../services/search.js";
import { enterAiChat } from "./aiUser.js";
import { ADMIN_MENU_BUTTONS } from "../utils/keyboard.js";
import type { MyContext } from "../types.js";

export const searchHandler = new Composer<MyContext>();

const PANEL_TEXTS = new Set([
  ...Object.values(ADMIN_MENU_BUTTONS),
  "🔄 Yangilash",
  "AI yordamchi",
  "❌ Chiqish",
  "❌ Bekor qilish",
]);

/**
 * Kontent gate: premium/majburiy obuna/bepul limit. false — bloklangan.
 *
 * MUHIM: bu yerda so'rov HISOBLANMAYDI (`count = false`). Hisob faqat kino
 * haqiqatan yetkazilgandan keyin `countContentRequest()` bilan oshiriladi —
 * aks holda xato kod yozgan yoki premium kinoga urilgan foydalanuvchi bepul
 * so'rovini yo'qotib, hech narsa olmasdi.
 */
async function checkAccess(ctx: MyContext): Promise<boolean> {
  const ok = await checkContentAccess(ctx, false);
  if (!ok) return false;
  if (!isAdmin(ctx.from!.id)) await confirmReferral(ctx, ctx.from!.id);
  return true;
}

// ─── /mashhur — eng ko'p ko'rilgan kinolar ───────────────────────────────────
searchHandler.command("mashhur", async (ctx) => {
  if (!(await checkAccess(ctx))) return;
  await renderPopular(ctx, 0, false);
});

// ─── /random — tasodifiy kino ────────────────────────────────────────────────
searchHandler.command("random", async (ctx) => {
  // Views-og'irlikli tanlov — mashhur kinolar ko'proq, lekin kam ko'rilganlar
  // ham imkoniyatga ega (adolatli tasodifiylik, recommend.ts ichida).
  const movie = await weightedRandomMovie(ctx);
  if (!movie) {
    await ctx.reply("📭 Hozircha kino yo'q.");
    return;
  }
  await deliverMovie(ctx, movie);
});

// ─── Qidiruv knopkasi: ko'p ko'rilgan / inline ───────────────────────────────
// Doim tahrirlashga urinadi (edit=true) — agar tahrirlab bo'lmasa (masalan,
// welcome xabaridan birinchi marta kirilganda), renderPopular o'zi reply'ga tushadi.
searchHandler.callbackQuery(/^popular:page:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await renderPopular(ctx, Number(ctx.match[1]), true);
});

async function renderPopular(ctx: MyContext, page: number, edit: boolean) {
  const PAGE = 10;
  const total = await prisma.movie.count();
  // Bo'sh baza — bo'sh ro'yxat o'rniga aniq xabar (arandom'dagi kabi uslubda)
  if (total === 0) {
    const text = "📭 Hozircha kino yo'q.";
    if (edit) await ctx.editMessageText(text).catch(() => ctx.reply(text));
    else await ctx.reply(text);
    return;
  }
  const movies = await prisma.movie.findMany({
    orderBy: { views: "desc" },
    skip: page * PAGE,
    take: PAGE,
  });
  const kb = new InlineKeyboard();
  for (const m of movies) {
    kb.text(`${m.title} (${m.views})`, `movie:${m.id}`).row();
  }
  const pages = Math.ceil(total / PAGE);
  if (pages > 1) {
    if (page > 0) kb.text("◀️", `popular:page:${page - 1}`);
    kb.text(`${page + 1}/${pages}`, "noop:popular");
    if (page < pages - 1) kb.text("▶️", `popular:page:${page + 1}`);
  } else if (page > 0) {
    kb.text("◀️", `popular:page:${page - 1}`);
  }
  kb.text("❌", "popular:close");

  const text = `${ce("trendUp")} <b>Mashhur kinolar</b>`;
  if (edit) {
    await ctx.editMessageText(text, { reply_markup: kb }).catch(async () => {
      await ctx.reply(text, { reply_markup: kb });
    });
  } else {
    await ctx.reply(text, { reply_markup: kb });
  }
}

searchHandler.callbackQuery("noop:popular", (ctx) => ctx.answerCallbackQuery());

searchHandler.callbackQuery("popular:close", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.deleteMessage().catch(() => {});
});

// ─── Asosiy matnli qidiruv ───────────────────────────────────────────────────
searchHandler.on("message:text", async (ctx, next) => {
  const text = ctx.message.text.trim();
  if (text.startsWith("/")) return next();
  if (PANEL_TEXTS.has(text)) return next();

  // Kod bo'yicha — to'liq gate delivery.ts ichida ishlaydi. Obunaga bloklansa
  // pendingCode avtomatik saqlanadi ("Tekshirish" bosilgach qayta yetkaziladi).
  if (/^\d+$/.test(text)) {
    const code = Number(text);
    const res = await deliverByCode(ctx, code);
    if (res.delivered) return;
    if (!res.ok) return; // bloklovchi xabar ko'rsatilgan

    // Gate o'tdi. Topilib, lekin yetkazilmagan bo'lsa (premium taklifi ko'rsatilgan
    // / send xatosi) — bu yerda "topilmadi" deyish YOLG'ON bo'lardi. Faqat bazada
    // umuman bo'lmagan kodlar uchun "topilmadi" xabari chiqadi.
    if (res.found) return;

    ctx.session.scratch = {
      ...(ctx.session.scratch ?? {}),
      aiSeedQuery: `${code}-kodli kino yoki serial topilmadi, menga shunga o'xshash yoki mashhur kinolarni tavsiya qiling`,
    };
    const aiKb = new InlineKeyboard()
      .text("🤖 AI orqali qidirish", "search:ai")
      .row()
      .text("Mashhur kinolar", "popular:page:0");
    await ctx.reply(
      `${ce("search")} <b>${code}</b> kodli kino yoki serial topilmadi.\n\n` +
        `Nom bilan ham qidirib ko'ring yoki AI yordamchidan so'rang:`,
      { reply_markup: aiKb }
    );
    return;
  }

  // Juda qisqa so'rov — to'liq jadval skanini isrof qilmaymiz, gate'dan oldin qaytamiz
  if (text.length < MIN_QUERY_LEN) {
    await ctx.reply("🔎 Qidiruv uchun kamida 2 ta harf kiriting.");
    return;
  }

  if (!(await checkAccess(ctx))) return;
  await searchByName(ctx, text);
});

const MIN_QUERY_LEN = 2;
const SEARCH_PAGE = 10;
const SEARCH_FETCH_LIMIT = 50;

interface SearchItem {
  id: number;
  kind: "movie" | "serial";
  code: number;
  title: string;
}
interface SearchState {
  query: string;
  items: SearchItem[];
}

async function searchByName(ctx: MyContext, query: string) {
  const hits = await searchContent(query, SEARCH_FETCH_LIMIT);

  if (hits.length === 0) {
    // Natija topilmasa — AI yordamchiga yo'naltiramiz (inline qidiruv aynan shu
    // so'rovni qayta yuborib, kafolatlangan holda yana hech narsa topmasdi)
    ctx.session.scratch = { ...(ctx.session.scratch ?? {}), aiSeedQuery: query };
    const kb = new InlineKeyboard()
      .text("🤖 AI orqali qidirish", "search:ai")
      .row()
      .text("Mashhur kinolar", "popular:page:0");
    await ctx.reply(
      `${ce("search")} "<b>${e.escapeHtml(query)}</b>" topilmadi.\n\nAI yordamchidan so'rang yoki mashhur kinolarni sinab ko'ring:`,
      { reply_markup: kb }
    );
    return;
  }

  const items: SearchItem[] = hits.map((h): SearchItem => ({
    id: h.id,
    kind: h.kind,
    code: h.code,
    title: h.title,
  }));
  ctx.session.scratch = {
    ...(ctx.session.scratch ?? {}),
    searchResults: { query, items } as SearchState,
  };
  await renderSearchResults(ctx, 0, false);
}

async function renderSearchResults(ctx: MyContext, page: number, edit: boolean) {
  const state = ctx.session.scratch?.searchResults as SearchState | undefined;
  if (!state) {
    const text = "🔎 Qidiruv natijasi eskirgan. Iltimos, qaytadan qidiring.";
    if (edit) await ctx.editMessageText(text).catch(() => ctx.reply(text));
    else await ctx.reply(text);
    return;
  }

  const { items, query } = state;
  const pageItems = items.slice(page * SEARCH_PAGE, page * SEARCH_PAGE + SEARCH_PAGE);

  const kb = new InlineKeyboard();
  for (const it of pageItems) kb.text(`${it.title} (${it.code})`, `${it.kind}:${it.id}`).row();
  kb.switchInlineCurrent(`🔎 Inline: ${query}`, query).row();

  const pages = Math.ceil(items.length / SEARCH_PAGE);
  if (pages > 1) {
    if (page > 0) kb.text("◀️", `search:page:${page - 1}`);
    kb.text(`${page + 1}/${pages}`, "noop:search");
    if (page < pages - 1) kb.text("▶️", `search:page:${page + 1}`);
  } else if (page > 0) {
    kb.text("◀️", `search:page:${page - 1}`);
  }
  kb.text("❌", "search:close");

  const text = `${ce("list")} <b>Topildi (${items.length}):</b>`;
  if (edit) {
    await ctx.editMessageText(text, { reply_markup: kb }).catch(async () => {
      await ctx.reply(text, { reply_markup: kb });
    });
  } else {
    await ctx.reply(text, { reply_markup: kb });
  }
}

searchHandler.callbackQuery(/^search:page:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  await renderSearchResults(ctx, Number(ctx.match[1]), true);
});

searchHandler.callbackQuery("search:close", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.deleteMessage().catch(() => {});
});

searchHandler.callbackQuery("search:ai", async (ctx) => {
  await ctx.answerCallbackQuery();
  const seed = ctx.session.scratch?.aiSeedQuery as string | undefined;
  if (ctx.session.scratch) delete ctx.session.scratch.aiSeedQuery;
  await enterAiChat(ctx, seed);
});

// Natijadan kino — to'liq gate (obuna → bepul limit → premium) delivery.ts ichida.
// Ketma-ket bosib bitta so'rov hisobiga cheksiz kino olishga yo'l yo'q.
searchHandler.callbackQuery(/^movie:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  const movie = await prisma.movie.findUnique({ where: { id } });
  await ctx.answerCallbackQuery();
  if (!movie) {
    await ctx.reply("❌ Kino topilmadi.");
    return;
  }
  await deliverMovie(ctx, movie);
});

// Natijadan serial (sezonlar ro'yxati — video emas, hisoblanmaydi)
searchHandler.callbackQuery(/^serial:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  await ctx.answerCallbackQuery();
  await deliverSerialSeasons(ctx, id);
});
