import { Composer, InlineKeyboard } from "grammy";
import { prisma } from "../prisma.js";
import { isAdmin } from "../config.js";
import { ce, e } from "../utils/emoji.js";
import { sendMovie, pickRandomMovie } from "../services/media.js";
import { checkContentAccess, countContentRequest } from "../utils/access.js";
import { confirmReferral } from "../utils/referral.js";
import { sendSerialSeasons } from "./serialView.js";
import { deliverByCode } from "./start.js";
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
  if (!(await checkAccess(ctx))) return;
  const movie = await pickRandomMovie(ctx);
  if (!movie) { await ctx.reply("📭 Hozircha kino yo'q."); return; }
  if (await sendMovie(ctx, movie)) await countContentRequest(ctx);
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
  if (page > 0) kb.text("◀️", `popular:page:${page - 1}`);
  kb.text("❌", "popular:close");
  if (page < pages - 1) kb.text("▶️", `popular:page:${page + 1}`);

  const text = `${ce("trendUp")} <b>Ko'p ko'rilgan kinolar</b>`;
  if (edit) {
    await ctx.editMessageText(text, { reply_markup: kb }).catch(async () => {
      await ctx.reply(text, { reply_markup: kb });
    });
  } else {
    await ctx.reply(text, { reply_markup: kb });
  }
}

searchHandler.callbackQuery("popular:close", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.deleteMessage().catch(() => {});
});

// ─── Asosiy matnli qidiruv ───────────────────────────────────────────────────
searchHandler.on("message:text", async (ctx, next) => {
  const text = ctx.message.text.trim();
  if (text.startsWith("/")) return next();
  if (PANEL_TEXTS.has(text)) return next();

  // Kod bo'yicha — obuna/limit so'ralib qolsa ham kodni eslab qolamiz, shunda
  // "Tekshirish" bosilgach yoki premium olingach kino/serial avtomatik yetkaziladi.
  if (/^\d+$/.test(text)) {
    const code = Number(text);
    ctx.session.scratch = { ...(ctx.session.scratch ?? {}), pendingCode: code };
    if (!(await checkAccess(ctx))) return;
    if (ctx.session.scratch) delete ctx.session.scratch.pendingCode;

    const delivered = await deliverByCode(ctx, code);
    if (delivered) { await countContentRequest(ctx); return; }

    await ctx.reply(
      `<tg-emoji emoji-id="5429571366384842791">🔎</tg-emoji> <b>${code}</b> kodli kino topilmadi.\n\n` +
      `Nom bilan ham qidirib ko'ring.`
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
  const [movies, serials] = await Promise.all([
    prisma.movie.findMany({
      where: { title: { contains: query, mode: "insensitive" } },
      take: SEARCH_FETCH_LIMIT, orderBy: { views: "desc" },
    }),
    prisma.serial.findMany({
      where: { title: { contains: query, mode: "insensitive" } },
      take: SEARCH_FETCH_LIMIT, orderBy: { views: "desc" },
    }),
  ]);

  if (movies.length === 0 && serials.length === 0) {
    // Natija topilmasa — inline qidiruv va popular knopkalari ko'rsatiladi
    const kb = new InlineKeyboard()
      .switchInlineCurrent(
        `🔎 Inline qidiruv: ${query}`,
        query
      ).row()
      .text("Ko'p ko'rilganlar", "popular:page:0");
    await ctx.reply(
      `<tg-emoji emoji-id="5429571366384842791">🔎</tg-emoji> "<b>${e.escapeHtml(query)}</b>" topilmadi.\n\nInline qidiruv yoki mashhur kinolarni sinab ko'ring:`,
      { reply_markup: kb }
    );
    return;
  }

  const items: SearchItem[] = [
    ...movies.map((m): SearchItem => ({ id: m.id, kind: "movie", code: m.code, title: m.title })),
    ...serials.map((s): SearchItem => ({ id: s.id, kind: "serial", code: s.code, title: s.title })),
  ];
  ctx.session.scratch = { ...(ctx.session.scratch ?? {}), searchResults: { query, items } as SearchState };
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
  if (page > 0) kb.text("◀️", `search:page:${page - 1}`);
  kb.text("❌", "search:close");
  if (page < pages - 1) kb.text("▶️", `search:page:${page + 1}`);

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

// Natijadan kino
// Gate shu yerda ham kerak: qidiruv natijasidagi ro'yxatdan ketma-ket bosib,
// bitta so'rov hisobiga cheksiz kino olish mumkin edi.
searchHandler.callbackQuery(/^movie:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  const movie = await prisma.movie.findUnique({ where: { id } });
  await ctx.answerCallbackQuery();
  if (!movie) { await ctx.reply("❌ Kino topilmadi."); return; }
  if (!(await checkAccess(ctx))) return;
  if (await sendMovie(ctx, movie)) await countContentRequest(ctx);
});

// Natijadan serial (sezonlar ro'yxati — video emas, shuning uchun hisoblanmaydi)
searchHandler.callbackQuery(/^serial:(\d+)$/, async (ctx) => {
  const id = Number(ctx.match[1]);
  await ctx.answerCallbackQuery();
  if (!(await checkAccess(ctx))) return;
  await sendSerialSeasons(ctx, id);
});
