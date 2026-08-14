import { prisma } from "../prisma.js";
import { takePendingAction, type PendingAction } from "../utils/pendingAction.js";
import { deliverByCode, deliverEpisode, deliverMovie } from "./delivery.js";
import { weightedRandomMovie } from "./recommend.js";
import { renderPopular, searchByName } from "../handlers/search.js";
import { renderList as renderRecommendList } from "../handlers/recommend.js";
import { enterAiChat } from "../handlers/aiUser.js";
import type { MyContext } from "../types.js";

/**
 * OBUNADAN KEYIN AVVALGI SO'ROVNI QAYTA BAJARISH.
 *
 * Ilgari darvoza faqat kino KODINI eslab qolardi: nom bilan qidirgan, AI ni
 * ochgan yoki tugma bosgan odam obuna bo'lgach hech narsa olmasdi va so'rovini
 * qaytadan yozishi kerak edi.
 *
 * Bu modul ATAYLAB `services/` da va handler'larni import qiladi — `start.ts`
 * dagi `sub:check` faqat shu yerni chaqiradi. Teskari yo'nalish yo'q
 * (handler'lar bu modulni import qilmaydi), shuning uchun halqa hosil bo'lmaydi.
 * Amalni SAQLASH esa sof `utils/pendingAction.ts` da — uni hamma import qila
 * oladi.
 */

/**
 * Kutib turgan amalni bajaradi. `true` — biror narsa bajarildi (chaqiruvchi
 * qo'shimcha "endi kod yuboring" xabarini yubormasligi kerak).
 *
 * Darvoza QAYTA ishlaydi: obuna o'rtasida bepul limit tugagan bo'lishi mumkin.
 * Bunday holda tegishli oqim o'z bloklovchi xabarini ko'rsatadi va kerak bo'lsa
 * amalni qayta saqlaydi.
 */
export async function resumePendingAction(ctx: MyContext): Promise<boolean> {
  const action = takePendingAction(ctx);
  if (!action) return false;

  switch (action.kind) {
    case "code": {
      const res = await deliverByCode(ctx, action.code);
      // `found:false` — kod bazadan o'chirilgan bo'lishi mumkin. Bu holda
      // "bajarildi" deb hisoblamaymiz: chaqiruvchi umumiy xabarni ko'rsatsin.
      return res.delivered || !res.ok || res.found;
    }

    case "search":
      await searchByName(ctx, action.query);
      return true;

    case "ai":
      // enterAiChat o'z ichida darvozani qayta tekshiradi va bloklansa
      // amalni o'zi qayta saqlaydi.
      await enterAiChat(ctx, action.seed);
      return true;

    case "popular":
      await renderPopular(ctx, 0, false);
      return true;

    case "recommend":
      await renderRecommendList(ctx, 0, false);
      return true;

    case "random": {
      // Yangi tasodifiy kino tanlanadi — foydalanuvchi aynan "tasodifiy"
      // so'ragan, aniq kino emas.
      const movie = await weightedRandomMovie(ctx);
      if (!movie) {
        await ctx.reply("📭 Hozircha kino yo'q.");
        return true;
      }
      await deliverMovie(ctx, movie);
      return true;
    }

    case "episode": {
      const ep = await prisma.episode.findUnique({
        where: { id: action.episodeId },
        include: { season: { include: { serial: true } } },
      });
      // Qism o'chirilgan bo'lishi mumkin — jimgina o'tkazib yuboramiz.
      if (!ep) return false;
      await deliverEpisode(ctx, ep);
      return true;
    }
  }
}

/** Test uchun: barcha `kind` qamrab olinganini kompilyator tekshiradi. */
export type ResumableKind = PendingAction["kind"];
