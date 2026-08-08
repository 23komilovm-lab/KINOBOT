import { Composer, InlineKeyboard } from "grammy";
import { ce } from "../utils/emoji.js";
import { recommendMovies, RECOMMEND_CALLBACK } from "../services/recommend.js";
import { checkContentAccess } from "../utils/access.js";
import type { MyContext } from "../types.js";

/**
 * TAVSIYA INTERFEYSI (2.4)
 *
 * Kino yetkazilgach video ostidagi "🎯 Sizga yoqishi mumkin" tugmasi → `rec:open`.
 * Shuningdek `/recommend` buyrug'i bilan ham ochiladi. Ro'yxat sahifalanadi
 * (`rec:page:<n>`), har bir satr kino tugmasi (`movie:ID` — search.ts yetkazadi).
 *
 * Gate: ro'yxatni ochishda `checkContentAccess(count=false)` — hisoblanmaydi
 * (ro'yxat kontent emas). Haqiqiy kino tanlanganda `deliverMovie` to'liq gate
 * + hisob ishlatadi.
 */
export const recommendHandler = new Composer<MyContext>();

const LIST_PAGE = 8; // har sahifada nechta kino
const LIST_FETCH = 30; // hovuz hajmi (pagination shu ichida)

async function renderList(ctx: MyContext, page: number, edit: boolean) {
  const movies = await recommendMovies(ctx, LIST_FETCH);
  if (movies.length === 0) {
    const empty =
      "📭 Hozircha tavsiya berish uchun ma'lumot yetarli emas. Bir nechta kino ko'ring — keyin shu yerda shaxsiy tavsiyalar paydo bo'ladi.";
    if (edit) await ctx.editMessageText(empty).catch(() => ctx.reply(empty));
    else await ctx.reply(empty);
    return;
  }

  const pages = Math.ceil(movies.length / LIST_PAGE);
  const p = Math.min(Math.max(page, 0), pages - 1); // clamp — chetga chiqib ketmasin
  const slice = movies.slice(p * LIST_PAGE, p * LIST_PAGE + LIST_PAGE);

  const kb = new InlineKeyboard();
  for (const m of slice) {
    kb.text(`${m.title} (${m.code})`, `movie:${m.id}`).row();
  }
  if (p > 0) kb.text("◀️", `rec:page:${p - 1}`);
  kb.text("❌", "rec:close");
  if (p < pages - 1) kb.text("▶️", `rec:page:${p + 1}`);

  const text = `${ce("star")} <b>Sizga yoqishi mumkin</b> — ko'rgan janrlaringiz bo'yicha:`;
  if (edit) {
    await ctx.editMessageText(text, { reply_markup: kb }).catch(async () => {
      await ctx.reply(text, { reply_markup: kb });
    });
  } else {
    await ctx.reply(text, { reply_markup: kb });
  }
}

// /recommend — to'liq gate (count yo'q)
recommendHandler.command("recommend", async (ctx) => {
  if (!(await checkContentAccess(ctx, false))) return;
  await renderList(ctx, 0, false);
});

// Video ostidagi "🎯 Sizga yoqishi mumkin" — yangi xabar (videoni tahrirlab bo'lmaydi)
recommendHandler.callbackQuery(RECOMMEND_CALLBACK, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await checkContentAccess(ctx, false))) return;
  await renderList(ctx, 0, false);
});

recommendHandler.callbackQuery(/^rec:page:(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!(await checkContentAccess(ctx, false))) return;
  await renderList(ctx, Number(ctx.match[1]), true);
});

recommendHandler.callbackQuery("rec:close", async (ctx) => {
  await ctx.answerCallbackQuery();
  await ctx.deleteMessage().catch(() => {});
});
