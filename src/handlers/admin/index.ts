import { Composer } from "grammy";
import { createConversation } from "@grammyjs/conversations";
import { adminCan, isAdmin, isOwner } from "../../config.js";
import type { MyContext } from "../../types.js";

import { statisticsHandler } from "./statistics.js";
import { channelsHandler } from "./channels.js";
import { moviesHandler, addMovie } from "./movies.js";
import { serialsHandler, addSerial, addEpisode } from "./serials.js";
import { broadcastHandler } from "./broadcast.js";
import { backupHandler } from "./backup.js";
import { adminsHandler } from "./admins.js";
import { joinStatsHandler } from "./joinStats.js";
import { funnelHandler } from "./funnel.js";
import { referralsHandler } from "./referrals.js";
import { aiAdminHandler } from "./aiAdmin.js";
import { aiSettingsHandler } from "./aiSettings.js";
import { premiumAdminHandler } from "./premium.js";
import { botSettingsHandler } from "./botSettings.js";

// Faqat adminlar uchun — bo'lim bo'yicha avtorizatsiya.
// Har bir composer o'z section ruxsati (adminCan) ortida mount qilinadi,
// shuning uchun cheklangan admin callback'larga (backup:restore, prm:approve,
// bc:*, ch:*) faqat menyu kirishida emas — har bir so'rovda rad etiladi.
export const adminHandler = new Composer<MyContext>();

/** Berilgan section ruxsatiga ega adminlar uchun filter. */
function section(sectionName: string): Composer<MyContext> {
  return new Composer<MyContext>().filter(
    (ctx) => isAdmin(ctx.from?.id) && adminCan(ctx.from!.id, sectionName)
  );
}

/** Faqat owner (ADMIN_IDS) — boshqa adminlar kira olmaydi. */
function ownerOnly(): Composer<MyContext> {
  return new Composer<MyContext>().filter((ctx) => isOwner(ctx.from?.id));
}

// Conversation'lar — kirish nuqtasi movies/serials bo'limlarida, shuning
// uchun ular ham shu section'lar filteri ortida ro'yxatdan o'tkaziladi.
section("movies").use(createConversation(addMovie, "addMovie"));
section("serials").use(createConversation(addSerial, "addSerial"));
section("serials").use(createConversation(addEpisode, "addEpisode"));

// Bo'limlar
section("stats").use(statisticsHandler);
section("channels").use(channelsHandler);
section("channels").use(joinStatsHandler);
section("movies").use(moviesHandler);
section("serials").use(serialsHandler);
section("broadcast").use(broadcastHandler);
section("backup").use(backupHandler);
section("funnel").use(funnelHandler);
section("referrals").use(referralsHandler);
section("ai").use(aiAdminHandler);
section("ai").use(aiSettingsHandler);
section("premium").use(premiumAdminHandler);

// Owner-only bo'limlar
ownerOnly().use(adminsHandler);

// "Bot sozlamalari" — owner YOKI backup/premium/ai bo'limlaridan biriga ruxsati
// bor adminlar. keyboard.ts undagi adminlarga tugmani ko'rsatadi va
// botSettings.ts ning o'z guard'i ham ularni qabul qiladi — mount shunga mos
// bo'lmasa, cheklangan adminlar tugmani ko'rib, bosganda hech narsa bo'lmasdi.
function botSettingsScope(): Composer<MyContext> {
  return new Composer<MyContext>().filter(
    (ctx) =>
      isAdmin(ctx.from?.id) &&
      (isOwner(ctx.from!.id) ||
        adminCan(ctx.from!.id, "premium") ||
        adminCan(ctx.from!.id, "ai") ||
        adminCan(ctx.from!.id, "backup") ||
        adminCan(ctx.from!.id, "funnel"))
  );
}
botSettingsScope().use(botSettingsHandler);
